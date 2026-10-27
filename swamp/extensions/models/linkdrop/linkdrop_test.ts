import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";

import {
  escapeHtml,
  expandHome,
  mergeWebhookEntry,
  model,
  openDatabase,
  renderLinksHtml,
  resolveDbPath,
} from "./linkdrop.ts";

Deno.test("expandHome expands the user home", () => {
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(expandHome("~/links.db"), `${home}/links.db`);
});

Deno.test("expandHome honours SWAMP_HOME for ~/.swamp paths", () => {
  const previous = Deno.env.get("SWAMP_HOME");
  try {
    Deno.env.set("SWAMP_HOME", "/tmp/linkdrop-swamp-home");
    assertEquals(
      expandHome("~/.swamp/linkdrop/links.db"),
      "/tmp/linkdrop-swamp-home/linkdrop/links.db",
    );
    assertEquals(expandHome("~/.swamp"), "/tmp/linkdrop-swamp-home");
  } finally {
    if (previous === undefined) Deno.env.delete("SWAMP_HOME");
    else Deno.env.set("SWAMP_HOME", previous);
  }
});

Deno.test("resolveDbPath defaults under SWAMP_HOME", () => {
  const previous = Deno.env.get("SWAMP_HOME");
  try {
    Deno.env.set("SWAMP_HOME", "/tmp/linkdrop-swamp-home");
    assertEquals(
      resolveDbPath({ dbPath: "", swampBinPath: "swamp" }),
      "/tmp/linkdrop-swamp-home/linkdrop/links.db",
    );
    assertEquals(
      resolveDbPath({ dbPath: "~/custom.db", swampBinPath: "swamp" }),
      `${Deno.env.get("HOME")}/custom.db`,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("SWAMP_HOME");
    else Deno.env.set("SWAMP_HOME", previous);
  }
});

Deno.test("store is idempotent by share id and writes a resource", async () => {
  const dir = await Deno.makeTempDir({ prefix: "linkdrop-test-" });
  const dbPath = `${dir}/links.db`;

  try {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      globalArgs: { dbPath, swampBinPath: "swamp" },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        written.push(data);
        return Promise.resolve({ name: _name });
      },
    };

    const args = {
      id: "share-1",
      url: "https://example.com/a",
      title: "Example",
      text: "Example https://example.com/a",
      principal: "principal-1",
      source: "android-share",
      device: "Test device",
      sharedAt: "2026-10-27T09:00:00Z",
      receivedAt: "",
    };

    await model.methods.store.execute(args, ctx);
    await model.methods.store.execute(args, ctx);

    assertEquals(written.length, 2);
    assertEquals(written[0].inserted, true);
    assertEquals(written[1].inserted, false);

    const db = await openDatabase(dbPath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS total FROM links").get() as {
        total: number;
      };
      assertEquals(Number(row.total), 1);
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("list reports truncation and stats counts rows", async () => {
  const dir = await Deno.makeTempDir({ prefix: "linkdrop-test-" });
  const dbPath = `${dir}/links.db`;

  try {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      globalArgs: { dbPath, swampBinPath: "swamp" },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        written.push(data);
        return Promise.resolve({ name: _name });
      },
    };

    for (let i = 1; i <= 3; i++) {
      await model.methods.store.execute({
        id: `share-${i}`,
        url: `https://example.com/${i}`,
        title: "",
        text: "",
        principal: "principal-1",
        source: "android-share",
        device: "",
        sharedAt: "",
        receivedAt: "",
      }, ctx);
    }

    await model.methods.list.execute({ limit: 2 }, ctx);
    const list = written[3];
    assertEquals(list.count, 2);
    assertEquals(list.truncated, true);
    assertEquals((list.links as unknown[]).length, 2);

    await model.methods.stats.execute({}, ctx);
    const stats = written[4];
    assertEquals(stats.total, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("store rejects non-HTTP(S) URLs before opening the database", async () => {
  await assertRejects(
    () =>
      model.methods.store.execute({
        id: "bad-url",
        url: "ftp://example.com/file",
        title: "",
        text: "",
        principal: "",
        source: "android-share",
        device: "",
        sharedAt: "",
        receivedAt: "",
      }, {
        globalArgs: { dbPath: "", swampBinPath: "swamp" },
        writeResource: () => Promise.resolve({ name: "unused" }),
      }),
    Error,
    "url must start with http:// or https://",
  );
});

Deno.test("mergeWebhookEntry preserves other webhooks and is idempotent", () => {
  const existing = [
    { route: "/hooks/other", workflow: "other", secret: "@env=OTHER" },
    { route: "/hooks/linkdrop", workflow: "old", secret: "@env=OLD" },
  ];
  const entry = {
    route: "/hooks/linkdrop",
    workflow: "@svendowideit/capture-linkdrop",
    scheme: "@svendowideit/linkdrop-open",
    secret: "unused",
    config: {},
  };
  const once = mergeWebhookEntry(existing, entry);
  const twice = mergeWebhookEntry(once, entry);
  assertEquals(once.length, 2);
  assertEquals(once[0], existing[0]);
  assertEquals(once[1].workflow, "@svendowideit/capture-linkdrop");
  assertEquals(once[1].secret, "unused");
  assertEquals(once[1].scheme, "@svendowideit/linkdrop-open");
  assertEquals(once[1].header, undefined);
  assertEquals(twice, once);
});

Deno.test("configureServe merges a route without clobbering other config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "linkdrop-serve-" });
  const configPath = `${dir}/serve.yaml`;
  await Deno.writeTextFile(
    configPath,
    "port: 9090\nwebhooks:\n  - route: /hooks/other\n    workflow: other\n",
  );

  try {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      globalArgs: { dbPath: "", swampBinPath: "swamp" },
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push(data);
        return Promise.resolve({ name });
      },
    };
    const args = {
      serveRepo: dir,
      serveConfig: "serve.yaml",
      route: "/hooks/linkdrop",
      workflow: "@svendowideit/capture-linkdrop",
      validate: false,
    };

    await model.methods.configureServe.execute(args, ctx);
    const first = await Deno.readTextFile(configPath);
    assertEquals(first.includes("port: 9090"), true);
    assertEquals(first.includes("/hooks/other"), true);
    assertEquals(first.includes("/hooks/linkdrop"), true);
    assertEquals(first.includes("@svendowideit/capture-linkdrop"), true);
    assertEquals(first.includes("@svendowideit/linkdrop-open"), true);
    assertEquals(first.includes("secret: unused"), true);
    assertEquals(written[0].changed, true);

    await model.methods.configureServe.execute(args, ctx);
    assertEquals(written[1].changed, false);
    assertEquals(await Deno.readTextFile(configPath), first);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verifyWebhook accepts a live route and rejects a missing one", async () => {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/hooks/linkdrop"
    ) {
      return Response.json({ status: "queued" });
    }
    return new Response("Not found", { status: 404 });
  });
  const port = (server.addr as Deno.NetAddr).port;

  try {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      globalArgs: { dbPath: "", swampBinPath: "swamp" },
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push(data);
        return Promise.resolve({ name });
      },
    };

    await model.methods.verifyWebhook.execute({
      url: `http://127.0.0.1:${port}/`,
      route: "/hooks/linkdrop",
      workflow: "@svendowideit/capture-linkdrop",
      timeoutMs: 1000,
      waitMs: 2000,
      intervalMs: 200,
    }, ctx);
    assertEquals(written[0].found, true);

    await assertRejects(
      () =>
        model.methods.verifyWebhook.execute({
          url: `http://127.0.0.1:${port}/`,
          route: "/hooks/missing",
          workflow: "@svendowideit/capture-linkdrop",
          timeoutMs: 1000,
          waitMs: 300,
          intervalMs: 100,
        }, ctx),
      Error,
      "Cannot verify",
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("same app share id with different URLs stores both", async () => {
  const dir = await Deno.makeTempDir({ prefix: "linkdrop-collision-" });
  const dbPath = `${dir}/links.db`;

  try {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      globalArgs: { dbPath, swampBinPath: "swamp" },
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push(data);
        return Promise.resolve({ name });
      },
    };
    const base = {
      id: "same-share-id",
      title: "",
      text: "",
      principal: "p",
      source: "android-share",
      device: "",
      sharedAt: "",
      receivedAt: "",
    };

    await model.methods.store.execute(
      { ...base, url: "https://example.com/one" },
      ctx,
    );
    await model.methods.store.execute(
      { ...base, url: "https://example.com/two" },
      ctx,
    );

    assertEquals(written[0].inserted, true);
    assertEquals(written[1].inserted, true);

    const db = await openDatabase(dbPath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS total FROM links").get() as {
        total: number;
      };
      assertEquals(Number(row.total), 2);
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openDatabase migrates a legacy id-only table", async () => {
  const dir = await Deno.makeTempDir({ prefix: "linkdrop-migrate-" });
  const dbPath = `${dir}/links.db`;

  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE links (
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
    legacy.prepare(`
      INSERT INTO links (id, url, title, received_at)
      VALUES (?, ?, ?, ?)
    `).run(
      "legacy-id",
      "https://example.com/legacy",
      "",
      "2026-10-27T09:00:00Z",
    );
    legacy.close();

    const db = await openDatabase(dbPath);
    try {
      const row = db.prepare(
        "SELECT id, share_id, url FROM links",
      ).get() as { id: string; share_id: string; url: string };
      assertEquals(row.id, "legacy-id");
      assertEquals(row.share_id, "legacy-id");
      assertEquals(row.url, "https://example.com/legacy");
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("escapeHtml escapes text and attributes", () => {
  assertEquals(
    escapeHtml('<a href="x&y">\'</a>'),
    "&lt;a href=&quot;x&amp;y&quot;&gt;&#39;&lt;/a&gt;",
  );
});

Deno.test("renderLinksHtml writes a standalone escaped page", () => {
  const html = renderLinksHtml([
    {
      id: "share-1",
      url: "https://example.com/?a=1&b=2",
      title: "<script>alert(1)</script>",
      text: "",
      principal: "p",
      source: "android-share",
      device: "",
      shared_at: "",
      received_at: "2026-10-27T09:00:00Z",
    },
  ], {
    title: "Links & things",
    dbPath: "/tmp/links.db",
    generatedAt: "2026-10-27T09:01:00Z",
    truncated: false,
  });
  assertEquals(html.includes("<title>Links &amp; things</title>"), true);
  assertEquals(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
  assertEquals(html.includes("https://example.com/?a=1&amp;b=2"), true);
  assertEquals(html.includes("<script>alert(1)</script>"), false);
});

Deno.test("renderHtml writes links.html from the current table", async () => {
  const dir = await Deno.makeTempDir({ prefix: "linkdrop-render-" });
  const dbPath = `${dir}/links.db`;
  const outputPath = `${dir}/links.html`;

  try {
    const written: Record<string, unknown>[] = [];
    const ctx = {
      globalArgs: { dbPath, swampBinPath: "swamp" },
      writeResource: (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push(data);
        return Promise.resolve({ name });
      },
    };
    await model.methods.store.execute({
      id: "share-1",
      url: "https://example.com/one",
      title: "One",
      text: "",
      principal: "p",
      source: "android-share",
      device: "",
      sharedAt: "",
      receivedAt: "",
    }, ctx);
    await model.methods.renderHtml.execute({
      outputPath,
      limit: 10,
      title: "Test links",
      dbPath: "",
    }, ctx);

    const html = await Deno.readTextFile(outputPath);
    assertEquals(html.includes("https://example.com/one"), true);
    assertEquals(html.includes("One"), true);
    assertEquals(written[1].count, 1);
    assertEquals(written[1].path, outputPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
