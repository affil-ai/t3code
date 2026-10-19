# Fork release checks

The fork owns its release tooling under `scripts/fork-release/`. It must not
depend on a separate machine-configuration repository. Host credentials and
release checkpoints stay in private local state.

The release driver supports private requests, isolated host builds, and a
Mac-side pull of Ubuntu requests. It does not install either artifact.
From the repository root:

```sh
node scripts/fork-release/release.mjs request <full-canonical-commit> <fork-version>
node scripts/fork-release/release.mjs build <fork-version>
node scripts/fork-release/release.mjs queue
# On the Mac, using an existing SSH alias and the Ubuntu checkout:
node scripts/fork-release/release.mjs mac-pull <ssh-alias> <absolute-ubuntu-checkout>
node --test scripts/fork-release/release-check.test.mjs
node scripts/fork-release/release-check.mjs preflight
node scripts/fork-release/release-check.mjs cutover-time
node scripts/fork-release/release-check.mjs verify-artifacts /path/to/manifest.json
```

Requests and per-platform build receipts live under
`~/.local/state/t3-fork-release` (override with `T3_FORK_RELEASE_STATE`).
A version is permanently bound to its source commit. Repeated builds verify
the recorded artifact instead of rebuilding. A lock blocks concurrent builds;
after a crash, inspect its owner before removing that exact stale lock.
Failed attempts and their private logs remain available for diagnosis.

Linux builds need Node 25.7 or later for the single executable and Cargo for
the resource monitor. macOS builds need the native build dependencies described
in `FORK.md`. The driver uses the source's exact pnpm version and builds its own
resource monitor; it does not reuse unproven installed binaries.

The Mac pull command is one bounded queue pass, not an installed daemon.
It uses outbound SSH from the Mac; it does not require an inbound Mac port.
It builds locally and keeps its receipt on the Mac. Artifact exchange, signing
verification, and coordinated safe activation must still be completed before
calling this an end-to-end release system.

`manifest <fork-version>` combines both local platform receipts.
`check-deploy <fork-version>` verifies both local artifact files and reads
the live T3 database read-only. Any running, starting, queued, or waiting run
blocks it. Neither command installs software. Compatibility, migration
reversibility, and a fresh activity check are still required at activation.

The migration preflight reads the source and destination GitHub main refs and
the destination Actions setting. It changes nothing. Disable destination
Actions before publishing the migrated main: inherited workflows can deploy
on pushes. Fork releases use host-local builds, not GitHub Actions.

Re-read the source main at the authorized cutover time. A previously prepared
artifact must be rebuilt if the source changed. After the migration, the
destination becomes canonical; retries must not overwrite new destination work
from the former source.

For diverged histories, a successor commit can use the exact source tree with
the destination and source commits as parents. This permits normal fast-forward
updates without merging old destination features into the resulting tree.
Check for concurrent ref changes before publishing.

## Artifact verification

A manifest has schema `1`, repository `affil-ai/t3code`, a full canonical
`commit`, a unique fork `version`, and two `artifacts`. Each artifact has
`platform` (`linux-x64` or `darwin-arm64`), matching `commit` and `version`,
local `path`, positive `bytes`, and lowercase hex `sha256`.

Verification streams each file and checks its size and digest. A passing hash
check proves byte integrity, not provenance, compatibility, or deployment
approval. Keep manifests outside Git.

Build both artifacts from the same canonical commit in isolated build
directories. Keep repository `node_modules/.bin` first on PATH to prevent
global `vp` recursion. Mac signing credentials stay on the Mac.

## Deployment boundaries

The deploy implementation must call the time, source, and activity guards
immediately before its mutations. Running a check manually does not protect
a later independent command. Missing activity observations must block
installation.

Stage and test both artifacts before activation. Recheck active and pending
work on every affected environment. Use a graceful Mac installer. Check
database migration reversibility before treating previous binaries as a
rollback plan.

The Office worker remains in Nextcard. Inspect its deployed compatibility
checks and test its protocol before updating the shared T3 server. Leave a
compatible worker unchanged. A local checkout's version pin is not evidence
of deployed worker behavior.
