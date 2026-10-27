# LinkDrop swamp receiver

The receiver side of LinkDrop: a swamp behavior that stores shared URLs in
SQLite, plus the workflows that expose and handle the webhook.

- Behavior: `@svendowideit/linkdrop`
  (`extensions/behaviors/linkdrop/`)
- Webhook workflow: `capture-linkdrop` (`workflows/workflow-capture-linkdrop.yaml`)
- DNS/TLS workflow: `linkdrop-setup` (`workflows/workflow-linkdrop-setup.yaml`)
- Serve config: `serve.yaml`

## Prerequisites

- A configured `@svendowideit/caddy` model (default name `caddy`) with a
  `baseDomain` and DNS provider, so `linkdrop.<zone>` can get an A record and a
  certificate.
- `swamp serve` running from this repo, with `LINKDROP_TOKEN` in its environment.
- The Android app's **Receiver URL** set to
  `https://linkdrop.<zone>/hooks/linkdrop` and its **Webhook token** set to the
  same `LINKDROP_TOKEN`.

## Create the DNS/TLS route

```sh
# Replace linkdrop.fi.gy with your zone. The name must be under baseDomain.
swamp workflow run linkdrop-setup --input dnsName=linkdrop.fi.gy
```

The workflow calls Caddy `ensureDnsProxy` (route + TLS subject + desired A
record), `applyDnsRecords`, then `checkHealth`. DNS propagation and ACME
issuance are asynchronous; verify the live endpoint after they settle.

### Validation vs a live run

`swamp workflow validate linkdrop-setup` only checks the workflow schema and the
step inputs against the installed `@svendowideit/caddy` type. It does not call
Caddy, write DNS, or issue a certificate.

This repo is a fresh swamp repository and does not create a Caddy model. A live
run needs a configured `@svendowideit/caddy` model that owns the target zone
(`baseDomain`, DNS provider, ACME email, etc.):

```sh
swamp workflow run linkdrop-setup \
  --input dnsName=linkdrop.fi.gy \
  --input caddyModel=my-caddy
```

If Caddy does not reach swamp serve on `127.0.0.1:9090`, also pass
`--input upstream=10.0.0.5:9090`. Both `ensureDnsProxy` and `applyDnsRecords`
make real changes to Caddy and DNS, so run them against the intended model/host.

## Run the receiver

```sh
export LINKDROP_TOKEN="$(openssl rand -hex 32)"
swamp serve --config serve.yaml
```

The webhook is `POST /hooks/linkdrop`. The `generic` scheme verifies
HMAC-SHA256 over the exact request body, with the digest hex in
`X-Webhook-Token`:

```sh
BODY='{"id":"manual-1","url":"https://example.com/manual","principal":"test"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LINKDROP_TOKEN" -r | cut -d' ' -f1)
curl -X POST http://127.0.0.1:9090/hooks/linkdrop \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Token: $SIG" \
  -H 'X-LinkDrop-Principal: test' \
  -d "$BODY"
```

A verified request runs `capture-linkdrop`, which calls
`@svendowideit/linkdrop store` and inserts one row into SQLite. The insert is
idempotent by the app's share UUID.

## Inspect the inbox

The default database is `$SWAMP_HOME/linkdrop/links.db` (usually
`~/.swamp/linkdrop/links.db`):

```sh
swamp model @svendowideit/linkdrop method run list linkdrop --input limit=20
swamp model @svendowideit/linkdrop method run stats linkdrop
```

Or query it directly:

```sh
sqlite3 ~/.swamp/linkdrop/links.db \
  'select received_at, principal, url from links order by received_at desc limit 20;'
```

## Verify

```sh
~/.swamp/deno/deno test -A extensions/behaviors/linkdrop/linkdrop_test.ts
swamp workflow validate linkdrop-setup
swamp workflow validate capture-linkdrop
```
