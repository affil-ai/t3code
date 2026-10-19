import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { nextRequest, baselineFor } from "./worker.mjs";
const test = NodeTest.default;
const assert = NodeAssert.default;

test("pull worker excludes old requests, downgrades, and other release trains", () => {
  const queue = [61, 62, 63].map((n) => ({ version: `0.1.0-stable.fork.${n}` }));
  queue.push({ version: "0.2.0-stable.fork.1" });
  assert.equal(nextRequest(queue, "0.1.0-stable.fork.60", "0.1.0-stable.fork.62"), queue[1]);
  assert.equal(nextRequest(queue, "0.1.0-stable.fork.62", "0.1.0-stable.fork.62"), queue[2]);
  assert.equal(nextRequest(queue, "0.1.0-stable.fork.63", "0.1.0-stable.fork.62"), undefined);
});
test("future releases use installed provenance and never reuse an obsolete bootstrap baseline", () => {
  const bootstrap = { version: "0.1.0-stable.fork.60", commit: "a".repeat(40) };
  assert.equal(
    baselineFor({ version: bootstrap.version, commit: null }, bootstrap),
    bootstrap.commit,
  );
  assert.equal(
    baselineFor({ version: "0.1.0-stable.fork.62", commit: "b".repeat(40) }, bootstrap),
    "b".repeat(40),
  );
  assert.throws(
    () => baselineFor({ version: "0.1.0-stable.fork.62", commit: null }, bootstrap),
    /unknown/,
  );
});
