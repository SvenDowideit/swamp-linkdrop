import { assertEquals } from "jsr:@std/assert@1";

import { webhook } from "./linkdrop_open.ts";

Deno.test("open webhook accepts any request", () => {
  const handler = webhook.createHandler({});
  assertEquals(handler.requiredHeaders, []);
  assertEquals(handler.verify(new Uint8Array(), new Headers(), "unused"), true);
});
