---
name: affil-release
description: Build, qualify, activate, and verify the Affil T3 Work fork across Ubuntu, macOS, and t3.olumbe.com. Use when releasing T3 Work, Firstmate, the desktop app, the Ubuntu runtime, the public web target, or when the user asks how to publish the fork.
---

# Affil T3 Work release

Use the repository-owned `scripts/fork-release/` workflow. Do not use
upstream GitHub Actions `preview`, `nightly`, or `stable` channels.

## Read first

Resolve paths from the repository root (three directories above this skill's
directory). Read `CONTEXT.md`, `FORK.md`, and `docs/operations/fork-release.md`.
Run the read-only doctor before changing release state:

```sh
node scripts/fork-release/doctor.mjs
```

## Canonical flow

1. Select the full commit from Affil `main`.
2. Reserve a new fork version. Never reuse a version for another commit.
3. On Ubuntu, request and build Linux plus the matching web payload.
4. On the Mac, pull the request and build/sign macOS.
5. Exchange artifacts and generate the paired manifest.
6. Qualify the exact release against installed source, schema, protocol, and
   the deployed Office worker.
7. Recheck active work immediately before activation.
8. Activate through the detached handoff.
9. Verify Ubuntu, Mac, and `t3.olumbe.com` separately.
10. Clean only verified disposable build material.

On Ubuntu, from the verified checkout:

```sh
node scripts/fork-release/release.mjs request COMMIT VERSION
node scripts/fork-release/release.mjs build VERSION
```

If a persistent Mac worker is installed, let it own the handoff. Never start
a one-shot installer alongside it. Otherwise, on the Mac (substitute the
verified absolute Ubuntu checkout path):

```sh
node scripts/fork-release/release.mjs mac-pull work UBUNTU_CHECKOUT
node scripts/fork-release/release.mjs exchange VERSION work UBUNTU_CHECKOUT
node scripts/fork-release/release.mjs manifest VERSION
```

On **each host**, qualify using that host's installed source SHA:

```sh
node scripts/fork-release/activate.mjs qualify VERSION INSTALLED_SOURCE_SHA
```

After both qualifications pass, start the detached handoff on the Mac:

```sh
node scripts/fork-release/handoff.mjs start VERSION work UBUNTU_CHECKOUT
```

### Activating Ubuntu from inside T3

You are almost certainly running inside T3 on Ubuntu. Restarting the server
stops your own process tree, so never run `t3 update`, `t3 service restart`,
`activate.mjs install`, or a hand-written installer yourself. They refuse
inside a T3 scope. Use only the detached handoff:

```sh
node scripts/fork-release/release.mjs manifest VERSION --linux-only   # no Mac artifact
node scripts/fork-release/handoff.mjs start-linux VERSION --restart-thread YOUR_THREAD_ID
```

- It returns at once with the unit name and status paths.
- Pass `--approved-interrupt "NOTE"` only with explicit human approval to
  restart over other running work. Without it, the unit waits for idle.
- Your turn is cut off when the server restarts. Expect that; do not retry.
- After resuming, read `handoff-linux.json` in
  `release.mjs location VERSION`. Treat `rolled-back` or `failed` as not
  released. Then confirm the live `/.well-known/t3/environment` version.

If a build fails (Node version, unused patch), fix the build tooling. Do not
resume from a hand-edited checkout or install outside the handoff.

`mac-pull` processes the queue, not just VERSION. Inspect the queue first.
Do not rebuild obsolete requests blindly. See the guide for Mac-only and
Ubuntu/web-only paths.

## Hard gates

- One source commit and one fork version for all targets.
- No force-push, GitHub Actions, credential changes, or broad host restart.
- Do not cancel or interrupt active T3 or Office work to make a host idle.
  Only an explicit human approval passed as `--approved-interrupt` allows a
  restart over running work.
- Never stop, restart, or update the T3 server from your own shell; only
  `handoff.mjs start-linux` (Ubuntu) or the Mac handoff may.
- Running, starting, waiting, preparing, and unheld queued work blocks
  activation. Intentionally held requests remain preserved.
- Firstmate requires the fork's server.
- Office source remains in `affil-ai/nextcard`.
- Apple signing stays on the Mac.
- A receipt or symlink change alone is not browser verification.
- This skill grants no new deployment, recovery, queue-disposition, or Office
  maintenance permission. Stop for missing authorization.
- Unknown schema/protocol compatibility needs review, not a bypass.

## Cleanup and reporting

Keep requests, manifests, receipts, checksums, logs, current artifacts, the
immediate previous known-good artifacts, and staged artifacts awaiting
activation. Remove only verified temporary source checkouts, dependency
directories, unpacked staging copies, and failed temporary build paths. Never
delete a release directory or a path referenced by a retained manifest or
active installer.

Report the source commit and fork version, Linux receipt, macOS receipt and
signature, web publication receipt, live `/fork-release.json`, browser
verification, and any remaining blocker separately. Do not call a build,
qualification, queued handoff, or Mac-only install a complete paired release.
