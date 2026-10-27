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
import { dirname } from "node:path";

/** Resolved global arguments for one LinkDrop behavior instance. */
const GlobalArgsSchema = z.object({
  dbPath: z.string().default("").describe(
    "SQLite database path. Empty uses $SWAMP_HOME/linkdrop/links.db " +
      "(falling back to ~/.swamp/linkdrop/links.db).",
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

/** Counts returned by `stats`. */
const StatsSchema = z.object({
  total: z.number(),
  dbPath: z.string(),
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

/**
 * Open the SQLite database, creating its parent directory, the `links` table,
 * and the receive-time index when needed.
 */
export async function openDatabase(dbPath: string): Promise<DatabaseSync> {
  await Deno.mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
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
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_links_received_at ON links(received_at)",
  );
  return db;
}

/** Insert one share and write the `link` resource. */
async function executeStore(args: StoreArgs, ctx: MethodContext) {
  const dbPath = resolveDbPath(ctx.globalArgs);
  const id = args.id.trim() || crypto.randomUUID();
  const receivedAt = args.receivedAt.trim() || new Date().toISOString();
  const db = await openDatabase(dbPath);

  try {
    const result = db.prepare(`
      INSERT INTO links (
        id, url, title, text, principal, source, device, shared_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
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
      dbPath,
    };
    const handle = await ctx.writeResource("link", id, record);
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
  const db = await openDatabase(dbPath);

  try {
    const rows = db.prepare(`
      SELECT id, url, title, text, principal, source, device,
             shared_at, received_at
      FROM links
      ORDER BY received_at DESC
      LIMIT ?
    `).all(args.limit).map((row) => LinkRowSchema.parse(row));
    const handle = await ctx.writeResource("links", `links-${Date.now()}`, {
      dbPath,
      count: rows.length,
      links: rows,
    });
    return { dataHandles: [handle] };
  } finally {
    db.close();
  }
}

/** Count stored rows and write the `stats` resource. */
async function executeStats(_args: Record<string, never>, ctx: MethodContext) {
  const dbPath = resolveDbPath(ctx.globalArgs);
  const db = await openDatabase(dbPath);

  try {
    const row = db.prepare("SELECT COUNT(*) AS total FROM links").get() as
      | { total: number }
      | undefined;
    const stats = StatsSchema.parse({ total: Number(row?.total ?? 0), dbPath });
    const handle = await ctx.writeResource(
      "stats",
      `stats-${Date.now()}`,
      stats,
    );
    return { dataHandles: [handle] };
  } finally {
    db.close();
  }
}

/** LinkDrop SQLite receiver: durable storage for shared URLs. */
export const behavior = {
  type: "@svendowideit/linkdrop",
  version: "2026.10.27.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    link: {
      description: "One stored share, including whether it was newly inserted.",
      schema: StoredLinkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    links: {
      description: "The most recent rows read from the SQLite inbox.",
      schema: z.object({
        dbPath: z.string(),
        count: z.number(),
        links: z.array(LinkRowSchema),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    stats: {
      description: "Total rows and the database path.",
      schema: StatsSchema,
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
  },
};
