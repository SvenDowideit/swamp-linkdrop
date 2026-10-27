# @svendowideit/linkdrop

Durable SQLite inbox for URLs shared by the LinkDrop Android app.

## What it does

The Android app posts one JSON object per shared URL to a `swamp serve`
webhook. This behavior is the receiver behind that webhook: it validates the
mapped fields, inserts the row into SQLite, and writes a swamp `link` resource.
The insert is idempotent by the app's share UUID + URL, so a retry after a lost
HTTP response does not duplicate a row, while distinct URLs never collapse. The bundled `@svendowideit/linkdrop-setup`
workflow registers the route in the existing serve config, restarts and
verifies the running serve, then creates the Caddy DNS record and TLS route for
`linkdrop.<zone>`. The bundled `@svendowideit/capture-linkdrop` workflow is the
webhook handler.

Side effects: creates/opens the configured SQLite file, creates its parent
directory and the `links` table, and writes a `link`/`links`/`stats` swamp
resource. The setup workflow merges `/hooks/linkdrop` into the existing serve
config, restarts the existing systemd serve, verifies it, and then creates a
Caddy route and DNS/TLS entry. It installs no services, cron triggers, or
daemons.

## Install

```sh
swamp extension pull @svendowideit/linkdrop
```

One pull installs the behavior and both bundled workflows:
`@svendowideit/linkdrop-setup` (webhook registration + Caddy DNS/TLS) and
`@svendowideit/capture-linkdrop` (webhook handler). `@svendowideit/caddy` and
`@svendowideit/systemd-service` are pulled automatically as dependencies. That
installs the types; you still need a configured Caddy model, and can point the
setup workflow at it with `--input caddyModel=my-caddy` (default `caddy`).

For local development in this repository, the behavior is loaded directly from
`extensions/models/linkdrop`; no pull is needed. The webhook route itself lives
in `swamp serve`'s config.

## Configuration

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `dbPath` | string | `""` | SQLite file path. Empty resolves to `$SWAMP_HOME/linkdrop/links.db`, falling back to `~/.swamp/linkdrop/links.db`. |
| `swampBinPath` | string | `swamp` | The swamp binary `configureServe` uses for `swamp serve check-config`. Set an absolute path if swamp is not on `PATH`. |

Set it when creating the model, or edit the existing definition:

```sh
# Keep the inbox beside the rest of the swamp data.
swamp model create @svendowideit/linkdrop linkdrop \
  --global-arg dbPath=~/.swamp/linkdrop/links.db
```

## Examples

```sh
# Store one share manually. Useful for testing the behavior without a phone.
swamp model @svendowideit/linkdrop method run store linkdrop \
  --input url="https://example.com/article" \
  --input title="Example" \
  --input principal="test-principal"

# List the latest rows, newest first.
swamp model @svendowideit/linkdrop method run list linkdrop --input limit=20

# Check how many rows are stored and where the database lives.
swamp model @svendowideit/linkdrop method run stats linkdrop

# Point linkdrop.<zone> at the existing swamp serve webhook through Caddy.
# `ensureDnsProxy` adds the route, TLS subject, and A record; applyDnsRecords
# writes the record. ACME issuance and DNS propagation happen after the run.
# Default caddyModel is `caddy`; override if your model has another name.
swamp workflow run @svendowideit/linkdrop-setup \
  --input dnsName=linkdrop.example.com \
  --input caddyModel=my-caddy \
  --input serveRepo=/srv/swamp-repo

# Run the webhook handler manually with the same fields the app sends.
swamp workflow run @svendowideit/capture-linkdrop \
  --input url="https://example.com/manual" \
  --input principal="test-principal"

# Render the current table to ~/.swamp/news-pages/links.html.
swamp workflow run @svendowideit/linkdrop-links-page
```

## Upgrade

This behavior installs nothing on the host. Upgrade the pulled extension and
leave the SQLite file in place:

```sh
swamp extension update @svendowideit/linkdrop
```

The `links` table is created if absent; an existing v1 database is migrated in
place, preserving its rows.

## Details

### Behavior type

`@svendowideit/linkdrop` exposes six methods:

| Method | Arguments | Output resource | Purpose |
| ------ | --------- | --------------- | ------- |
| `store` | `id`, `url`, `title`, `text`, `principal`, `source`, `device`, `sharedAt`, `receivedAt` | `link` | Insert one share. `id` is optional (a UUID is generated); duplicate ids are ignored. `url` is required and must start with `http://` or `https://` (validated before the database is opened). |
| `list` | `limit` (1–500, default 20) | `links` | Return recent rows, newest first, with `count` and a `truncated` flag indicating more rows exist. |
| `stats` | none | `stats` | Return the total row count and database path. |
| `configureServe` | `serveRepo`, `serveConfig`, `route`, `workflow`, `validate` | `serveConfig` | Idempotently merge the webhook into the existing serve config; validate with `swamp serve check-config` unless `validate=false`. |
| `verifyWebhook` | `url`, `route`, `workflow`, `timeoutMs`, `waitMs`, `intervalMs` | `serveVerify` | POST a test share with `source=linkdrop-verify`, retry for up to `waitMs` while the restarted serve comes up, and fail unless the route accepts it. The workflow skips storing verify shares. |
| `renderHtml` | `outputPath` (default `~/.swamp/news-pages/links.html`), `limit` (default 500), `title`, `dbPath` (optional override) | `linksPage` | Render the current SQLite table as a standalone escaped HTML page, newest first. |

### SQLite schema

```sql
CREATE TABLE links (
  id TEXT PRIMARY KEY,        -- server-generated row id
  share_id TEXT NOT NULL,     -- app Idempotency-Key / share UUID
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  principal TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  shared_at TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  UNIQUE(share_id, url)
);
CREATE INDEX idx_links_received_at ON links(received_at);
```

The database uses WAL mode, so concurrent readers are fine while the webhook
writes. Idempotency is `(share_id, url)`: retries of the same share are ignored,
but the same app share id with a different URL is stored as a separate row. A
v1 database that used the app id as its primary key is migrated automatically,
preserving the existing rows.

### Webhook registration

`configureServe` merges one webhook entry into the **existing** serve config by
route, preserving every other key and webhook. It writes atomically, validates
with `swamp serve check-config` unless `validate=false`, and is idempotent: a
second run with the same entry reports `changed=false`. Validation runs the
`swampBinPath` binary with the absolute config path and `--repo-dir`; it never
passes method args to a shell. `verifyWebhook` POSTs a test share to the route;
the `@svendowideit/capture-linkdrop` workflow skips the store step when
`source=linkdrop-verify`, so verification leaves no row behind.

There is no webhook token or secret. `configureServe` writes the no-auth
`@svendowideit/linkdrop-open` scheme and the literal placeholder
`secret: "unused"` that swamp serve requires in every route.

### Workflows

`@svendowideit/linkdrop-links-page` runs `renderHtml` on a separate
`linkdrop-render` model instance. It reads the same SQLite database as the
receiver, so it can run while `linkdrop` is processing shares, and writes the
newest rows to `~/.swamp/news-pages/links.html` (or `outputPath`). It accepts
`limit`, `title`, and an optional `dbPath` override. The page is standalone,
escaped HTML and reports whether older rows were truncated.

The setup workflow's serve inputs are `serveRepo` (default `.`), `serveConfig`
(default `.swamp/serve.yaml`), `serveService` (default `swamp-serve`),
`verifyUrl` (default `http://127.0.0.1:9090/`), `webhookRoute` (default
`/hooks/linkdrop`), `webhookWorkflow` (default
`@svendowideit/capture-linkdrop`), and `validateServe` (default true). There is
no token or secret input.

**`@svendowideit/linkdrop-setup`** takes `dnsName` (for example
`linkdrop.example.com`), an optional `upstream` (default `127.0.0.1:9090`), and
a `caddyModel` (default `caddy`). It merges the webhook into the existing
`serve.yaml`, restarts the systemd service, verifies the route, then calls
`@svendowideit/caddy` `ensureDnsProxy` and `applyDnsRecords`. The
Caddy model must already have `baseDomain` and a DNS provider configured. DNS
propagation and ACME certificate issuance are asynchronous; verify the live
endpoint with `curl https://linkdrop.<zone>/` or Caddy's health/audit methods.

**`@svendowideit/capture-linkdrop`** is the webhook workflow. Its `trigger.inputs` map
`webhook.body.url`, `title`, `text`, `principal`, `source`, `device`, and
`sharedAt` onto the `store` method. It does not fan out; the receiver is the
durable inbox. Downstream routing can be added as a separate workflow that reads
the SQLite table or listens to the stored data.

`@svendowideit/linkdrop-setup` uses a separate `linkdrop-setup` model instance
for configuration and verification, so setup cannot contend with the receiver's
`linkdrop` store lock. It registers the route in the existing serve config,
restarts the existing systemd service, verifies the route, and then configures
Caddy. It does not create a second serve. The running serve must use
the repo/config you pass (`serveRepo`, default `.`, and `serveConfig`, default
`.swamp/serve.yaml`), and its service name is `serveService` (default
`swamp-serve`).

### Webhook configuration

`@svendowideit/linkdrop-setup` merges this entry into the existing serve config
automatically. `serve.example.yaml` is kept as a reference for manual setups:

```yaml
webhooks:
  - route: /hooks/linkdrop
    workflow: "@svendowideit/capture-linkdrop"
    scheme: "@svendowideit/linkdrop-open"
    secret: "unused"
    config: {}
```

The app sends `X-LinkDrop-Principal: <principal>` and no authentication header.
The bundled `@svendowideit/linkdrop-open` handler accepts every request. Protect
the route at the network or Caddy layer if access control is needed.

### Structure and testing

- `linkdrop.ts` — behavior, SQLite helpers, and method implementations.
- `linkdrop_test.ts` — unit tests for path resolution, idempotent insertion,
  list truncation, stats, and URL rejection.
- `linkdrop-setup.yaml` — bundled webhook registration + Caddy DNS/TLS workflow.
- `capture-linkdrop.yaml` — bundled webhook receiver workflow.
- `linkdrop-links-page.yaml` — render the SQLite table to `links.html`.
- `serve.example.yaml` — webhook registration snippet.

Run the tests with the swamp-bundled Deno:

```sh
~/.swamp/deno/deno test -A extensions/models/linkdrop/linkdrop_test.ts
```

To extend it, add methods to `model.methods` and a matching resource/schema;
keep `store` idempotent and treat the SQLite file as the durable boundary. The
`store` method rejects non-HTTP(S) input before the database is opened.
