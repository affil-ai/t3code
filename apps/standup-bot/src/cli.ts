/**
 * Standup transcription bot.
 *
 *   standup-bot migrate
 *   standup-bot series add --name Standup --meeting-url https://meet.google.com/abc-defg-hij \
 *     --weekdays mon,tue,wed,thu,fri --time 09:30 --time-zone America/Los_Angeles
 *   standup-bot series list | series disable <id> | series enable <id>
 *   standup-bot occurrences [--limit 20]
 *   standup-bot transcript <occurrence-id>
 *   standup-bot stop <occurrence-id>     # the bot leaves and transcription stops
 *   standup-bot run                      # scheduler + live transcript consumer
 *
 * Environment: STANDUP_DATABASE_URL, VEXA_API_KEY, VEXA_API_URL (defaults to
 * the Vexa Lite gateway at http://localhost:8056), and POSTHOG_API_KEY
 * for failure reporting.
 */
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import pg from "pg";
import { PostHog } from "posthog-node";
import { parseStandupSchedule, WEEKDAYS } from "./schedule.ts";
import { createStandupService, type Log, type ReportFailure } from "./service.ts";
import { createStore } from "./store.ts";
import { vexaStreamOpener } from "./stream.ts";
import { createVexaClient, googleMeetCode } from "./vexa.ts";

const TICK_INTERVAL_MS = 15_000;

const log: Log = (event, fields = {}) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
};

// Absorbed failures go to PostHog as exceptions. Properties carry ids and
// reasons only, never transcript text or speaker names.
const postHogKey = process.env.POSTHOG_API_KEY?.trim();
const posthog = postHogKey
  ? new PostHog(postHogKey, { host: "https://us.i.posthog.com", flushAt: 1, flushInterval: 0 })
  : null;
const pendingReports = new Set<Promise<void>>();
const reportFailure: ReportFailure = ({ operation, error, kind, properties }) => {
  if (!posthog) {
    log("failure_not_reported", { operation, reason: "POSTHOG_API_KEY is not configured" });
    return;
  }
  const report = posthog
    .captureExceptionImmediate(error, "standup-bot", {
      ...properties,
      failure_kind: kind,
      operation,
      auth_kind: "system",
      source: "standup-bot",
    })
    .catch((reportingError: unknown) =>
      log("failure_report_failed", { operation, error: String(reportingError) }),
    );
  pendingReports.add(report);
  void report.finally(() => pendingReports.delete(report));
};

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "meeting-url": { type: "string" },
    weekdays: { type: "string" },
    time: { type: "string" },
    "time-zone": { type: "string" },
    limit: { type: "string" },
  },
});

const pool = new pg.Pool({ connectionString: required("STANDUP_DATABASE_URL") });
const store = createStore({ query: (text, params) => pool.query(text, params) });

try {
  await main(positionals);
} finally {
  await Promise.all(pendingReports);
  await posthog?.shutdown();
  await pool.end();
}

async function main([command, subcommand, argument]: string[]) {
  switch (command) {
    case "migrate":
      await store.migrate();
      return log("migrated");
    case "series":
      return seriesCommand(subcommand, argument);
    case "occurrences": {
      const limit = Number(values.limit ?? 20);
      for (const item of await store.listRecentOccurrences(limit)) {
        console.log(
          [item.id, item.scheduledStart.toISOString(), item.status, item.reason ?? ""].join("\t"),
        );
      }
      return;
    }
    case "transcript": {
      for (const segment of await store.listSegments(
        requiredArgument(subcommand, "occurrence id"),
      )) {
        const at = segment.startSeconds.toFixed(1).padStart(7);
        console.log(`[${at}s] ${segment.speaker ?? "(unattributed)"}: ${segment.text}`);
      }
      return;
    }
    case "stop": {
      const service = createStandupService({
        store,
        vexa: vexaClient(),
        openStream: noStream,
        reportFailure,
        log,
      });
      const occurrence = await service.stop(requiredArgument(subcommand, "occurrence id"));
      return log("stop_result", { occurrenceId: occurrence?.id, status: occurrence?.status });
    }
    case "run":
      return run();
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. See src/cli.ts for usage.`);
  }
}

async function seriesCommand(subcommand: string | undefined, argument: string | undefined) {
  switch (subcommand) {
    case "add": {
      const meetingUrl = requiredOption("meeting-url");
      const series = await store.addSeries({
        name: requiredOption("name"),
        meetingUrl,
        meetCode: googleMeetCode(meetingUrl),
        schedule: parseStandupSchedule({
          weekdays: requiredOption("weekdays")
            .split(",")
            .map((day) => day.trim().toLowerCase()),
          startTime: requiredOption("time"),
          timeZone: requiredOption("time-zone"),
        }),
      });
      return log("series_added", { seriesId: series.id });
    }
    case "list":
      for (const series of await store.listSeries()) {
        const { weekdays, startTime, timeZone } = series.schedule;
        console.log(
          [
            series.id,
            series.name,
            series.meetingUrl,
            weekdays.join(","),
            startTime,
            timeZone,
            series.enabled ? "enabled" : "disabled",
          ].join("\t"),
        );
      }
      return;
    case "disable":
    case "enable":
      await store.setSeriesEnabled(
        requiredArgument(argument, "series id"),
        subcommand === "enable",
      );
      return log(`series_${subcommand}d`, { seriesId: argument });
    default:
      throw new Error(
        `Unknown series command. Use add, list, enable, or disable. Weekdays: ${WEEKDAYS.join(",")}`,
      );
  }
}

async function run() {
  const vexa = vexaClient();
  const service = createStandupService({
    store,
    vexa,
    openStream: vexaStreamOpener({
      url: vexa.streamUrl(),
      apiKey: vexa.apiKey,
      log,
      reportFailure,
    }),
    reportFailure,
    log,
  });
  await store.migrate();
  log("standup_bot_started", { tickIntervalMs: TICK_INTERVAL_MS });
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  while (!shutdown.signal.aborted) {
    await service.tick().catch((error) => {
      log("tick_failed", { error: String(error) });
      reportFailure({ operation: "standup_tick", error, kind: "thrown_error" });
    });
    // Resolves early on shutdown instead of waiting out the interval.
    await NodeTimersPromises.setTimeout(TICK_INTERVAL_MS, undefined, {
      signal: shutdown.signal,
    }).catch(() => undefined);
  }
  service.close();
}

function vexaClient() {
  return createVexaClient({
    apiUrl: process.env.VEXA_API_URL?.trim() || "http://localhost:8056",
    apiKey: required("VEXA_API_KEY"),
  });
}

function noStream() {
  return { close() {} };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredOption(name: "name" | "meeting-url" | "weekdays" | "time" | "time-zone") {
  const value = values[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requiredArgument(value: string | undefined, label: string) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
