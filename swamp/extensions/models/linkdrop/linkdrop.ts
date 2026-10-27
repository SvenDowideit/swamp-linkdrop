/**
 * LinkDrop receiver behavior — stores shared URLs in SQLite.
 *
 * The Android app posts one JSON object per share to a `swamp serve` webhook.
 * The `capture-linkdrop` workflow maps the verified request body onto `store`.
 * A SQLite database is the durable inbox: it is independent of swamp data
 * retention and easy to query from scripts or another tool.
 *
 * Methods:
 *   - `store`  insert one shared URL (idempotent by `id`)
 *   - `list`   list the most recent rows
 *   - `stats`  report row counts
 *
 * @module
 */

import { z } from "npm:zod@4";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { parseDocument } from "npm:yaml@2.9.1";

/** Resolved global arguments for one LinkDrop behavior instance. */
const GlobalArgsSchema = z.object({
  dbPath: z.string().default("").describe(
    "SQLite database path. Empty uses $SWAMP_HOME/linkdrop/links.db " +
      "(falling back to ~/.swamp/linkdrop/links.db).",
  ),
  swampBinPath: z.string().default("swamp").describe(
    "The swamp binary used to validate the serve config.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `store`. */
const StoreArgsSchema = z.object({
  id: z.string().default("").describe(
    "Share UUID from the app; empty generates a new one. Duplicate ids are ignored.",
  ),
  url: z.string().min(1).describe("The shared URL."),
  title: z.string().default("").describe(
    "Optional page title from the share intent.",
  ),
  text: z.string().default("").describe(
    "Full shared text, including title and URL.",
  ),
  principal: z.string().default("").describe(
    "Stable per-app/profile identifier from the app; used for per-user routing.",
  ),
  source: z.string().default("android-share").describe(
    "Where the share came from (`android-share` or `linkdrop-test`).",
  ),
  device: z.string().default("").describe("Device label supplied by the app."),
  sharedAt: z.string().default("").describe("ISO timestamp from the app."),
  receivedAt: z.string().default("").describe(
    "ISO receive timestamp; empty uses the current time.",
  ),
});
type StoreArgs = z.infer<typeof StoreArgsSchema>;

/** Arguments for `list`. */
const ListArgsSchema = z.object({
  limit: z.number().int().positive().max(500).default(20).describe(
    "Maximum number of rows to return, newest first.",
  ),
});
type ListArgs = z.infer<typeof ListArgsSchema>;

/** A stored link, as written to the `link` resource. */
const StoredLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  text: z.string(),
  principal: z.string(),
  source: z.string(),
  device: z.string(),
  sharedAt: z.string(),
  receivedAt: z.string(),
  inserted: z.boolean(),
  rowId: z.string(),
  dbPath: z.string(),
});

/** One row returned by `list`. */
const LinkRowSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  text: z.string(),
  principal: z.string(),
  source: z.string(),
  device: z.string(),
  shared_at: z.string(),
  received_at: z.string(),
});

/** The result of `list`. */
const LinkListSchema = z.object({
  dbPath: z.string(),
  count: z.number(),
  truncated: z.boolean(),
  links: z.array(LinkRowSchema),
});

/** Arguments for `renderHtml`. */
const RenderLinksArgsSchema = z.object({
  outputPath: z.string().default("~/.swamp/news-pages/links.html").describe(
    "HTML file to write. The default is the news-pages directory.",
  ),
  limit: z.number().int().positive().max(5_000).default(500).describe(
    "Maximum number of rows to render, newest first.",
  ),
  title: z.string().default("LinkDrop links").describe("Page heading."),
  dbPath: z.string().default("").describe(
    "Optional SQLite path override; empty uses the model's dbPath.",
  ),
});
type RenderLinksArgs = z.infer<typeof RenderLinksArgsSchema>;

/** The written links page. */
const LinksPageSchema = z.object({
  path: z.string(),
  count: z.number(),
  truncated: z.boolean(),
  dbPath: z.string(),
  generatedAt: z.string(),
});

/** Counts returned by `stats`. */
const StatsSchema = z.object({
  total: z.number(),
  dbPath: z.string(),
});

/** Arguments for `configureServe`. */
const ServeConfigArgsSchema = z.object({
  serveRepo: z.string().default(".").describe(
    "Repository the running swamp serve uses; relative serveConfig paths and " +
      "check-config resolve from here.",
  ),
  serveConfig: z.string().default(".swamp/serve.yaml").describe(
    "Serve config path, relative to serveRepo or absolute.",
  ),
  route: z.string().default("/hooks/linkdrop").describe("Webhook route."),
  workflow: z.string().default("@svendowideit/capture-linkdrop").describe(
    "Workflow the webhook starts.",
  ),
  validate: z.boolean().default(true).describe(
    "Run `swamp serve check-config` after writing the config.",
  ),
});
type ServeConfigArgs = z.infer<typeof ServeConfigArgsSchema>;

/** Arguments for `verifyWebhook`. */
const ServeVerifyArgsSchema = z.object({
  url: z.string().default("http://127.0.0.1:9090/").describe(
    "The swamp serve root URL, not the webhook route URL.",
  ),
  route: z.string().default("/hooks/linkdrop").describe(
    "Webhook route expected in the serve root's webhooks list.",
  ),
  workflow: z.string().default("@svendowideit/capture-linkdrop").describe(
    "Workflow expected for the route.",
  ),
  timeoutMs: z.number().int().positive().max(60_000).default(5_000).describe(
    "HTTP timeout for one verification attempt.",
  ),
  waitMs: z.number().int().min(0).max(300_000).default(30_000).describe(
    "How long to keep retrying while the restarted serve comes up.",
  ),
  intervalMs: z.number().int().positive().max(60_000).default(1_000).describe(
    "Delay between verification attempts.",
  ),
});
type ServeVerifyArgs = z.infer<typeof ServeVerifyArgsSchema>;

/** A configured serve webhook route. */
const ServeConfigSchema = z.object({
  path: z.string(),
  serveRepo: z.string(),
  route: z.string(),
  workflow: z.string(),
  changed: z.boolean(),
  validated: z.boolean(),
  webhookCount: z.number(),
  checkedAt: z.string(),
});

/** The result of verifying a running serve's webhook list. */
const ServeVerifySchema = z.object({
  url: z.string(),
  route: z.string(),
  workflow: z.string(),
  found: z.boolean(),
  checkedAt: z.string(),
});

/** Minimal method context used by this behavior. */
interface MethodContext {
  globalArgs: GlobalArgs;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Expand a leading `~` and honour SWAMP_HOME for `~/.swamp` paths. */
export function expandHome(path: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const swampHome = Deno.env.get("SWAMP_HOME") ?? `${home}/.swamp`;
  if (path === "~") return home;
  if (path.startsWith("~/")) {
    const rest = path.slice(2);
    if (rest === ".swamp" || rest.startsWith(".swamp/")) {
      return `${swampHome}/${rest.slice(".swamp".length).replace(/^\//, "")}`
        .replace(/\/$/, "");
    }
    return `${home}/${rest}`;
  }
  return path;
}

/** Resolve the configured database path, defaulting under SWAMP_HOME. */
export function resolveDbPath(globalArgs: GlobalArgs): string {
  if (globalArgs.dbPath.trim()) return expandHome(globalArgs.dbPath.trim());
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const swampHome = Deno.env.get("SWAMP_HOME") ?? `${home}/.swamp`;
  return `${swampHome}/linkdrop/links.db`;
}

/** Current links table: server row id, app share id, unique share+URL. */
const NEW_LINKS_TABLE = `
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    principal TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    shared_at TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    UNIQUE(share_id, url)
  )
`;

/**
 * Open the SQLite database, creating its parent directory, the `links` table,
 * and the receive-time index when needed; migrate a v1 id-only table.
 */
export async function openDatabase(dbPath: string): Promise<DatabaseSync> {
  await Deno.mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const columns = db.prepare("PRAGMA table_info(links)").all() as Array<
    { name: string }
  >;
  const hasSchema = columns.length > 0;
  const hasShareId = columns.some((column) => column.name === "share_id");

  if (hasSchema && !hasShareId) {
    // v1 used the app share UUID as the primary key. That collapsed different
    // URLs when the app reused an id. Move to a server row id plus a unique
    // (share_id, url) pair; existing rows keep their share id and URL.
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE links RENAME TO links_legacy");
      db.exec(NEW_LINKS_TABLE);
      db.exec(`
        INSERT INTO links (
          id, share_id, url, title, text, principal, source, device,
          shared_at, received_at
        )
        SELECT id, id, url, title, text, principal, source, device,
               shared_at, received_at
        FROM links_legacy
      `);
      db.exec("DROP TABLE links_legacy");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else if (!hasSchema) {
    db.exec(NEW_LINKS_TABLE);
  }

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_links_received_at ON links(received_at)",
  );
  return db;
}

/** Insert one share and write the `link` resource. */
async function executeStore(args: StoreArgs, ctx: MethodContext) {
  if (!/^https?:\/\//i.test(args.url)) {
    throw new Error("url must start with http:// or https://");
  }
  const dbPath = resolveDbPath(ctx.globalArgs);
  const id = args.id.trim() || crypto.randomUUID();
  const receivedAt = args.receivedAt.trim() || new Date().toISOString();
  ctx.logger?.info("Storing share {id} in {dbPath}", { id, dbPath });
  const db = await openDatabase(dbPath);

  try {
    const rowId = crypto.randomUUID();
    const result = db.prepare(`
      INSERT INTO links (
        id, share_id, url, title, text, principal, source, device,
        shared_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(share_id, url) DO NOTHING
    `).run(
      rowId,
      id,
      args.url,
      args.title,
      args.text,
      args.principal,
      args.source,
      args.device,
      args.sharedAt,
      receivedAt,
    );
    const inserted = Number(result.changes) > 0;
    const record = {
      id,
      url: args.url,
      title: args.title,
      text: args.text,
      principal: args.principal,
      source: args.source,
      device: args.device,
      sharedAt: args.sharedAt,
      receivedAt,
      inserted,
      rowId: inserted ? rowId : "",
      dbPath,
    };
    const handle = await ctx.writeResource(
      "link",
      inserted ? rowId : `${id}-duplicate-${crypto.randomUUID()}`,
      record,
    );
    ctx.logger?.info("Stored {url} in {dbPath} (inserted={inserted})", {
      url: args.url,
      dbPath,
      inserted,
    });
    return { dataHandles: [handle] };
  } finally {
    db.close();
  }
}

/** List recent rows and write the `links` resource. */
async function executeList(args: ListArgs, ctx: MethodContext) {
  const dbPath = resolveDbPath(ctx.globalArgs);
  ctx.logger?.info("Listing up to {limit} shares from {dbPath}", {
    limit: args.limit,
    dbPath,
  });
  const db = await openDatabase(dbPath);

  try {
    const rows = db.prepare(`
      SELECT share_id AS id, url, title, text, principal, source, device,
             shared_at, received_at
      FROM links
      ORDER BY received_at DESC
      LIMIT ?
    `).all(args.limit + 1).map((row) => LinkRowSchema.parse(row));
    const truncated = rows.length > args.limit;
    const links = truncated ? rows.slice(0, args.limit) : rows;
    const handle = await ctx.writeResource(
      "links",
      `links-${crypto.randomUUID()}`,
      {
        dbPath,
        count: links.length,
        truncated,
        links,
      },
    );
    ctx.logger?.info(
      "Listed {count} shares from {dbPath} (truncated={truncated})",
      { count: links.length, dbPath, truncated },
    );
    return { dataHandles: [handle] };
  } finally {
    db.close();
  }
}

/** Count stored rows and write the `stats` resource. */
async function executeStats(
  _args: Record<string, unknown>,
  ctx: MethodContext,
) {
  const dbPath = resolveDbPath(ctx.globalArgs);
  ctx.logger?.info("Reading share stats from {dbPath}", { dbPath });
  const db = await openDatabase(dbPath);

  try {
    const row = db.prepare("SELECT COUNT(*) AS total FROM links").get() as
      | { total: number }
      | undefined;
    const stats = StatsSchema.parse({ total: Number(row?.total ?? 0), dbPath });
    const handle = await ctx.writeResource(
      "stats",
      `stats-${crypto.randomUUID()}`,
      stats,
    );
    return { dataHandles: [handle] };
  } finally {
    db.close();
  }
}

/** Escape text for HTML text and attribute contexts. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Render the SQLite link rows as one standalone HTML page. */
export function renderLinksHtml(
  rows: Array<z.infer<typeof LinkRowSchema>>,
  options: {
    title: string;
    dbPath: string;
    generatedAt: string;
    truncated: boolean;
  },
): string {
  const items = rows.map((row) => {
    const title = row.title.trim() || row.url;
    const href = escapeHtml(row.url);
    return `      <li>
        <a href="${href}" rel="noreferrer">${escapeHtml(title)}</a>
        <div class="url">${escapeHtml(row.url)}</div>
        <div class="meta">${escapeHtml(row.received_at)} · ${
      escapeHtml(row.id)
    } · ${escapeHtml(row.principal)}</div>
      </li>`;
  }).join("\n");
  const truncation = options.truncated
    ? `<p class="note">Showing the newest ${rows.length} rows; older rows are not shown.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 54rem; padding: 0 1rem; color: #1a1c1e; }
    h1 { margin-bottom: .25rem; }
    .note, .meta, .url { color: #5f6368; font-size: .9rem; }
    ul { list-style: none; padding: 0; }
    li { padding: .9rem 0; border-bottom: 1px solid #e0e3e7; }
    a { color: #0d47a1; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    .url { overflow-wrap: anywhere; margin-top: .2rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(options.title)}</h1>
  <p class="note">${rows.length} link(s) · generated ${
    escapeHtml(options.generatedAt)
  } · ${escapeHtml(options.dbPath)}</p>
  ${truncation}
  <ul>
${items}
  </ul>
</body>
</html>
`;
}

/** Render the current SQLite links table to a standalone HTML file. */
async function executeRenderHtml(
  args: RenderLinksArgs,
  ctx: MethodContext,
) {
  const dbPath = args.dbPath.trim()
    ? expandHome(args.dbPath.trim())
    : resolveDbPath(ctx.globalArgs);
  const outputPath = expandHome(
    args.outputPath.trim() || "~/.swamp/news-pages/links.html",
  );
  const db = await openDatabase(dbPath);

  try {
    const rows = db.prepare(`
      SELECT share_id AS id, url, title, text, principal, source, device,
             shared_at, received_at
      FROM links
      ORDER BY received_at DESC
      LIMIT ?
    `).all(args.limit + 1).map((row) => LinkRowSchema.parse(row));
    const truncated = rows.length > args.limit;
    const links = truncated ? rows.slice(0, args.limit) : rows;
    const generatedAt = new Date().toISOString();
    const html = renderLinksHtml(links, {
      title: args.title,
      dbPath,
      generatedAt,
      truncated,
    });

    await Deno.mkdir(dirname(outputPath), { recursive: true });
    const tmp = `${outputPath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, html);
    await Deno.rename(tmp, outputPath);
    const record = {
      path: outputPath,
      count: links.length,
      truncated,
      dbPath,
      generatedAt,
    };
    const handle = await ctx.writeResource(
      "linksPage",
      "linksPage",
      record,
    );
    ctx.logger?.info("Rendered {count} links to {path}", {
      count: links.length,
      path: outputPath,
    });
    return { dataHandles: [handle] };
  } finally {
    db.close();
  }
}

/**
 * Merge one webhook entry into a serve config's `webhooks` array by route.
 * Other entries and their order are preserved; a matching route is replaced
 * wholesale so obsolete scheme/header fields cannot survive.
 */
export function mergeWebhookEntry(
  existing: unknown,
  entry: Record<string, unknown>,
): Record<string, unknown>[] {
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error("serve config `webhooks` must be an array");
  }
  const list = (existing ?? []) as unknown[];
  const result: Record<string, unknown>[] = [];
  let found = false;

  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("every serve config webhook entry must be an object");
    }
    const webhook = item as Record<string, unknown>;
    if (webhook.route === entry.route) {
      if (!found) {
        result.push({ ...entry });
        found = true;
      }
      continue;
    }
    result.push(webhook);
  }

  if (!found) result.push(entry);
  return result;
}

/** Idempotently add/update the LinkDrop webhook in an existing serve config. */
async function executeConfigureServe(
  args: ServeConfigArgs,
  ctx: MethodContext,
) {
  const serveRepo = resolve(expandHome(args.serveRepo.trim() || "."));
  const configPath = args.serveConfig.startsWith("/")
    ? args.serveConfig
    : resolve(serveRepo, args.serveConfig);

  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (error) {
    throw new Error(
      `Cannot read serve config ${configPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(
      `Invalid YAML in ${configPath}: ${doc.errors[0].message}`,
    );
  }
  const data = doc.toJS() as Record<string, unknown> | null;
  if (data !== null && (typeof data !== "object" || Array.isArray(data))) {
    throw new Error(`${configPath} must contain a YAML mapping`);
  }

  const entry: Record<string, unknown> = {
    route: args.route,
    workflow: args.workflow,
    scheme: "@svendowideit/linkdrop-open",
    secret: "unused",
    config: {},
  };

  const before = (data ?? {}).webhooks;
  const merged = mergeWebhookEntry(before, entry);
  const changed = JSON.stringify(before ?? []) !== JSON.stringify(merged);

  if (changed) {
    doc.setIn(["webhooks"], merged);
    const tmp = `${configPath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, doc.toString({ lineWidth: 0 }));
    await Deno.rename(tmp, configPath);
  }

  let validated = false;
  if (args.validate) {
    // check-config is a swamp CLI surface; arguments are the validated config
    // path and repository, never raw input.
    // swamp-quality-ignore deno-command: required for serve check-config
    const command = new Deno.Command(ctx.globalArgs.swampBinPath, {
      args: [
        "serve",
        "check-config",
        "--config",
        configPath,
        "--repo-dir",
        serveRepo,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (result.code !== 0) {
      const detail = new TextDecoder().decode(result.stderr).trim() ||
        new TextDecoder().decode(result.stdout).trim();
      throw new Error(
        `swamp serve check-config failed for ${configPath}: ${detail}`,
      );
    }
    validated = true;
  }

  const record = {
    path: configPath,
    serveRepo,
    route: args.route,
    workflow: args.workflow,
    changed,
    validated,
    webhookCount: merged.length,
    checkedAt: new Date().toISOString(),
  };
  const handle = await ctx.writeResource(
    "serveConfig",
    "serveConfig",
    record,
  );
  ctx.logger?.info(
    "Configured webhook {route} in {path} (changed={changed}, validated={validated})",
    { route: args.route, path: configPath, changed, validated },
  );
  return { dataHandles: [handle] };
}

/** Verify the route by POSTing a test share that the workflow skips storing. */
async function executeVerifyWebhook(
  args: ServeVerifyArgs,
  ctx: MethodContext,
) {
  const target = new URL(args.route, args.url).toString();
  const payload = JSON.stringify({
    id: `verify-${crypto.randomUUID()}`,
    url: "https://example.com/linkdrop-verify",
    title: "LinkDrop verify",
    text: "LinkDrop verify",
    principal: "linkdrop-verify",
    source: "linkdrop-verify",
    device: "linkdrop-setup",
    sharedAt: new Date().toISOString(),
  });
  ctx.logger?.info("Verifying webhook {route} at {url}", {
    route: args.route,
    url: target,
  });

  const deadline = Date.now() + args.waitMs;
  let lastError = "";

  while (true) {
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      if (response.ok) {
        const record = {
          url: target,
          route: args.route,
          workflow: args.workflow,
          found: true,
          checkedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource(
          "serveVerify",
          "serveVerify",
          record,
        );
        ctx.logger?.info("Verified webhook {route} at {url}", {
          route: args.route,
          url: target,
        });
        return { dataHandles: [handle] };
      }
      lastError = `HTTP ${response.status} from ${target}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() + args.intervalMs > deadline) {
      throw new Error(
        `Cannot verify ${args.route} after ${args.waitMs}ms: ${lastError}. ` +
          "Check `systemctl --user status <serve-unit>` and its logs.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }
}

/** LinkDrop SQLite receiver: durable storage for shared URLs. */
export const model = {
  type: "@svendowideit/linkdrop",
  version: "2026.10.27.7",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.10.27.2",
      description:
        "Package the LinkDrop setup and webhook workflows with the extension; " +
        "no behavior attributes change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.27.3",
      description:
        "Add configureServe/verifyWebhook so linkdrop-setup registers the " +
        "route in the existing serve config and verifies it after restart.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.27.4",
      description: "Remove the webhook token requirement: use the no-auth " +
        "@svendowideit/linkdrop-open handler and the literal placeholder " +
        "secret required by swamp serve.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.27.5",
      description:
        "Verify the route with a real test POST instead of the serve root's " +
        "webhooks metadata, which is null on durable/remote serve instances.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.27.6",
      description:
        "Run configureServe/verifyWebhook on a separate linkdrop-setup model " +
        "instance so setup cannot contend with the receiver's store lock.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.27.7",
      description:
        "Add renderHtml to write the current SQLite table as a standalone " +
        "news-pages HTML page.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    link: {
      description: "One stored share, including whether it was newly inserted.",
      schema: StoredLinkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    links: {
      description:
        "The most recent rows read from the SQLite inbox, with a truncation flag.",
      schema: LinkListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    stats: {
      description: "Total rows and the database path.",
      schema: StatsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    serveConfig: {
      description: "The merged serve config entry and its validation result.",
      schema: ServeConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    serveVerify: {
      description: "The running serve's verified webhook registration.",
      schema: ServeVerifySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    linksPage: {
      description: "The rendered standalone HTML links page.",
      schema: LinksPageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    store: {
      description:
        "Insert one shared URL into SQLite, idempotent by share id, and write " +
        "a `link` resource with the inserted flag.",
      arguments: StoreArgsSchema,
      execute: executeStore,
    },
    list: {
      description: "List the most recent stored shares, newest first.",
      arguments: ListArgsSchema,
      execute: executeList,
    },
    stats: {
      description: "Report the total number of stored shares and the DB path.",
      arguments: z.object({}),
      execute: executeStats,
    },
    configureServe: {
      description:
        "Idempotently merge the LinkDrop webhook into the active serve config, " +
        "preserving other keys and webhooks; optionally validate the config.",
      arguments: ServeConfigArgsSchema,
      execute: executeConfigureServe,
    },
    verifyWebhook: {
      description:
        "POST a test share to the route, retrying while the restarted serve " +
        "comes up, and fail unless the route accepts it.",
      arguments: ServeVerifyArgsSchema,
      execute: executeVerifyWebhook,
    },
    renderHtml: {
      description:
        "Render the current SQLite links table as a standalone HTML page " +
        "(default ~/.swamp/news-pages/links.html).",
      arguments: RenderLinksArgsSchema,
      execute: executeRenderHtml,
    },
  },
};
