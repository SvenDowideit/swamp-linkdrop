import { assertEquals } from "jsr:@std/assert@1";

import {
  behavior,
  expandHome,
  openDatabase,
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
      resolveDbPath({ dbPath: "" }),
      "/tmp/linkdrop-swamp-home/linkdrop/links.db",
    );
    assertEquals(
      resolveDbPath({ dbPath: "~/custom.db" }),
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
      globalArgs: { dbPath },
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

    await behavior.methods.store.execute(args, ctx);
    await behavior.methods.store.execute(args, ctx);

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
