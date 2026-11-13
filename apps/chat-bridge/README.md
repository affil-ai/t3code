# T3 chat bridge

Talk to T3 Code agents from Slack, Linear and iMessage. A message to the bot
starts a T3 thread, replies continue it, and the agent's final message comes
back as a normal reply.

> **This app is all you need.** `apps/chat-bridge` is a standalone Node app
> that runs against **stock, unmodified T3 Code**
> ([`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)). It talks to T3
> only through T3's MCP endpoint, the same one Claude and Codex use.
>
> The rest of this fork (`affil-ai/t3code`: Work mode, Firstmate and the other
> client and server changes) is **deprecated and not needed** for the bridge.
> Don't build or run the fork's server or desktop app. Install the workspace
> dependencies and start `apps/chat-bridge` against your own stock T3 server
> (see [Quick start](#quick-start)).

## Contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Prerequisites](#prerequisites): a stock T3 server, Node, signing in, projects
- [Slack](#slack)
- [Linear](#linear)
- [iMessage](#imessage)
- [Give the agents the chat tools](#give-the-agents-the-chat-tools)
- [Running always on](#running-always-on)
- [Config reference](#config-reference)
- [Resend a Slack message](#resend-a-slack-message)
- [Limits](#limits)
- [Development](#development)

## Quick start

```sh
git clone https://github.com/affil-ai/t3code.git
cd t3code
git checkout feat/chat-bridge-slack
pnpm install --filter "@t3tools/chat-bridge..."   # only the bridge's dependencies
cd apps/chat-bridge

node src/bin.ts login --t3-url http://127.0.0.1:3773   # once, see Prerequisites
# write ~/.t3-chat-bridge/config.json (see Config reference)
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… node src/bin.ts start
```

Each platform is optional: the bridge turns on Slack when its tokens are set,
and Linear and iMessage when their sections are in `config.json`. You can run
any one of them alone.

The commands are:

| Command                                  | What it does                                                   |
| ---------------------------------------- | -------------------------------------------------------------- |
| `node src/bin.ts login --t3-url URL`     | Signs the bridge in to T3 (OAuth) and saves the token.         |
| `node src/bin.ts manifest --name "NAME"` | Prints a Slack app manifest.                                   |
| `node src/bin.ts start`                  | Runs the bridge. `--config PATH` uses a config file elsewhere. |
| `node src/bin.ts resend-slack CH TS`     | Hands one Slack message to T3 again (bridge stopped).          |

`import-office` also exists; it belongs to the optional Office relay channel
(see [Config reference](#config-reference)) and you won't need it.

## What it does

These apply on every platform unless a section says otherwise.

- **A message starts a thread.** In Slack, a mention in a mapped channel or a
  direct message. In Linear, an agent session (a mention, or delegating or
  assigning an issue to the app). In iMessage, any message from an allowed
  person. The bridge launches a T3 thread in the configured project with the
  message, who sent it, and any attached files.
- **A mention inside a Slack thread brings the thread along.** The first turn
  includes the messages before the mention, oldest first, within 80,000
  characters (the newest are kept), with each author and their Slack id so the
  agent can tag them. Their files are imported with the mention's own. A
  mention with nothing after it asks the agent to act on those messages; with
  no messages above it, or after a bare model switch, the bot asks what to do.
  In a thread already bound to a chat, a bare mention asks the run to act on
  the latest messages.
- **Replies continue it.** A reply steers the run in flight, or starts a new
  run if the thread is idle.
- **Some replies are only context.** In Slack, a reply that starts with
  "aside", one that mentions another bot, and one from someone not allowed
  start no run. The agent sees them, up to the newest 50, with its next
  message. `@bot mute` in a thread makes the bot answer only messages that
  mention it; `@bot unmute` undoes it.
- **Status shows what the agent is doing.** While a run goes, the bridge reads
  T3's activity view every 2.5 seconds and shows what the agent is doing now,
  such as "Running `pnpm test`" or "Thinking…", at most 50 characters, with
  anything that looks like a secret redacted. In Slack this is the thread's
  agent status (`assistant.threads.setStatus`) and the agent session state
  (`processing`, `suspended` while T3 waits on a person, `active`); in Linear
  it is the session's thoughts.
- **Answers are normal replies.** When a run ends, its final message is posted
  in parts of up to 12,000 characters. A run that ends without a final
  message, or whose whole final message is `NO_REPLY`, posts nothing. A
  failed run posts a short notice.
- **Questions come to the chat.** When the agent asks a question, Slack gets a
  button per option (and Submit for multiple choice), Linear gets its own
  chooser for single choice, and other cases get numbered text. A typed reply
  answers too. The answer goes back through T3's `t3_pending_request` tool, so
  the same run carries on.
- **Permissions can't be granted from chat.** T3's tools can't approve a
  permission request, so a run that asks for one is stopped and the thread
  says why. Use `runtimeMode: "full-access"` (or `auto`) to make this rare.
- **Model switch.** `!opus`, `!sol-high`, `!high` and similar anywhere in a
  message pick the model and effort for that thread. The aliases and the
  models they map to are hard-coded in `src/modelCommand.ts`; edit them to
  match the providers your T3 server runs. New threads start on
  `modelSelection` from the config, or the project's default.
- **Results that arrive later.** When a run ends while subagents or background
  work are still going, the bridge keeps following the thread for up to six
  hours and posts each later answer once. The follow survives a restart.
- **Titles follow T3.** The bridge asks T3 to title each new thread, and the
  Slack thread takes T3's title.
- **Stop.** `@bot stop` in a Slack thread, Slack's own stop button, or
  Linear's "Send stop request" interrupts the run (`t3_thread_interrupt`).
- **Nothing is lost.** Each incoming message is saved to an inbox table in
  SQLite before the bridge acts on it, and each conversation's messages are
  handled in order. If T3 can't take a message, it is retried after 15 s,
  30 s, 1 min and so on, up to 10 min apart; after nine failed tries (about 36
  minutes) the bridge says so in the chat and drops it. T3 retry keys
  (`clientRequestId`) make a retried text message land once. **Messages with
  files are the exception on stock T3:** the bridge sends `clientRequestId` to
  `t3_thread_send_attachments` too, but stock T3 ignores it there, so if a
  send with files reached T3 and only its reply was lost, the retry can post
  that message to the T3 thread twice.
- **Restarts are safe.** After a restart the bridge works through what is left
  in the inbox and picks up runs it still owes a reply for. Slack catches up
  on messages sent while it was down (replies in threads bound in the last 14
  days, new mentions in mapped channels, and direct-message channels it has
  answered before). iMessage catches up from its saved Messages row id.

### How the agent posts files and reactions

Stock T3 doesn't tell an MCP server which thread is calling it, so the bridge
writes a random **chat key** for each conversation into the turn it sends.
The agent passes that key to the bridge's own MCP tools, `chat_post` (text and
files), `chat_react` and `chat_status`. The key is the permission: it reaches
only its own conversation, and `chat_post` reads files only inside that
thread's worktree or project folder. The tools are served on
`http://127.0.0.1:<toolsPort>/mcp`, on loopback only; see
[Give the agents the chat tools](#give-the-agents-the-chat-tools).

### Threads that start their own conversation

With `"startTools": true`, the bridge also serves `slack_start` (post an
opening message in a channel or DM and bind its thread) and `linear_start`
(open an agent session on a Linear issue, new or existing, and bind it). They
take a thread id and **no chat key**, and stock T3 can't tell the bridge who
is calling, so every agent on the T3 server can use them. They are off by
default; leave them off on a T3 server other people's chats run on.
`slack_start` posts only in a channel listed in `channelProjects`, or as a DM
to someone allowed to use the bot.

To start the conversation under a message that's already in the channel,
pass `slack_start` that message's `ts` as `replyTo`, such as
`1794278854.319499` (a permalink's `p1794278854319499` with a dot before the
last six digits). Use the thread's parent message, not a reply. The bridge
posts the text as a reply under that message and binds that Slack thread,
instead of posting a new opening message. `replyTo` needs a channel id (`C…`
or `G…`); it doesn't work with a DM or a member id.

### One thread, several chats

A thread that already has a chat can take more: `slack_start` and
`linear_start` add the new one and keep the others. Each chat has its own chat
key. A run's final message goes to the chat whose message started it; a run
T3 starts with a notification goes to the chat used most recently. Messages
aren't copied between chats. Pass `sync: true` to either tool to post every
final message to all of the thread's chats and copy each chat's messages into
the others (`sync: false` turns that off). `chat_unlink` takes a chat key and
disconnects that chat: nothing more is posted there, and a new mention there
starts a new thread.

## Prerequisites

### A stock T3 server

Run an ordinary T3 Code server from
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code), on the same machine
as the bridge (the chat tools are on loopback, and `chat_post` reads files by
path). Its address is `t3Url` in the config, for example
`http://127.0.0.1:3773`. The bridge doesn't start T3; it connects to
`<t3Url>/mcp`.

Before routing chats to it:

- **Providers work.** Sign in Claude and/or Codex in T3's settings and check
  that a thread started from T3's own UI runs.
- **Each project has a default model**, or set `modelSelection` in the
  bridge config.
- **Title generation works**, if you want summary titles in Slack.

### Node and pnpm

Node 24 or later (for `node:sqlite` and running TypeScript directly) and pnpm.

### Sign the bridge in to T3

The bridge uses T3's MCP OAuth flow, like any MCP client:

```sh
cd apps/chat-bridge
node src/bin.ts login --t3-url http://127.0.0.1:3773
```

It prints a link. Open it in a browser signed in to that T3 server, choose the
access level, and approve. T3 redirects to `http://127.0.0.1:3921/callback`,
where `login` is listening (`--callback-port` changes the port), so open the
link on the same machine or forward that port. The token is saved to
`t3-login.json` in the data directory with mode 0600.

- The access level you approve caps every thread the bridge starts. Agents
  that must edit files or run commands unattended need `full-access` or
  `auto`.
- The login is bound to the server's origin and lasts 30 days. T3 issues no
  refresh tokens, so run `login` again before it expires.
- To use an MCP token you already have instead, set `T3_TOKEN` when you run
  `start`.

### The data directory

The bridge keeps `config.json`, `t3-login.json` and its SQLite database
(`bridge.db`) in `~/.t3-chat-bridge`, or in `$T3_CHAT_BRIDGE_HOME` when that is
set. Back it up if you care about thread bindings.

### Choose T3 projects

Each conversation starts its thread in a T3 project. Find project ids in T3,
or with the `t3_project_list` MCP tool. Every route (a Slack channel, Slack
DMs, a Linear team, iMessage) takes a project id and, optionally:

- `worktreeFrom`: start each new thread in a new worktree from this branch on
  `origin` (such as `main`), instead of the project's own checkout;
- `note`: text added to the thread's first turn, such as limits on what the
  agent may do.

The bridge checks at start-up that every configured project exists.

## Slack

Slack connects over **Socket Mode**, so Slack needs no public URL.

### 1. Create the app

Print a manifest and create the app from it at <https://api.slack.com/apps> →
**Create New App** → **From a manifest**:

```sh
node src/bin.ts manifest --name "T3 Code"
```

The manifest turns on Socket Mode, interactivity (for question buttons),
Slack's agent features (`agent_view` and agent tasks) and the Messages tab, so
people can DM the bot. It asks for these bot scopes:

`app_mentions:read`, `assistant:write`, `channels:history`, `chat:write`,
`files:read`, `files:write`, `groups:history`, `im:history`,
`metadata.message:read`, `reactions:write`, `users:read`

and subscribes to these bot events:

`agent_session_stopped` (the stop button), `app_context_changed` (logged
only), `app_mention`, `message.channels`, `message.groups`, `message.im`

**Reactions, optional.** To pass people's emoji reactions to the agent as
context, also add the `reactions:read` scope and subscribe to
`reaction_added` and `reaction_removed`, then reinstall the app. A reaction
never starts a run.

### 2. Get the tokens

- **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
  This is `SLACK_BOT_TOKEN`.
- **Basic Information → App-Level Tokens**: create a token with the
  `connections:write` scope (`xapp-…`). This is `SLACK_APP_TOKEN`.

Set both as environment variables when you start the bridge. Never put them in
`config.json`.

### 3. Route channels and DMs

In `config.json`:

```json
{
  "t3Url": "http://127.0.0.1:3773",
  "channelProjects": [
    { "channelId": "C0123456789", "projectId": "<T3 project id>" },
    { "channelId": "C0123456789", "projectId": "<other project id>", "match": "[web]" }
  ],
  "dmProjectId": "<T3 project id>",
  "allowedUserIds": ["U0123456789"]
}
```

- `channelProjects`: which project a mention in each channel starts its thread
  in. A channel id is in the channel's **About** panel. A channel can have
  several entries; the first whose `match` text the message contains (any
  case) wins, and an entry without `match` takes every message. Each entry
  takes `worktreeFrom` and `note` too.
- `dmProjectId`: where direct messages start their threads. Without it, DMs
  are ignored. Each top-level DM is its own thread; reply under it to continue.
- `dmWorktreeFrom`: start each DM thread in a new worktree from this branch on
  `origin`, like a channel entry's `worktreeFrom`. Without it, DM threads run
  in the project's own checkout.
- Invite the bot to each mapped channel (`/invite @T3 Code`).

### 4. Decide who may use it

- **An allowlist (the default).** Only members in `allowedUserIds` (profile →
  **⋯** → **Copy member ID**). The same rule covers starting a thread,
  follow-ups, answering a question and stopping a run. Anyone else who
  mentions the bot gets a short reply, at most once an hour, with their member
  id to add.
- **Everyone in the workspace.** `"allowEveryone": true` also lets every full
  member use it. Guests, bots, deactivated accounts and people from other
  organizations in shared channels can't. The bridge checks each person with
  `users.info` and caches the answer for ten minutes.

**Risk:** every run has the bridge's T3 access. With `full-access`, anyone
allowed can run commands on the machine as the user T3 runs as. The bridge
logs a warning at start-up when `allowEveryone` is on.

### 5. Start

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… node src/bin.ts start
```

Run **one bridge per Slack app**: two processes on the same app token split
Slack's events between them.

## Linear

The agent works in Linear as an **app user** on Linear's Agents API
(`@chat-adapter/linear` in agent-sessions mode), so it shows natively in
issues.

### How it behaves

- **What starts a run:** an agent session. Mentioning the app in a comment
  (`@<botName> …`) starts one, and so does delegating or assigning an issue
  to it. Plain comments on an issue the agent already works on are kept as
  context for its next run and never answered.
- **One T3 thread per issue.** Every session on an issue continues the same
  thread. Each answer goes to the session the latest prompt came from.
- **What shows in Linear:** a "thought" as soon as a session gets a prompt,
  the run's status as thoughts, an "action" per finished step (such as "Ran
  `pnpm test`"), the agent's to-do list as the session plan, and the final
  message as the response, in Markdown. A quiet run whose session still shows
  the agent at work ends with "Done, nothing to add."
- **What the agent gets:** the prompt plus Linear's context for a new session
  (the issue, its description and comments). Images and files are downloaded
  with the bridge's token and arrive as files; signed links never reach the
  agent.
- **Files:** `chat_post` uploads files to Linear and links them in the
  response. Linear shows no reactions on session messages, so `chat_react`
  adds none.
- **Stop:** the session menu's "Send stop request" interrupts the run. The
  bridge checks Linear's signature before acting.

### 1. Create the OAuth application

In Linear: **Settings → API → OAuth applications → New**, in the workspace you
will use the agent in (a client-credentials token acts in the workspace that
owns the app).

- **Name:** what people will @mention. Put the same name in `linear.botName`.
- **Callback URL:** Linear requires one, but the bridge doesn't use it: it
  authenticates with the **client credentials** grant, as the app itself, so
  there is no OAuth redirect to host. Any URL you control is fine.
- **Client credentials:** turn this on.
- **Webhooks:** turn on, and set the URL to your public webhook URL (see
  [Webhook ingress](#webhook-ingress)), such as
  `https://bridge.example.com/linear/webhook`. Subscribe to:
  - **Agent session events** (required: new sessions, prompts and stop
    requests);
  - **Comments** (optional: plain comments as context).

The bridge requests these scopes for its token: `read`, `write`,
`comments:create`, `issues:create`, `app:mentionable` and `app:assignable`.
The last two make the app something people can @mention and assign or
delegate issues to.

Copy three values: the **client ID**, the **client secret** and the
**webhook signing secret**. They become `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. The bridge reads them from
the environment and removes them from its own environment at start-up.
Without all three, Linear stays off and its webhook answers 503.

### 2. Route teams

```json
"linear": {
  "botName": "my-agent",
  "webhookPort": 3930,
  "webhookPath": "/linear/webhook",
  "projectId": "<default T3 project id>",
  "worktreeFrom": "main",
  "teams": [{ "team": "ENG", "projectId": "<T3 project id>", "worktreeFrom": "main" }],
  "allowEveryone": true,
  "allowedUserIds": []
}
```

- **Default route:** `projectId` (required), plus optional `worktreeFrom` and
  `note`, at the top of the `linear` block. Issues of teams without their own
  entry start there.
- **Per-team routes:** `teams`, by team key (the `ENG` in `ENG-123`), each
  with its own `projectId`, `worktreeFrom` and `note`.
- `botName`: the app's name as people @mention it. It defaults to `"office"`
  (the name is historical), so set it.
- **Access:** `allowEveryone` is **on by default** for Linear: anyone in the
  workspace who can mention the app may use it. Set it to `false` to allow
  only `allowedUserIds` (Linear user ids).

### Webhook ingress

The bridge serves the webhook on loopback only, at
`http://127.0.0.1:<webhookPort><webhookPath>`. It answers POST at exactly that
path and 404 everywhere else, and checks Linear's signature and timestamp on
every request. Linear must reach it over public HTTPS, so put any HTTPS tunnel
or reverse proxy in front that forwards **only that path**. Two examples:

- **Tailscale Funnel:**

  ```sh
  sudo tailscale funnel --bg --https=8443 --set-path=/linear/webhook \
    http://127.0.0.1:3930/linear/webhook
  ```

  The webhook URL is then `https://<machine>.<tailnet>.ts.net:8443/linear/webhook`.
  `--bg` keeps it across restarts. Undo it with
  `sudo tailscale funnel --https=8443 --set-path=/linear/webhook off`.

- **Cloudflare Tunnel:** one ingress rule with `path: ^/linear/webhook$` and
  service `http://127.0.0.1:3930`, followed by the catch-all
  `http_status:404`.

**Only one bridge may own the webhook.** A Linear app has one webhook URL, and
each session's state lives in the bridge that received it. Don't point two
bridges at the same Linear app.

### 3. Start

```sh
LINEAR_CLIENT_ID=… LINEAR_CLIENT_SECRET=… LINEAR_WEBHOOK_SECRET=… \
  node src/bin.ts start
```

Linear's token fetch runs in the background and retries, so Slack and iMessage
never wait on it; until it succeeds the webhook answers 503 and Linear
redelivers.

## iMessage

The agent answers iMessages sent to a Mac's Messages account. Each
conversation is one ongoing T3 thread. Group chats work: every message goes to
the agent, which decides whether to answer. Photos and files arrive as
attachments (iPhone HEIC photos as JPEG), and the agent sends files with
`chat_post`. Answers are plain text. Only the services in `imessage.services`
are read (default `["iMessage"]`); SMS chats are left alone.

### How it connects

```text
Messages.app ← imsg rpc ← t3-imessage (Mac, 127.0.0.1:47821)
                                  ↑ SSH tunnel
                     bridge host 127.0.0.1:47821 ← chat bridge
```

- **On the Mac,** `mac/t3-imessage.swift` runs a pinned
  [`imsg`](https://github.com/openclaw/imsg) and serves a limited set of its
  JSON-RPC methods on `127.0.0.1:47821`. It also reads incoming
  attachments, only from the Messages attachments folder, and stages outgoing
  files. It serves one client at a time and a new connection replaces the old
  one, so don't probe it while the bridge is connected.
- **On the bridge's host,** an SSH tunnel forwards that port. The bridge
  reconnects by itself and catches up from its saved Messages row id.

### 1. Prepare the Mac

1. Use a Mac user signed in to Messages with the Apple Account the agent
   should answer as. A dedicated macOS user is a good idea.
2. Install `imsg` **v0.20.0** (its `v0.20.0` release), the version the
   service was written and reviewed against, for example to `~/.local/opt/imsg-0.20.0/imsg`.
3. Build the service, as that user:

   ```sh
   mkdir -p ~/Applications/t3-imessage
   swiftc -O -o ~/Applications/t3-imessage/t3-imessage mac/t3-imessage.swift
   ```

   Sign it with a stable identity (a Developer ID or a local code-signing
   certificate), not ad hoc, so a rebuild keeps its macOS permissions:
   `codesign --force --sign "<identity>" ~/Applications/t3-imessage/t3-imessage`.

4. **Grant permissions** in System Settings → Privacy & Security, to the
   `t3-imessage` binary (its child `imsg` inherits them):
   - **Full Disk Access**, to read the Messages database and attachments;
   - **Automation → Messages**, to send. macOS asks the first time it sends;
     someone has to click Allow at the Mac.
5. **Install the LaunchAgent.** Copy `mac/com.t3.imessage.plist` to
   `~/Library/LaunchAgents/`, replace `USER` with the user's short name and
   check the paths, then:

   ```sh
   mkdir -p ~/Library/Logs/t3-imessage
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.t3.imessage.plist
   ```

   It has `RunAtLoad` and `KeepAlive`, so it starts at login and restarts if
   it exits.

> **The LaunchAgent runs only inside that user's GUI session**
> (`LimitLoadToSessionType: Aqua`; Messages needs it). After the Mac restarts,
> nothing runs until someone logs that user in. Either make it the
> **automatic-login user** (System Settings → Users & Groups; requires
> FileVault off) or log in by hand after each restart. Keep the Mac awake
> (Energy settings: prevent automatic sleep). Fast User Switching to another
> user is fine; the service keeps running in the background session.

### 2. Tunnel the port to the bridge's host

The service listens on the Mac's loopback only. From the bridge's host:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:47821:127.0.0.1:47821 messages-user@mac.example.com
```

Use a key-only SSH login for that Mac user. See
[Running always on](#running-always-on) to keep it up.

### 3. Configure

```json
"imessage": {
  "host": "127.0.0.1",
  "port": 47821,
  "projectId": "<T3 project id>",
  "worktreeFrom": "main",
  "allowedHandles": ["+15555550100", "someone@example.com"],
  "allowEveryone": false,
  "outboundReactions": false
}
```

- `host` and `port`: the tunnel's local end (these are the defaults).
- `projectId`, `worktreeFrom`, `note`: the route for new conversations.
- `allowedHandles`: phone numbers and emails, as Messages shows them, that may
  use the agent.
- `allowEveryone`: **off by default.** `true` lets anyone who can send this
  Apple Account an iMessage start runs, with the bridge's T3 access (often full
  access to the machine). Spam and strangers can reach it. The bridge logs a
  warning at start-up. Leave it off unless the account's number is private and
  the T3 project and runtime mode are safe to hand to anyone.
- `services`: Messages services to read, default `["iMessage"]`.
- `startAfterRowId`: on the very first start only, also answer messages after
  this Messages row id. Otherwise the bridge starts from now.

### Reactions and SIP

Incoming tapbacks from allowed people are kept as context for the thread's
next turn, such as "Ada reacted love (heart) to message <id>". A reaction never
starts a run.

`imsg` can **send** tapbacks, typing indicators and read receipts only through
Apple's private Messages framework, by injecting a helper into Messages, and
that requires **System Integrity Protection (SIP) off**. With SIP on (the
default), the agent isn't offered `chat_react` in iMessage, there's no typing
indicator, and messages show as delivered, not read. Everything else works.

To turn on outbound tapbacks anyway (this lowers the security of the whole
Mac):

1. Shut the Mac down, hold the power button until "Loading startup options",
   choose **Options**, then **Utilities → Terminal**.
2. Run `csrutil disable`, then `csrutil status` to check, and restart.
3. As the Messages user, run `imsg launch --install-agent` and check that
   `imsg status` shows its bridge running. On macOS 26 and later, library
   validation can still block it; `imsg status` says so.
4. Set `imessage.outboundReactions: true` and restart the bridge. On connect
   it asks `imsg` for `status` and turns tapbacks on only if the helper is
   running, and logs which way it went.

To undo: `imsg launch --uninstall-agent`, set `outboundReactions: false`, and
run `csrutil enable` from Recovery.

The bridge doesn't use `imsg react`'s non-SIP mode (UI scripting of the
Tapback picker): it can't target a message by id, needs Messages frontmost in
the active session, and can't confirm the tapback was sent.

## Give the agents the chat tools

Register `http://127.0.0.1:3920/mcp` (your `toolsPort`) as an HTTP MCP server
named `t3-chat-bridge` for each provider T3 runs. Without it the bridge still
works, but agents can't send files, react or set status.

Claude, for every project:

```sh
claude mcp add --scope user --transport http t3-chat-bridge http://127.0.0.1:3920/mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.t3-chat-bridge]
url = "http://127.0.0.1:3920/mcp"
```

Or, to give the tools only to Codex runs T3 starts, set the Codex provider's
**Launch arguments** in T3's settings to
`-c mcp_servers.t3-chat-bridge.url="http://127.0.0.1:3920/mcp"`.

T3 doesn't restart a running provider when settings change, so restart T3
afterwards. Every agent on the server sees these tools; the chat key in each
turn is what limits each call to its own conversation.

## Running always on

Everything restarts by itself once set up; only macOS permission prompts and
the Mac's login need a person.

### Linux: systemd user units

Put secrets in a file only you can read, for example
`~/.config/t3-chat-bridge/env` (mode 0600):

```sh
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
LINEAR_CLIENT_ID=…
LINEAR_CLIENT_SECRET=…
LINEAR_WEBHOOK_SECRET=…
```

`~/.config/systemd/user/t3-chat-bridge.service`:

```ini
[Unit]
Description=T3 chat bridge
After=network-online.target

[Service]
WorkingDirectory=%h/t3code/apps/chat-bridge
EnvironmentFile=%h/.config/t3-chat-bridge/env
ExecStart=/usr/bin/env node src/bin.ts start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

For iMessage, `~/.config/systemd/user/imessage-tunnel.service`:

```ini
[Unit]
Description=SSH tunnel to the Messages Mac
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 -o BatchMode=yes \
  -L 127.0.0.1:47821:127.0.0.1:47821 messages-user@mac.example.com
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Run your T3 server as a unit the same way. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now t3-chat-bridge.service imessage-tunnel.service
sudo loginctl enable-linger "$USER"   # start user units at boot, without a login
journalctl --user -u t3-chat-bridge -f
```

Use the full path to `node` in `ExecStart` if it isn't on systemd's `PATH`
(for example under nvm). Stop the bridge with `systemctl --user stop`; it
shuts down cleanly on SIGTERM.

### macOS: LaunchAgent

The iMessage service's LaunchAgent is above. To run the bridge itself on a Mac,
use a LaunchAgent the same way, with `ProgramArguments` of `node`,
`src/bin.ts`, `start`, a `WorkingDirectory` of `apps/chat-bridge`, the
environment variables under `EnvironmentVariables` (keep the plist mode 0600),
and `RunAtLoad` and `KeepAlive` set to true.

## Config reference

`config.json` in the data directory (`~/.t3-chat-bridge`, or
`$T3_CHAT_BRIDGE_HOME`), or the file given with `start --config PATH`. No
secrets go in it. A complete example with every platform; remove the blocks
you don't use:

```json
{
  "t3Url": "http://127.0.0.1:3773",
  "toolsPort": 3920,
  "runtimeMode": "full-access",
  "modelSelection": {
    "instanceId": "claudeAgent",
    "model": "claude-opus-5-5",
    "options": [{ "id": "effort", "value": "medium" }]
  },
  "startTools": false,

  "channelProjects": [
    {
      "channelId": "C0123456789",
      "projectId": "<T3 project id>",
      "worktreeFrom": "main",
      "note": "Don't deploy anything."
    },
    { "channelId": "C0123456789", "projectId": "<T3 project id>", "match": "[docs]" }
  ],
  "dmProjectId": "<T3 project id>",
  "dmWorktreeFrom": "main",
  "allowedUserIds": ["U0123456789"],
  "allowEveryone": false,

  "linear": {
    "botName": "my-agent",
    "webhookPort": 3930,
    "webhookPath": "/linear/webhook",
    "projectId": "<T3 project id>",
    "worktreeFrom": "main",
    "teams": [{ "team": "ENG", "projectId": "<T3 project id>" }],
    "allowEveryone": true,
    "allowedUserIds": []
  },

  "imessage": {
    "host": "127.0.0.1",
    "port": 47821,
    "projectId": "<T3 project id>",
    "allowedHandles": ["+15555550100", "someone@example.com"],
    "allowEveryone": false,
    "services": ["iMessage"],
    "outboundReactions": false
  }
}
```

| Field             | Default                | Meaning                                                                                        |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `t3Url`           | required               | The T3 server's origin.                                                                        |
| `t3EnvironmentId` | unset                  | Optional. Checks that `t3Url` serves this environment and pins thread and project calls to it. |
| `toolsPort`       | `3920`                 | Loopback port of the chat-tools MCP server.                                                    |
| `runtimeMode`     | project default        | For new threads, such as `full-access`. Capped by the access approved at `login`.              |
| `modelSelection`  | project default        | For new threads: `{ instanceId, model, options? }`.                                            |
| `startTools`      | `false`                | Serve `slack_start` and `linear_start`.                                                        |
| `channelProjects` | required (may be `[]`) | Slack channel routes: `channelId`, `projectId`, and optional `match`, `worktreeFrom`, `note`.  |
| `dmProjectId`     | unset                  | Project for Slack DMs. Unset ignores DMs.                                                      |
| `dmWorktreeFrom`  | unset                  | Branch each Slack DM thread's new worktree starts from. Unset runs DMs in the project root.    |
| `allowedUserIds`  | required (may be `[]`) | Slack member ids allowed to use the bot.                                                       |
| `allowEveryone`   | `false`                | Also allow every full member of the Slack workspace.                                           |
| `slack.transport` | `"socket"`             | Leave as `socket`. `"office-relay"` belongs to the Office relay below.                         |
| `linear.*`        | off                    | See [Linear](#linear). `projectId` is required; `allowEveryone` defaults to `true`.            |
| `imessage.*`      | off                    | See [iMessage](#imessage). `projectId` is required.                                            |

`formerModelSelections` is also accepted; it only matters for migrating
threads after changing `modelSelection`, and you can leave it out.

### Environment variables

| Name                    | Needed for          | Notes                                                   |
| ----------------------- | ------------------- | ------------------------------------------------------- |
| `SLACK_BOT_TOKEN`       | Slack               | `xoxb-…`. Also used by `resend-slack`.                  |
| `SLACK_APP_TOKEN`       | Slack (Socket Mode) | `xapp-…`, scope `connections:write`.                    |
| `LINEAR_CLIENT_ID`      | Linear              | Removed from the bridge's environment after it is read. |
| `LINEAR_CLIENT_SECRET`  | Linear              | Same.                                                   |
| `LINEAR_WEBHOOK_SECRET` | Linear              | The webhook signing secret. Same.                       |
| `T3_TOKEN`              | optional            | An MCP token for T3 instead of the saved `login`.       |
| `T3_CHAT_BRIDGE_HOME`   | optional            | The data directory. Default `~/.t3-chat-bridge`.        |

The code also reads `OFFICE_CONVEX_URL`, `OFFICE_CHAT_BRIDGE_TOKEN`,
`OFFICE_T3_PROJECT_ID`, `OFFICE_WORKTREE_FROM` and `OFFICE_REPOSITORY_PATH`.
They configure an optional Office relay channel used by this bridge's authors;
leave them unset. With them unset, the Office channel, `import-office` and
`slack.transport: "office-relay"` are all off.

## Resend a Slack message

A message the bridge already handled is dropped if it arrives again. To hand
one to T3 again, stop the bridge and run:

```sh
SLACK_BOT_TOKEN=xoxb-… node src/bin.ts resend-slack <channel id> <message ts>
```

It refuses while a bridge runs on the same data directory. It reads the
message from Slack, clears the bridge's record of it, and saves it to the
inbox. The next `start` hands it to T3 once: the T3 retry key is the message's
own, so a text message T3 already took isn't sent twice (with files, see the
note under "Nothing is lost").

## Limits

- The bridge, T3 and the agents must share a machine: `chat_post` reads files
  by path, and the tools server listens on loopback.
- Slack catch-up after downtime misses a mention inside a thread the bot
  wasn't in, and a first DM from someone the bot has never answered.
- The T3 login needs renewing every 30 days.
- Answers are posted up to 50,000 characters, in parts of up to 12,000.
- A T3 message takes at most 8 attachments; extra files are named, not
  imported.
- If Slack refuses an answer five times in a row, the bridge stops trying
  until it restarts.
- On stock T3, a retried send with files can post twice (see "Nothing is
  lost").

## Development

```sh
pnpm install          # the whole workspace; the tests use the root Vite config
pnpm --filter @t3tools/chat-bridge typecheck
pnpm --filter @t3tools/chat-bridge test
```

| File                   | What it does                                                                   |
| ---------------------- | ------------------------------------------------------------------------------ |
| `src/bin.ts`           | The `start`, `login`, `manifest`, `import-office` and `resend-slack` commands. |
| `src/config.ts`        | `config.json` parsing and defaults.                                            |
| `src/bridge.ts`        | The core: chat messages into T3 turns, each run watched, answers back.         |
| `src/platform.ts`      | `ChatPlatform`: what the core needs from a platform beyond the Chat SDK.       |
| `src/chatHost.ts`      | The one Chat SDK `Chat`, with an adapter per platform.                         |
| `src/slack/`           | Slack: adapter calls, its `ChatPlatform`, resends and the manifest.            |
| `src/linear/`          | Linear: agent sessions, stop and comment webhooks, file uploads.               |
| `src/imessage/`        | iMessage: the Chat SDK adapter, its RPC client and its `ChatPlatform`.         |
| `mac/`                 | The Mac service and its LaunchAgent.                                           |
| `src/office/`          | The optional Office relay channel; unused unless its variables are set.        |
| `src/webhookServer.ts` | Loopback webhooks, at exact paths only.                                        |
| `src/login.ts`         | T3's MCP OAuth sign-in.                                                        |
| `src/t3Client.ts`      | The MCP client for T3.                                                         |
| `src/threads.ts`       | The T3 MCP calls: launch, send, wait, read, configure.                         |
| `src/toolServer.ts`    | The chat tools MCP server (`chat_post`, `chat_react`, `chat_status`, …).       |
| `src/runFeed.ts`       | What a run is doing now, from T3's activity view.                              |
| `src/activity.ts`      | T3 activity items as status lines; redaction.                                  |
| `src/questions.ts`     | Agents' questions as buttons or numbered text, and their answers.              |
| `src/modelCommand.ts`  | The `!model` switch aliases.                                                   |
| `src/store.ts`         | Inbox, bindings, handled messages and owed replies (SQLite).                   |
| `src/chatState.ts`     | The Chat SDK's state on the same SQLite file.                                  |
