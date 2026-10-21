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

Stop that first `npx convex dev` once the functions are pushed. The CLI's
local backend listens on `0.0.0.0` and uses a fixed, publicly known instance
secret, so anyone who can reach port 3210 can derive the admin key. Once the
deployment holds a T3 token, that means anyone on the network could launch
agents. Keep it running by starting the same backend binary bound to
`127.0.0.1` with the state the CLI created:

```sh
STATE="$PWD/.convex/local/default"
BIN=$(ls -d ~/.cache/convex/binaries/*/convex-local-backend | tail -1)
SECRET=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['instanceSecret'])" "$STATE/config.json")
systemd-run --user --unit=convex-t3-bridge-backend --collect \
  "$BIN" --interface 127.0.0.1 --port 3210 --site-proxy-port 3211 \
  --instance-name anonymous-agent --instance-secret "$SECRET" \
  --local-storage "$STATE/convex_local_storage" --disable-beacon \
  "$STATE/convex_local_backend.sqlite3"
```

Check `ss -H -ltn | grep 321` shows `127.0.0.1` only. Point the CLI at it as a
self-hosted deployment by writing a mode-600 env file outside the repository:

```sh
umask 077
python3 -I -c "import json,sys;c=json.load(open(sys.argv[1]));print('CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY='+c['adminKey'])" "$STATE/config.json" > ~/t3-bridge-example.env
npx convex dev --once --env-file ~/t3-bridge-example.env   # push after code changes
```

Pass `--env-file ~/t3-bridge-example.env` to every `npx convex` command below.
Stop the backend with `systemctl --user stop convex-t3-bridge-backend`. After
changing function signatures, run `npx convex codegen`, format the changed
generated files with the repository formatter, and run both typechecks.

Set the non-secret values on the deployment:

```sh
npx convex env set --env-file ~/t3-bridge-example.env T3_MCP_URL https://t3.olumbe.com/mcp
npx convex env set --env-file ~/t3-bridge-example.env T3_TEST_PROJECT_ID mcp:15b62d36-b4f8-4a8f-b9dd-f1dd63e4afb7
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
