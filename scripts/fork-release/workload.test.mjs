import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeSqlite from "node:sqlite";
import { classifyWorkload, workloadSql } from "./workload.mjs";
import { assertIdle } from "./release-check.mjs";

function fixture(records) {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec("CREATE TABLE orchestration_v2_projection_runs(status TEXT,payload_json TEXT)");
  for (const [status, payload] of records)
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?,?)").run(status, payload);
  return db;
}
NodeTest.test("held requests are preserved and reported but do not block idle", () => {
  const db = fixture(
    Array.from({ length: 18 }, () => [
      "queued",
      JSON.stringify({ status: "queued", queueHeld: true, userMessageId: "preserved" }),
    ]),
  );
  try {
    const before = db.prepare("SELECT * FROM orchestration_v2_projection_runs").all();
    const counts = classifyWorkload(db.prepare(workloadSql).all());
    NodeAssert.equal(counts.heldQueued, 18);
    NodeAssert.equal(counts.queued, 0);
    assertIdle(counts);
    NodeAssert.deepEqual(
      db.prepare("SELECT * FROM orchestration_v2_projection_runs").all(),
      before,
    );
  } finally {
    db.close();
  }
});
for (const status of ["running", "starting", "waiting", "preparing", "queued"]) {
  for (const held of [undefined, false, true]) {
    NodeTest.test(`${status} held=${held} remains blocking unless explicitly queued+held`, () => {
      const db = fixture([[status, JSON.stringify({ status, queueHeld: held })]]);
      try {
        const counts = classifyWorkload(db.prepare(workloadSql).all());
        if (status === "queued" && held === true) assertIdle(counts);
        else NodeAssert.throws(() => assertIdle(counts), /Busy/);
      } finally {
        db.close();
      }
    });
  }
}
for (const payload of [
  "{",
  '{"status":"queued","queueHeld":1}',
  '{"status":"queued","queueHeld":"true"}',
  '{"status":"queued","queueHeld":null}',
  '{"status":"queued","queueHeld":{}}',
  '{"queueHeld":true}',
  '{"status":"completed"}',
]) {
  NodeTest.test(`fails closed for malformed payload ${payload}`, () => {
    const db = fixture([["queued", payload]]);
    try {
      NodeAssert.throws(() => classifyWorkload(db.prepare(workloadSql).all()));
    } finally {
      db.close();
    }
  });
}
NodeTest.test("unknown status and unavailable/malformed observations fail closed", () => {
  for (const rows of [
    null,
    {},
    [{ status: "mystery", payload_status: "mystery", hold_type: null, count: 1 }],
    [{ status: "queued", payload_status: "queued", hold_type: "true", count: "1" }],
  ]) {
    NodeAssert.throws(() => classifyWorkload(rows));
  }
});
