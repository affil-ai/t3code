# Convex T3 Bridge example

This directory is a small Convex app that installs the bridge component from
the package source. It records component events in `events` and exposes the
functions used by `harness.ts`. The public functions have no application auth.
Keep this app local and isolated. Do not expose its API to untrusted clients.

## Run locally

From the repository root, install dependencies:

```sh
pnpm install
```

Start an anonymous local Convex deployment:

```sh
cd packages/convex-t3-bridge/example
CONVEX_AGENT_MODE=anonymous npx convex dev \
  --local-cloud-port 3210 --local-site-port 3211 \
  --typecheck enable
```

The default local URLs are `http://127.0.0.1:3210` for the Convex API and
`http://127.0.0.1:3211` for HTTP actions. The CLI stores anonymous deployment
state in `example/.convex/local/default/`. No login or cloud project is needed.
The component registers its own five-second sweep cron, so the host does not
need a `crons.ts`.

After the first successful `npx convex dev`, a transient user service can
keep the deployment running:

```sh
systemd-run --user --unit=convex-t3-bridge-example --collect \
  --working-directory="$PWD" --setenv=CONVEX_AGENT_MODE=anonymous \
  /usr/local/bin/npx convex dev \
  --local-cloud-port 3210 --local-site-port 3211 \
  --typecheck enable --codegen disable
```

Do not start a second copy while this unit is running. Stop it with
`systemctl --user stop convex-t3-bridge-example`. Read its logs with
`journalctl --user -u convex-t3-bridge-example`.
Code generation is disabled in the steady-state service so it does not
rewrite the component's committed generated files while you work. After
changing function signatures, run `npx convex codegen`, format the changed
generated files with the repository formatter, and run both typechecks.

Set the non-secret values on the deployment:

```sh
CONVEX_AGENT_MODE=anonymous npx convex env set T3_MCP_URL https://t3.olumbe.com/mcp
CONVEX_AGENT_MODE=anonymous npx convex env set T3_TEST_PROJECT_ID mcp:15b62d36-b4f8-4a8f-b9dd-f1dd63e4afb7
```

That project ID was verified through `t3_project_list` on October 21, 2026.
Its title is "T3 Bridge Test" and its workspace is
`/home/vivek-affil/build/t3-bridge-test-workspace`.

## Verify phase 1 without T3

With the local deployment running:

```sh
pnpm run typecheck
pnpm run test:local
```

The local tests query the installed component and indexed host table and
check that the reply route refuses requests without a valid bearer token.
They do not send messages to T3.

Run `pnpm run typecheck` from the parent package to check the component source.
Convex 1.47's local backend binds `0.0.0.0` by default. The commands above do
not publish a tunnel or configure host firewall access.

## Run the live harness in phase 2

The coordinator must set these secrets on the local Convex deployment:

- `T3_MCP_TOKEN`, a T3 client bearer token with project and thread access.
- `T3_BRIDGE_REPLY_SECRET`, the HMAC secret for conversation reply keys.
- `T3_BRIDGE_MCP_TOKEN`, the bearer token accepted by `/t3-reply`.

The harness process needs `T3_MCP_TOKEN` and `T3_BRIDGE_MCP_TOKEN` in its
environment. It does not need the HMAC secret. Inject the tokens through your
authorized secret source, then run:

```sh
CONVEX_URL=http://127.0.0.1:3210 \
CONVEX_SITE_URL=http://127.0.0.1:3211 \
T3_MCP_URL=https://t3.olumbe.com/mcp \
pnpm harness
```

The harness refuses non-local Convex URLs and prints one pass/fail line per
scenario. It runs launch, follow-up on the same thread, reply intake,
duplicate rejection, missing-bearer rejection, and cancellation. It reads the
reply key from the first user message through T3 MCP, so no key-reading
production API is added. Routing keys and remote exceptions are not printed.

Each launch/follow-up has a five-minute deadline. Cancellation allows five
minutes to observe a start, then 60 seconds from the cancel call. A failed
check exits nonzero. Failed or timed-out checks can leave test threads behind,
so inspect them before retrying. The instructions forbid file edits.

The route test posts directly to the local HTTP endpoint. It does not require
adding an MCP server to T3 or making the local endpoint reachable from T3.
