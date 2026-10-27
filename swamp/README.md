# LinkDrop swamp receiver

The receiver side of LinkDrop: a swamp behavior that stores shared URLs in
SQLite, plus the workflows that expose and handle the webhook.

- Behavior: `@svendowideit/linkdrop`
  (`extensions/models/linkdrop/`)
- Webhook workflow: `@svendowideit/capture-linkdrop` (`workflows/workflow-capture-linkdrop.yaml`)
- DNS/TLS workflow: `@svendowideit/linkdrop-setup` (`workflows/workflow-linkdrop-setup.yaml`)
- Serve config: `serve.yaml`

## Prerequisites

- A configured `@svendowideit/caddy` model (default name `caddy`) with a
  `baseDomain` and DNS provider, so `linkdrop.<zone>` can get an A record and a
  certificate.
- `swamp serve` running from this repo. The webhook uses the bundled no-auth
  handler, so there is no token or secret to set.
- The Android app's **Receiver URL** set to
  `https://linkdrop.<zone>/hooks/linkdrop`.

## Configure the receiver and route

```sh
# Replace linkdrop.fi.gy with your zone. The name must be under baseDomain.
swamp workflow run @svendowideit/linkdrop-setup --input dnsName=linkdrop.fi.gy
```

The workflow first merges `/hooks/linkdrop` into the existing serve config,
restarts the existing systemd `swamp-serve` unit, and verifies the running
server reports the route. It then calls Caddy `ensureDnsProxy` (route + TLS
subject + desired A record), `applyDnsRecords`, and `checkHealth`. DNS
propagation and ACME issuance are asynchronous; verify the live endpoint after
they settle.

### Validation vs a live run

`swamp workflow validate @svendowideit/linkdrop-setup` only checks the workflow
schema and step inputs against the installed types. It does not edit serve
config, restart serve, write DNS, or issue a certificate.

This repo is a fresh swamp repository and does not create a Caddy model or a
serve model. A live run needs a configured `@svendowideit/caddy` model that owns
the target zone (`baseDomain`, DNS provider, ACME email, etc.) and a running
systemd `swamp serve` whose repo/config you pass:

```sh
swamp workflow run @svendowideit/linkdrop-setup \
  --input dnsName=linkdrop.fi.gy \
  --input caddyModel=my-caddy \
  --input serveRepo=/srv/swamp-repo \
  --input serveService=swamp-serve
```

If Caddy does not reach swamp serve on `127.0.0.1:9090`, also pass
`--input upstream=10.0.0.5:9090`. Both `ensureDnsProxy` and `applyDnsRecords`
make real changes to Caddy and DNS, so run them against the intended model/host.

## Run the receiver

`linkdrop-setup` registers `/hooks/linkdrop` in the existing serve config,
restarts the existing systemd service, verifies the route, and then configures
Caddy. It does **not** create a second serve.

The serve process must already be running from the repo/config you pass
(`serveRepo`, default `.`, and `serveConfig`, default `.swamp/serve.yaml`), and
the service name must be correct (`serveService`, default `swamp-serve`).

If you run the receiver manually for development instead of the systemd
service, use `swamp serve --config serve.yaml`.

The webhook is `POST /hooks/linkdrop` and is unauthenticated:

```sh
BODY='{"id":"manual-1","url":"https://example.com/manual","principal":"test"}'
curl -X POST http://127.0.0.1:9090/hooks/linkdrop \
  -H 'Content-Type: application/json' \
  -H 'X-LinkDrop-Principal: test' \
  -d "$BODY"
```

A verified request runs `@svendowideit/capture-linkdrop`, which calls
`@svendowideit/linkdrop store` and inserts one row into SQLite. The insert is
idempotent by the app's share UUID.

## Troubleshooting a 404

Caddy adds `via: 1.1 Caddy` to proxied responses. A `404` with a plain body
`Not found` means the Caddy route is working, but the running `swamp serve` does
not have `/hooks/linkdrop` registered. `@svendowideit/linkdrop-setup` now
registers it and restarts the service; check the run output and then:

```sh
curl -sS http://127.0.0.1:9090/ | jq '{webhooks}'
```

If the route is missing, confirm the workflow used the right `serveRepo`,
`serveConfig`, and `serveService`. A `502` means nothing is listening on the
upstream. A `401` means the route is not using the open handler.

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
~/.swamp/deno/deno test -A extensions/models/linkdrop/linkdrop_test.ts
swamp workflow validate @svendowideit/linkdrop-setup
swamp workflow validate @svendowideit/capture-linkdrop
```

## Publish

The adversarial review report for the current extension content is stored in
`.reviews/`. Push with the repository-bound review directory:

```sh
./scripts/push-linkdrop.sh
./scripts/push-linkdrop.sh --dry-run   # check without publishing
```

The extension version is `2026.10.27.6`; it bundles
`@svendowideit/linkdrop-setup` and `@svendowideit/capture-linkdrop` and depends
on `@svendowideit/caddy` and `@svendowideit/systemd-service`. After pushing, consumers run:

```sh
swamp extension update @svendowideit/linkdrop
swamp workflow run @svendowideit/linkdrop-setup --input dnsName=linkdrop.fi.gy
```
