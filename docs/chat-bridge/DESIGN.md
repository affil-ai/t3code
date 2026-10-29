# Chat bridge

Status: step 1 spike, Slack only. Server and web changes, fork-only.

A Slack user mentions the bot in a mapped channel. T3 starts a thread in that
channel's project and binds the Slack thread to it. Later replies in the Slack
thread steer the run in flight, or queue behind it if the settings say so.
Files people attach become T3 attachments, and the agent can send files back
with the `chat_post` tool. When a run finishes, its final answer is posted
back to the Slack thread. The bridge uses the Vercel Chat SDK (`chat`
plus `@chat-adapter/slack`), so adding a second platform means adding an
adapter, not new plumbing.

## Components

All server code is in `apps/server/src/chatBridge/`. There are three layers,
and only `ChatBridgeService` knows about the other two.

| Layer         | Files                                                                  | Knows about                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat SDK side | `SlackChatHost.ts`, `SqliteChatState.ts`, `slackManifest.ts`           | The `Chat` instance, the Slack adapter, and the SDK's state. Turns SDK messages into `ChatInboundEvent` and posts `ChatOutboundReply`. Nothing about T3. |
| Core          | `ChatBridgeCore.ts`, `ChatBindingStore.ts`, `ChatBridgeConfigStore.ts` | Allowlist, channel→project map, bindings, and reply claims. Talks to T3 only through the `ChatThreads` port. No Chat SDK imports.                        |
| T3 side       | `ChatThreadsLive.ts`, `ChatFileImport.ts`                              | Implements `ChatThreads` with `ThreadLaunchService` and `ThreadManagementService`, and stores chat files as pending attachments.                         |
| Runtime       | `ChatBridgeService.ts`, `runtimeLayer.ts`, `http.ts`, `rpc.ts`         | Host lifecycle, secrets, the run-completion reactor, the hook route, and the settings RPCs.                                                              |

The internal contract between the layers is three plain types in
`ChatBridgeCore.ts`:

- `ChatInboundEvent`: event id, chat thread key (`slack:C…:ts`), channel,
  `mention` or `follow_up`, author, text, files (name, type, size and a
  download function), and the people the message mentions with their ids.
- `ChatInboundOutcome`: `started`, `followed_up` (started, queued or steered),
  or `ignored` with a reason.
- `ChatOutboundReply`: chat thread key, run id, and text.

The agent's side is the `chat_post` MCP tool in
`apps/server/src/mcp/toolkits/chatBridge/`. It posts text, files or both to
the chat thread bound to the calling thread.

`packages/contracts/src/chatBridge.ts` holds only what the web app and server
share: the settings shape, the status, and the three RPCs. These are
`chatBridge.getStatus`, `chatBridge.updateSlackConfig` and
`chatBridge.setSlackSecret`, and all three require `auth:settings:write`.

## Data model

Fork tables use the `chat_bridge_` prefix and are created at service start,
outside the numbered migrations.

- `chat_bridge_config(platform, config_json)` stores the settings: enabled,
  transport, channel→project rows, and allowed member IDs.
- `chat_bridge_binding(chat_thread_key, project_id, thread_id UNIQUE, …)` maps
  one Slack thread to one T3 thread, in both directions.
- `chat_bridge_reply(run_id)` records claimed replies, so each run answers once
  even if `run.updated` repeats.
- `chat_bridge_owed_reply(run_id, chat_thread_key)` records runs a chat
  follow-up joined without starting, such as a steer into a run someone
  started in T3. Those runs answer in Slack too.
- `chat_bridge_state_*` is the Chat SDK `StateAdapter`: subscriptions, locks,
  the dedupe cache, lists and queues. It replaces Redis. Locks and
  set-if-absent are single SQLite upserts, so they stay atomic without a
  transaction.

### Idempotency

A message's command id and message id are both `chat-bridge:<slack event id>`.
If Slack redelivers a message, or the server crashes between launching the
thread and saving the binding, the retry replays the command receipt instead of
starting a second run.

The reactor answers runs whose `userMessageId` carries that prefix, and runs in
`chat_bridge_owed_reply`. Runs the user started from the app, with no Slack
message in them, stay out of Slack.

## Flow

1. **Mention.** If the author is allowed and the channel is mapped,
   `ThreadLaunchService.launch` starts the thread:
   - workspace: the project root;
   - model: the project default, or the server default if the project has none;
   - runtime mode: the server's `defaultRuntimeMode`.

   The bridge then inserts the binding and calls `thread.subscribe()`.

2. **Follow-up** (`onSubscribedMessage`). If the Slack thread is bound, the
   message is sent with `sendToThread`. The `followUpMode` setting picks how:
   - `steer` (the default) uses mode `auto`. It joins the run in flight, whose
     single answer then covers both messages, and starts a run when the thread
     is idle.
   - `queue` runs the message after the current run ends, so each message
     gets its own answer.

   With the SDK's `queue` concurrency, messages that arrived during a handler
   come in `context.skipped`, and each is forwarded.

   **Files.** Before sending, the bridge downloads each Slack file with the
   bot token (`files:read`) and stores it as a pending attachment, as a
   composer upload would. Supported images up to 10 MB go to the model as
   images; anything else up to 50 MB goes as a file. Files that are too large,
   empty or fail to download are listed in the turn text with the reason.

   **Mentions.** Slack text names people by display name only. The host reads
   the `<@U…>` ids from the raw message, looks up their names, and the turn
   lists them as `Name (<@U…>)`. The first turn tells the agent to write
   `<@USERID>` to mention someone, and that `chat_post` sends files.

3. **Answer.** `ChatBridgeService` follows `streamDomainEvents`. For each
   terminal `run.updated`, it claims the reply and posts the root node's last
   assistant message. A failed, cancelled or rolled-back run posts a fixed
   one-line notice instead. If the post fails, the claim is released.

## Ingress: Socket Mode or Events API

**Finding:** `@chat-adapter/slack` supports Socket Mode. With
`mode: "socket"` and an app-level token (`xapp-`, scope `connections:write`),
`chat.initialize()` opens a persistent Socket Mode connection and acks each
event as it arrives. It needs no public URL.

Webhook mode goes through T3 Connect. The bridge registers the reserved hook id
`chat-slack` on the existing `/api/hooks/:hookId/:token` route. The relay
already forwards `/v1/hooks/<endpointKey>/…` there, and while the environment
is online it passes the response straight back to Slack, so Slack's
`url_verification` works. The token is a random secret checked in constant
time. The adapter checks Slack's signature and its five-minute timestamp
window.

While the environment is offline, the relay queues requests for up to 24 hours.
When those replays arrive they fail the timestamp check, and Slack has already
given up on them. Events sent during an outage are lost on this path.

**Recommendation:** make Socket Mode the default, as the spike does. T3 is a
long-running process on a laptop or a home server, usually behind NAT. With
Socket Mode, Slack works without T3 Connect, and Slack redelivers events missed
during a short disconnect. It has two costs:

- It needs a third secret.
- Slack splits events across every open connection for an app, so each T3
  environment needs its own Slack app.

The manifest generator handles both transports, so switching is a settings
change plus a reinstall.

## Security

- **Who can act.** Only Slack member IDs on the allowlist start or continue
  work. Everyone else is ignored and gets no reply. Messages from the bot and
  from other bots are dropped in the host. An empty allowlist ignores everyone.
- **What runs can do.** Slack-started runs use the server's default runtime
  mode, which is usually full access. The allowlist is therefore the trust
  boundary: an allowed member is as trusted as someone using the app.
- **Request authenticity.**
  - Webhook: a constant-time check of the hook token, then the adapter's HMAC
    signature and timestamp check.
  - Socket Mode: the authenticated WebSocket that the app token opens.
- **Secrets.** All Slack secrets live in `ServerSecretStore` and are never
  returned to clients. The status RPC reports only whether each one is set.
  Secrets are passed explicitly to the adapter, so it never falls back to
  `SLACK_*` environment variables. The adapter's own logger is silenced
  because it can log request details.

  | Name                               | Use                      |
  | ---------------------------------- | ------------------------ |
  | `chat-bridge-slack-bot-token`      | Bot token (`xoxb-`)      |
  | `chat-bridge-slack-app-token`      | Socket Mode (`xapp-`)    |
  | `chat-bridge-slack-signing-secret` | Webhook HMAC             |
  | `chat-bridge-slack-hook-token`     | Hook URL path, generated |

- **Scope.** Changing settings or secrets requires `auth:settings:write`.

## Build order

1. **Step 1, this spike.**
   - Mention → thread, binding, queued follow-ups, final answer posted back.
   - SQLite state adapter, secrets, and a settings section with the manifest,
     channel map and allowlist.
2. **Step 2.**
   - Done: follow-ups steer by default; Slack files import as attachments;
     `chat_post` sends text and workspace files; mentions carry user ids.
   - `chat_react` beside `chat_post` in the `chatBridge` toolkit. Both act on
     the calling thread's bound chat thread only; `chat_post` is listed to
     every thread today and refuses an unbound one.
   - 👀 on receipt and ✅ or ❌ at the end (the manifest already asks for
     `reactions:write`).
   - Stream the answer with `thread.post(asyncIterable)`.
   - A startup sweep that posts answers for runs that finished while the host
     was down.
3. **Step 3.**
   - A second platform, for example Teams or Discord. This means a new host
     file next to `SlackChatHost.ts` and a `platform` column that already
     exists. The core does not change.

## Open questions for Vivek

1. **Default transport.** Socket Mode is the default (see the recommendation).
   Should webhook be offered only once T3 Connect is on?
2. **Runtime mode for Slack-started runs.** Should they inherit the server
   default, as they do now, or be forced to a sandboxed mode or a per-channel
   setting?
3. **DMs.** Step 1 handles channel mentions only. Should a DM with the bot map
   to a default project?
4. **Restart gap.** A run that finishes while the bridge is stopped gets no
   reply until the step 2 sweep. Is that acceptable for the spike?
5. **Files outside the workspace.** `chat_post` sends only files inside the
   thread's workspace, and resolves symlinks before checking. Should it also
   accept the thread's own attachments or a temp directory?
6. **Who is "the user".** Threads are created with `createdBy: "user"`. Do we
   want a distinct creation source so Slack threads are labeled in the sidebar?
