# LinkDrop

A tiny Android app that makes sharing a URL to your own webhook fast.

Share a link from any app → tap **LinkDrop** → the URL is written to a durable
on-device queue and posted to your receiver. If the phone is offline or the
receiver is down, the queue waits and retries. The app itself holds no webhook
list; the receiver owns per-user routing and fan-out.

- Android 10+ (`minSdk 29`), built against Android 14 (`targetSdk 34`)
- Kotlin, plain XML views, no Compose
- Room-free SQLite queue + WorkManager retries
- One receiver URL, with a compiled-in default and an optional in-app override
- No Play Store required

---

## Quick start

### 1. Build the APK (Docker only)

You do **not** need Java, Gradle, or the Android SDK on your host. Docker
provides the whole toolchain.

```sh
git clone <this-repo> linkdrop
cd linkdrop
./scripts/build.sh
```

The APK is written to:

```
dist/linkdrop.apk
```

The default receiver URL is:

```
https://linkdrop.fi.gy/hooks/linkdrop
```

Build with a different default URL:

```sh
LINKDROP_URL=https://linkdrop.example.com/hooks/linkdrop ./scripts/build.sh
```

The first build generates a signing keystore in `keystore/` and
`keystore.properties`. **Back both up.** Android will only install an update
signed with the same key.

### 2. Install on the phone or tablet

#### Option A — USB (recommended)

1. On the device: **Settings → About phone → tap Build number 7 times**.
2. **Settings → System → Developer options → USB debugging**.
3. Connect USB, accept the debugging prompt on the device.
4. On the computer:

```sh
adb devices
./scripts/install.sh
# or: adb install -r dist/linkdrop.apk
```

#### Option B — no computer

1. Copy `dist/linkdrop.apk` to the device (cloud drive, email, USB storage,
   `scp`, or a local file share).
2. On the device, open **Files/Downloads** and tap the APK.
3. If prompted, allow **Install unknown apps** for the app you are using to
   open the APK (Files, Chrome, Drive, etc.).
   - Android 8–10: **Settings → Apps → Special app access → Install unknown apps**.
   - Android 11+: the prompt usually links straight to the right setting.
4. If Android says **Restricted setting** (Android 13+), open
   **Settings → Apps → [Files/Chrome] → ⋮ → Allow restricted settings**, then
   try again.
5. Install and open **LinkDrop**.

#### Option B2 — download from a local HTTP server

If the phone and computer are on the same Wi-Fi, serve the APK directly from
the build directory:

```sh
# Run this in the repo root, on the computer that has dist/linkdrop.apk.
python3 -m http.server -d dist/ 9876
```

Find the computer's LAN address (`hostname -I` on Linux, `ipconfig getifaddr
en0` on macOS, or look at the network settings), then open this on the phone:

```
http://<computer-ip>:9876/linkdrop.apk
```

Download the file and open it from the phone's Downloads/Files app. Allow
**Install unknown apps** for the browser or file manager if prompted (and
**Allow restricted settings** on Android 13+). Stop the server with `Ctrl+C`
when done.

The Python server has no authentication and exposes `dist/` to every device
that can reach port 9876. Only run it on a trusted network, and stop it after
the install.

#### Option C — wireless debugging (Android 11+)

On the device: **Developer options → Wireless debugging → Pair device with
pairing code**. Then:

```sh
adb pair <device-ip>:<pair-port> <pairing-code>
adb connect <device-ip>:<debug-port>
adb install -r dist/linkdrop.apk
```

### 3. Configure

Open **LinkDrop** once:

1. The **Receiver URL** is prefilled with the compiled-in default.
2. Paste the receiver's HMAC secret into **Webhook token**. This is the same
   value as `LINKDROP_TOKEN` in the receiver's environment. The app signs each
   request and sends the lowercase hex HMAC-SHA256 digest in
   `X-Webhook-Token`; the bundled `swamp serve` webhook requires it.
3. Tap **Save**.
4. Tap **Test** to send a test share and see the receiver's HTTP status.

The test sends `"source":"linkdrop-test"` so the receiver can ignore it if
desired.

### 4. Share a URL

In Chrome, Firefox, or any app: **Share → LinkDrop**. You should see a short
**Queued** toast. The app finishes immediately; the queue delivers in the
background.

- If you share while offline, the URL stays queued.
- When connectivity returns, queued URLs are sent oldest-first.
- A failed URL does not block the others.
- The **Test** button and queue counts are on the LinkDrop app screen.

---

## Receiver contract

The app sends one JSON POST per shared URL:

```http
POST /hooks/linkdrop HTTP/1.1
Host: linkdrop.fi.gy
Content-Type: application/json
User-Agent: LinkDrop/1.0 (Android)
X-Webhook-Token: <hex HMAC-SHA256 of body>
X-LinkDrop-Principal: <stable per-app/profile id>
Idempotency-Key: <share UUID>

{
  "id": "<share UUID>",
  "url": "https://example.com/article",
  "title": "Article title",
  "text": "Article title https://example.com/article",
  "principal": "<stable per-app/profile id>",
  "source": "android-share",
  "device": "Pixel 8",
  "sharedAt": "2026-10-27T09:00:00Z"
}
```

`X-Webhook-Token` is not a static bearer token. It is the lowercase hex
HMAC-SHA256 of the exact request body, keyed by the token saved in the app. The
bundled `swamp serve` `generic` scheme verifies this signature.

To test a receiver by hand:

```sh
BODY='{"id":"manual-1","url":"https://example.com/manual","principal":"test"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINKDROP_TOKEN" -r | cut -d' ' -f1)
curl -X POST "https://linkdrop.fi.gy/hooks/linkdrop" \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Token: $SIG" \
  -H 'X-LinkDrop-Principal: test' \
  -d "$BODY"
```

- Any `2xx` marks the share as sent.
- `4xx` (except `408` and `429`) marks it failed and stops retrying.
- `5xx`, `408`, `429`, DNS, TLS, and connection errors retry with exponential
  backoff.
- `Idempotency-Key` is the share UUID, so the receiver can dedupe retries.

A minimal swamp receiver lives in [`swamp/`](swamp/): the
`@svendowideit/linkdrop` behavior, `@svendowideit/linkdrop-setup` (Caddy
DNS/TLS), `@svendowideit/capture-linkdrop` (webhook → SQLite), and `serve.yaml`.

```sh
cd swamp
export LINKDROP_TOKEN="$(openssl rand -hex 32)"
swamp serve --config serve.yaml
```

Put `https://linkdrop.<zone>/hooks/linkdrop` in the app. See
[`swamp/README.md`](swamp/README.md) for the Caddy setup and SQLite inspection
commands.

---

## How it works

```
ShareActivity (transparent)
  └─ extract first http(s) URL
       └─ insert a row into the SQLite queue
            └─ enqueue a WorkManager job
                 └─ POST to the receiver URL
                      └─ 2xx → sent
                      └─ failure → backoff + retry
```

- **Queue:** every share is one row in `linkdrop.db`; the queue can hold many
  URLs. The app drains it when a network is available.
- **Retries:** WorkManager with exponential backoff; up to 30 attempts before a
  share is marked failed. **Retry all** re-queues failed shares.
- **Force-stop:** Android cancels WorkManager jobs for a force-stopped app. Open
  the app again to resume; pending shares are re-enqueued.
- **No notifications:** the app shows a toast only. WorkManager runs in the
  background without a persistent service.
- **Direct Share:** the app publishes a long-lived shortcut, so some devices put
  it in the top row of the share sheet. Placement is OEM-dependent; the normal
  share-sheet entry always works.

---

## Security

- The app only sends over HTTPS. Cleartext traffic is disabled.
- The HMAC secret is stored in app-private storage, encrypted with an Android
  Keystore key. `android:allowBackup="false"`.
- The receiver URL and token are not sent anywhere except the configured
  receiver.
- This is a personal sideloaded app, not a multi-tenant product. Use a
  tailnet-only receiver or a low-value token; a token baked into or stored by an
  installed APK can be extracted by someone with control of the device.

---

## Development

```sh
./scripts/test.sh    # Docker + Gradle unit tests
./scripts/build.sh   # Docker + signed release APK
```

Layout:

```
app/src/main/java/com/sven/linkdrop/
  ShareActivity.kt       transparent ACTION_SEND target
  SettingsActivity.kt    receiver URL/token, test, queue counts
  LinkExtractor.kt       first-URL extraction (unit tested)
  QueueDb.kt             SQLite queue
  DeliveryWorker.kt      WorkManager delivery + retries
  Http.kt                minimal HttpURLConnection POST
  Prefs.kt               URL/token/principal storage
  Crypto.kt              Keystore-backed token encryption
  ShortcutPublisher.kt   best-effort Direct Share shortcut
app/src/main/res/        layouts, strings, theme, icon
scripts/                 Docker build, keystore, install, test
Dockerfile               Android SDK + Gradle image
```

---

## Troubleshooting

**"App not installed" / signature mismatch**
You built with a different keystore than the installed copy. Uninstall the old
app (this loses the queue) and install the new APK, or restore the original
`keystore/` and rebuild.

**"Install unknown apps" blocked**
Allow the app you use to open the APK (Files, Chrome, Drive) under
**Settings → Apps → Special app access → Install unknown apps**. On Android 13+,
also check **Allow restricted settings** in the app's info page.

**Shares stay queued**
Open LinkDrop → **Test**. Check the receiver URL, token, DNS, and TLS. Also check
that the receiver responds with `2xx`. On aggressive OEM battery managers, allow
LinkDrop to run in the background.

**Updates**
Bump `versionCode` in `app/build.gradle.kts`, use the same keystore, and install
with `adb install -r` or tap the new APK. Keep `keystore/linkdrop.jks` and
`keystore.properties` backed up. If Android reports a signature mismatch, the
installed copy was signed with a different key; uninstall it (losing the queue)
or restore the original keystore and rebuild.

**Where are the logs?**

```sh
adb logcat | grep -i linkdrop
```

---

## License

MIT. See [LICENSE](LICENSE).
