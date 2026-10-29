# T3 chat bridge

Talk to T3 Code agents from Slack. Mention the bot in a mapped channel and it
starts a T3 thread in that channel's project. Replies in the Slack thread go to
the same T3 thread, and the agent's final message in each run is posted back.

It works with stock T3 Code. The bridge is a separate process that talks to T3
through T3's MCP endpoint, the same one Claude and Codex use, and to Slack over
Socket Mode, so it needs no public URL.

## What it does

- **A mention starts a thread.** The bridge launches a T3 thread in the
  channel's project with the message, who sent it, and any attached files.
- **A mention inside a Slack thread brings the thread along.** The first turn
  includes the messages before the mention, oldest first: up to the newest 50,
  within 20,000 characters. Each message shows its author and Slack id, so the
  agent can tag them. Earlier files are named but not imported. Messages from
  people outside `allowedUserIds` are included as context too.
- **Replies continue it.** A reply in the Slack thread steers the run in flight,
  or starts a new run if the thread is idle. Set `followUpMode` to `queue` to
  run replies after the current run instead.
- **Answers come back.** When a run ends, its final assistant message is posted
  to the Slack thread. A run that ends without a final message posts nothing. A
  failed run posts a short notice.
- **Files go both ways.** Slack files are uploaded to T3 as attachments: images
  up to 10 MB as images, anything else up to 50 MB as files, at most 8 per
  message. Agents send files back with the `chat_post` tool.
- **Reactions.** Agents react to a Slack message with the `chat_react` tool.
- **Restarts are safe.** Bindings, handled messages and owed replies live in
  SQLite. After a restart the bridge picks up runs it still owes a reply for.
  Messages sent to Slack while the bridge was down are not replayed.

Only Slack users in `allowedUserIds` can use it. Messages from bots, including
itself, are ignored.

## How the agent posts files and reactions

Stock T3 doesn't tell an MCP server which thread is calling it, so the bridge
writes a random chat key for each Slack thread into the turn it sends. The
agent passes that key to `chat_post` or `chat_react`. The key is the permission:
it only reaches its own Slack thread, and `chat_post` only reads files inside
that thread's worktree or project folder.

The tools are served on `http://127.0.0.1:<toolsPort>/mcp`, on loopback only.
Each agent provider must be told about that server (step 5).

## Setup

You need Node 24 or later (for `node:sqlite` and running TypeScript directly),
a T3 Code server, and permission to create a Slack app in your workspace.

### 1. Install

From the repository root:

```sh
pnpm install
cd apps/chat-bridge
```

### 2. Create the Slack app

Print a manifest and create the app from it at
<https://api.slack.com/apps> → **Create New App** → **From a manifest**:

```sh
node src/bin.ts manifest --name "T3 Code"
```

The manifest turns on Socket Mode and asks for these bot scopes:
`app_mentions:read`, `channels:history`, `groups:history`, `chat:write`,
`files:read`, `files:write`, `reactions:write` and `users:read`.

Then:

- Install the app to your workspace and copy the **Bot User OAuth Token**
  (`xoxb-…`). This is `SLACK_BOT_TOKEN`.
- Under **Basic Information → App-Level Tokens**, create a token with the
  `connections:write` scope (`xapp-…`). This is `SLACK_APP_TOKEN`.
- Invite the bot to each channel you want to use (`/invite @T3 Code`).

### 3. Write the config

The bridge keeps its files in `~/.t3-chat-bridge`, or in `$T3_CHAT_BRIDGE_HOME`
when that is set. Create `config.json` there:

```json
{
  "t3Url": "http://127.0.0.1:3773",
  "channelProjects": [{ "channelId": "C0123ABCD", "projectId": "your-t3-project-id" }],
  "allowedUserIds": ["U0123ABCD"],
  "followUpMode": "steer",
  "toolsPort": 3920,
  "runtimeMode": "full-access",
  "modelSelection": { "instanceId": "claudeAgent", "model": "claude-opus-5-5" }
}
```

- `t3Url`: your T3 server's address.
- `channelProjects`: which T3 project a mention in each channel starts its
  thread in. A channel id is in the channel's **About** panel. A project id is
  in T3, or from the `t3_project_list` MCP tool.
- `allowedUserIds`: Slack member ids (profile → **⋯** → **Copy member ID**).
- `followUpMode`: `steer` (default) or `queue`.
- `toolsPort`: the port for the `chat_post` / `chat_react` server. Default 3920.
- `runtimeMode` and `modelSelection`: optional, for new threads. Without them
  T3 uses the project's defaults. T3 caps the runtime mode at the access you
  grant the bridge in step 4.

Pass `--config PATH` to `start` to use a config file somewhere else.

### 4. Sign in to T3

```sh
node src/bin.ts login --t3-url http://127.0.0.1:3773
```

It prints a link. Open it in a browser signed in to T3, choose the access level,
and approve. The bridge listens on `127.0.0.1:3921` for the redirect
(`--callback-port` changes it) and saves the token to `t3-login.json` with mode 0600. The login lasts 30 days. Run `login` again when it expires.

The bridge can only start threads at the access level you approve. Agents that
must edit files or run commands unattended need `full-access` or `auto`.

To use a token you already have instead, set `T3_TOKEN` when you run `start`.

### 5. Give the agents the chat tools

Register `http://127.0.0.1:3920/mcp` (your `toolsPort`) as an HTTP MCP server
named `t3-chat-bridge` for each agent provider T3 runs.

Claude, for every project:

```sh
claude mcp add --scope user --transport http t3-chat-bridge http://127.0.0.1:3920/mcp
```

Or for one project, in its `.mcp.json`:

```json
{ "mcpServers": { "t3-chat-bridge": { "type": "http", "url": "http://127.0.0.1:3920/mcp" } } }
```

Claude asks before using a project server. To skip the prompt, add
`"enableAllProjectMcpServers": true` to that project's `.claude/settings.json`.

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.t3-chat-bridge]
url = "http://127.0.0.1:3920/mcp"
```

Or, to give the tools only to Codex runs that T3 starts, set the Codex
provider's **Launch arguments** in T3's settings to:

```text
-c mcp_servers.t3-chat-bridge.url="http://127.0.0.1:3920/mcp"
```

T3 runs one Codex app-server per provider instance and doesn't restart it when
settings change, so restart T3 afterwards.

Without this step the bridge still works, but agents can't send files or react.

### 6. Start it

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… node src/bin.ts start
```

It checks that each mapped project exists, connects to Slack, and logs to
stderr. Keep it running under your process manager of choice (systemd, launchd,
pm2). Stop it with Ctrl-C or SIGTERM.

Run one bridge per Slack app. Two processes on the same app token would split
Slack's events between them.

## Limits

- The bridge, T3 and the agents must share a machine. `chat_post` reads files
  by path, and the tools server listens on loopback.
- Slack messages sent while the bridge is down are not picked up later.
- T3 issues no refresh tokens, so the login needs renewing every 30 days.
- Long answers are posted up to 50,000 characters.

## Development

```sh
pnpm --filter @t3tools/chat-bridge typecheck
pnpm --filter @t3tools/chat-bridge test
```

| File                | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `src/bin.ts`        | The `start`, `login` and `manifest` commands.           |
| `src/bridge.ts`     | Turns Slack events into T3 turns and posts the answers. |
| `src/threads.ts`    | The T3 MCP calls: launch, send, upload, wait, read.     |
| `src/t3Client.ts`   | The MCP client for T3.                                  |
| `src/slackHost.ts`  | Slack over Socket Mode, through the Chat SDK.           |
| `src/toolServer.ts` | The `chat_post` / `chat_react` MCP server.              |
| `src/store.ts`      | Bindings, handled messages and owed replies in SQLite.  |
| `src/chatState.ts`  | The Chat SDK's state on the same SQLite file.           |
| `src/login.ts`      | T3's MCP OAuth sign-in.                                 |
