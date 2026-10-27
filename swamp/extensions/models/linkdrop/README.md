# @svendowideit/linkdrop

Durable SQLite inbox for URLs shared by the LinkDrop Android app.

## What it does

The Android app posts one JSON object per shared URL to a `swamp serve`
webhook. This behavior is the receiver behind that webhook: it validates the
mapped fields, inserts the row into SQLite, and writes a swamp `link` resource.
The insert is idempotent by the app's share UUID, so a retry after a lost HTTP
response does not duplicate a row. The bundled `@svendowideit/linkdrop-setup`
workflow creates the Caddy DNS record and TLS route for the `linkdrop.<zone>`
name; the bundled `@svendowideit/capture-linkdrop` workflow is the webhook
handler.

Side effects: creates/opens the configured SQLite file, creates its parent
directory and the `links` table, writes a `link`/`links`/`stats` swamp resource,
and (via the setup workflow) creates a Caddy route and DNS/TLS entry. It installs
no services, cron triggers, daemons, or webhooks of its own.

## Install

```sh
swamp extension pull @svendowideit/linkdrop
```

One pull installs the behavior and both bundled workflows:
`@svendowideit/linkdrop-setup` (Caddy DNS/TLS) and
`@svendowideit/capture-linkdrop` (webhook handler). `@svendowideit/caddy` is
pulled automatically as a dependency. That installs the Caddy type; you still
need a configured Caddy model, and can point the setup workflow at it with
`--input caddyModel=my-caddy` (default `caddy`).

For local development in this repository, the behavior is loaded directly from
`extensions/models/linkdrop`; no pull is needed. The webhook route itself lives
in `swamp serve`'s config.

## Configuration

| Argument | Type | Default | Meaning |
| -------- | ---- | ------- | ------- |
| `dbPath` | string | `""` | SQLite file path. Empty resolves to `$SWAMP_HOME/linkdrop/links.db`, falling back to `~/.swamp/linkdrop/links.db`. |

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
  --input dnsName=linkdrop.example.com --input caddyModel=my-caddy

# Run the webhook handler manually with the same fields the app sends.
swamp workflow run @svendowideit/capture-linkdrop \
  --input url="https://example.com/manual" \
  --input principal="test-principal"
```

## Upgrade

This behavior installs nothing on the host. Upgrade the pulled extension and
leave the SQLite file in place:

```sh
swamp extension update @svendowideit/linkdrop
```

The `links` table is created with `CREATE TABLE IF NOT EXISTS`; an existing
database is not rewritten or migrated destructively.

## Details

### Behavior type

`@svendowideit/linkdrop` exposes three methods:

| Method | Arguments | Output resource | Purpose |
| ------ | --------- | --------------- | ------- |
| `store` | `id`, `url`, `title`, `text`, `principal`, `source`, `device`, `sharedAt`, `receivedAt` | `link` | Insert one share. `id` is optional (a UUID is generated); duplicate ids are ignored. `url` is required and must start with `http://` or `https://` (validated before the database is opened). |
| `list` | `limit` (1–500, default 20) | `links` | Return recent rows, newest first, with `count` and a `truncated` flag indicating more rows exist. |
| `stats` | none | `stats` | Return the total row count and database path. |

### SQLite schema

```sql
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  principal TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  shared_at TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_received_at ON links(received_at);
```

The database uses WAL mode, so concurrent readers are fine while the webhook
writes. The `id` primary key is the app's `Idempotency-Key` / share UUID.

### Workflows

**`@svendowideit/linkdrop-setup`** takes `dnsName` (for example
`linkdrop.example.com`), an optional `upstream` (default `127.0.0.1:9090`), and
a `caddyModel` (default `caddy`). It calls `@svendowideit/caddy`
`ensureDnsProxy` and then `applyDnsRecords`. The
Caddy model must already have `baseDomain` and a DNS provider configured. DNS
propagation and ACME certificate issuance are asynchronous; verify the live
endpoint with `curl https://linkdrop.<zone>/` or Caddy's health/audit methods.

**`@svendowideit/capture-linkdrop`** is the webhook workflow. Its `trigger.inputs` map
`webhook.body.url`, `title`, `text`, `principal`, `source`, `device`, and
`sharedAt` onto the `store` method. It does not fan out; the receiver is the
durable inbox. Downstream routing can be added as a separate workflow that reads
the SQLite table or listens to the stored data.

### Webhook configuration

Copy `serve.example.yaml` to the repo's serve config (or merge it), and set
`LINKDROP_TOKEN` in the serve environment:

```yaml
webhooks:
  - route: /hooks/linkdrop
    workflow: "@svendowideit/capture-linkdrop"
    secret: "@env=LINKDROP_TOKEN"
    scheme: generic
    header: x-webhook-token
```

The app sends `X-Webhook-Token: <lowercase hex HMAC-SHA256 of the exact body,
keyed by LINKDROP_TOKEN>` and `X-LinkDrop-Principal: <principal>`.

The built-in `generic` scheme is HMAC-over-body, not a static bearer token.
`header` names the header, and an optional `prefix` (for example `sha256=`) is
stripped before comparing. With no prefix, send the bare hex digest.

### Structure and testing

- `linkdrop.ts` — behavior, SQLite helpers, and method implementations.
- `linkdrop_test.ts` — unit tests for path resolution, idempotent insertion,
  list truncation, stats, and URL rejection.
- `linkdrop-setup.yaml` — bundled Caddy DNS/TLS workflow.
- `capture-linkdrop.yaml` — bundled webhook receiver workflow.
- `serve.example.yaml` — webhook registration snippet.

Run the tests with the swamp-bundled Deno:

```sh
~/.swamp/deno/deno test -A extensions/models/linkdrop/linkdrop_test.ts
```

To extend it, add methods to `model.methods` and a matching resource/schema;
keep `store` idempotent and treat the SQLite file as the durable boundary. The
`store` method rejects non-HTTP(S) input before the database is opened.
