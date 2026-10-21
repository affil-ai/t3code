import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const apiUrl = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const siteUrl = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
for (const address of [apiUrl, siteUrl]) {
  const url = new URL(address);
  NodeAssert.equal(url.protocol, "http:");
  NodeAssert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}
const client = new ConvexHttpClient(apiUrl, { logger: false });

// A successful cross-component query proves real deployment analysis accepted
// the component runtime and schema, which convex-test does not validate.
NodeTest.test("local app can query its installed component and indexed event table", async () => {
  const conversationKey = `phase1-health:${crypto.randomUUID()}`;
  NodeAssert.equal(await client.query(api.t3.getConversation, { conversationKey }), null);
  NodeAssert.deepEqual(await client.query(api.t3.listEvents, { conversationKey }), []);
});

NodeTest.test(
  "reply route rejects missing and unset-looking bearer tokens before component access",
  async () => {
    for (const authorization of [undefined, "Bearer undefined", "Bearer "]) {
      const response = await fetch(new URL("/t3-reply", siteUrl), {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      NodeAssert.equal(response.status, 401);
      NodeAssert.equal(await response.text(), "Unauthorized");
    }
  },
);
