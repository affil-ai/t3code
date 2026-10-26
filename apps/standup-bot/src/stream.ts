import WebSocket from "ws";
import type { Log, OpenMeetingStream, ReportFailure } from "./service.ts";
import { parseVexaFrame } from "./vexa.ts";

const PING_INTERVAL_MS = 25_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Subscribes to Vexa's `/ws` multiplex for one Meet code and reconnects until closed. */
export function vexaStreamOpener(options: {
  url: string;
  apiKey: string;
  log: Log;
  reportFailure: ReportFailure;
}): OpenMeetingStream {
  return ({ occurrenceId, meetCode, onFrame, onConnected }) => {
    let closed = false;
    let socket: WebSocket | null = null;
    let ping: NodeJS.Timeout | null = null;
    let retry: NodeJS.Timeout | null = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(options.url, { headers: { "X-API-Key": options.apiKey } });
      socket = ws;
      ws.on("open", () => {
        attempt = 0;
        ws.send(
          JSON.stringify({
            action: "subscribe",
            meetings: [{ platform: "google_meet", native_id: meetCode }],
          }),
        );
        ping = setInterval(() => ws.send(JSON.stringify({ action: "ping" })), PING_INTERVAL_MS);
        onConnected();
      });
      ws.on("message", (data) => {
        const frame = parseVexaFrame(data.toString());
        if (frame) onFrame(frame);
      });
      ws.on("error", (error) => {
        options.log("stream_socket_error", { occurrenceId, error: String(error) });
        options.reportFailure({
          operation: "standup_stream_socket",
          error,
          kind: "thrown_error",
          properties: { occurrence_id: occurrenceId },
        });
      });
      ws.on("close", (code) => {
        if (ping) clearInterval(ping);
        ping = null;
        if (closed) return;
        const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        attempt++;
        options.log("stream_reconnecting", { meetCode, code, delayMs: delay });
        retry = setTimeout(connect, delay);
      });
    };

    connect();
    return {
      close() {
        closed = true;
        if (ping) clearInterval(ping);
        if (retry) clearTimeout(retry);
        socket?.close();
      },
    };
  };
}
