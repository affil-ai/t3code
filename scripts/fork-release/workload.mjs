// Read-only classification. JSON type must be boolean true, not 1 or "true".
export const workloadSql =
  "select status,json_extract(payload_json,'$.status') as payload_status," +
  "json_type(payload_json,'$.queueHeld') as hold_type,count(*) as count " +
  "from orchestration_v2_projection_runs GROUP BY status,payload_status,hold_type";

export function classifyWorkload(rows) {
  if (!Array.isArray(rows)) throw Error("Workload state unavailable");
  const counts = { running: 0, starting: 0, queued: 0, waiting: 0, heldQueued: 0 };
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
  for (const row of rows) {
    if (
      !row ||
      row.payload_status !== row.status ||
      ![null, "true", "false"].includes(row.hold_type) ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1
    )
      throw Error("Malformed workload state");
    if (terminal.has(row.status)) continue;
    if (!["running", "starting", "queued", "waiting", "preparing"].includes(row.status)) {
      throw Error("Unknown workload status");
    }
    const key =
      row.status === "queued" && row.hold_type === "true"
        ? "heldQueued"
        : row.status === "preparing"
          ? "starting"
          : row.status;
    counts[key] += row.count;
    if (!Number.isSafeInteger(counts[key])) throw Error("Workload count overflow");
  }
  return counts;
}
