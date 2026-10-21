# @t3work/convex-t3-bridge

A [Convex component](https://docs.convex.dev/components) that connects a
Convex app to T3 Code agents through T3's MCP server. Your app sends messages
to a conversation. The component delivers them to a T3 thread, watches the
thread, and calls your app back with progress, the agent's messages, replies,
and turn endings. Agents can also reply on their own through a small MCP
`reply` tool that your app serves.

The component owns only the T3 side:

- the mapping from conversations to T3 threads;
- a durable outbox to T3;
- the thread watcher;
- reply intake.

Your app keeps its chat UI, Slack or other channels, auth, prompts, and its
own message tables.

```
your app ──send()──▶ outbox ──t3_thread_send / t3_thread_launch──▶ T3 thread
your app ◀─onEvent── watcher ◀──────t3_thread_read / t3_thread_list── T3 thread
your app ◀─onEvent── reply intake ◀── POST /your-route (MCP tool "reply") ── agent
```

## Install

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import t3Bridge from "@t3work/convex-t3-bridge/convex.config";

const app = defineApp();
app.use(t3Bridge);
export default app;
```

```ts
// convex/t3.ts
import { T3Bridge, vT3BridgeEvent } from "@t3work/convex-t3-bridge";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

export const t3 = new T3Bridge(components.t3Bridge, {
  config: internal.t3.config,
  onEvent: internal.t3.onEvent,
});

// Components cannot read environment variables, so the component asks your
// app for its configuration each time it needs it. Nothing here is stored.
export const config = internalQuery({
  args: {},
  handler: () => ({
    t3McpUrl: process.env.T3_MCP_URL!, // e.g. https://t3.example.com/mcp
    t3McpToken: process.env.T3_MCP_TOKEN!, // a T3 MCP client bearer token
    replyKeySecret: process.env.T3_BRIDGE_REPLY_SECRET!, // signs reply keys
  }),
});

export const onEvent = internalMutation({
  args: { event: vT3BridgeEvent },
  handler: async (ctx, { event }) => {
    // Write to your tables, post to Slack, update a status line, ...
  },
});
```

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { t3 } from "./t3";

const http = httpRouter();
t3.registerReplyRoute(http, {
  path: "/t3-reply",
  // The bearer token agents present. Checked before any component call.
  authorize: (request) =>
    request.headers.get("authorization") === `Bearer ${process.env.T3_BRIDGE_MCP_TOKEN}`,
});
export default http;
```

Register `https://<deployment>.convex.site/t3-reply` as an MCP server for the
agents that T3 runs, with that bearer token in the `Authorization` header. The
MCP server exposes one tool, `reply`.

## Use

```ts
await t3.send(ctx, {
  conversationKey: "slack:C123:1712345678.000100",
  text: "What changed in the last release?",
  attachments: [{ filename: "log.txt", mimeType: "text/plain", url, byteSize, sha256 }],
  // Used only when the conversation has no T3 thread yet.
  launch: {
    projectId: "…",
    title: "Release question",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    workspaceStrategy: { type: "root" },
    // Standing instructions sent once, with the first message.
    instructions: "Answer in your final message. Use the reply tool only for …",
  },
});

await t3.cancel(ctx, { conversationKey });
await t3.importThread(ctx, { conversationKey, threadId }); // adopt an existing T3 thread
const state = await t3.getConversation(ctx, { conversationKey });
```

`send` and `cancel` work from a mutation. `importThread` is an action, because
it reads the thread's current end from T3 so that old history is not
replayed. Use it to backfill threads that another system created.

Every message the component sends carries a short routing header with the
conversation's reply key. The agent passes that key to the `reply` tool, which
is how a reply finds its conversation. Keys are HMACs of the conversation and
a per-conversation nonce. They are never stored in plain text, and are rotated
by `t3.rotateReplyKey(ctx, { conversationKey })`.

## Events

`onEvent` receives one of these, each with a `conversationKey`:

| `type`             | When                                                       | Delivery    |
| ------------------ | ---------------------------------------------------------- | ----------- |
| `turnStarted`      | A T3 run began, from `send` or on its own (a wake)         | durable     |
| `activity`         | A tool call, command or other work item changed            | best effort |
| `assistantMessage` | The agent wrote a message during a turn                    | durable     |
| `turnEnded`        | The run finished; includes `status` and `finalText`        | durable     |
| `reply`            | The agent called the `reply` tool; `final` ends the answer | durable     |
| `deliveryFailed`   | A `send` could not be delivered after retries              | durable     |
| `watchFailed`      | The watcher hit a permanent error for the thread           | durable     |

Durable events are delivered exactly once per T3 item, in thread order.
`turnStarted.origin` is `"send"` when the run answers a message you sent, and
`"background"` when the agent woke on its own. For a background run you
usually show only `reply` events, not `finalText`.

The `reply` tool rejects a second reply within 90 seconds in the same turn,
and an exact repeat of the previous reply. Files sent with `reply` are stored
in your app's file storage. The event carries their storage IDs.

## How it works

- **Outbox.** `send` inserts a row and schedules delivery. Delivery launches the
  thread on first use, or sends to it. Retries are idempotent because each row
  carries a stable `clientRequestId`. Attachments upload before the text.
- **Watcher.** While a conversation has a run in progress, a scheduled action
  reads the thread's activity about every 2 seconds. It holds a lease so that
  only one reader runs per thread.
- **Sweep.** About every 5 seconds, `t3_thread_list` finds watched threads that
  changed without a `send`, such as a wake from a PR watch or a subagent.
- **Cancel.** `cancel` marks pending outbox rows skipped and interrupts the
  active run with `t3_thread_interrupt`.

## Develop

```sh
cd packages/convex-t3-bridge
pnpm test        # component unit tests (convex-test)
pnpm build       # emits dist/ for publishing
```

`example/` is a small app that drives the component from a harness script and
from a Slack test channel. See `example/README.md`.
