# Fork release checks

The fork owns its release tooling under `scripts/fork-release/`. It must not
depend on a separate machine-configuration repository. Host credentials and
release checkpoints stay in private local state.

The release driver supports private requests, isolated host builds, and a
Mac-side pull of Ubuntu requests. Building does not install either artifact.
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
Mac builds are signed with the local Apple Development identity before hashing.
That identity must already exist in the Mac keychain.

## Paired release

For Ubuntu-only initiation, install the Mac pull worker once with
`node scripts/fork-release/worker.mjs install /private/path/config.json`.
The private config names `host` (an existing outbound SSH alias), `repo`
(the Ubuntu checkout), `minimumVersion` (excludes obsolete prepared requests),
and `mac`/`linux` objects containing the verified installed `version` and
`commit`. A bootstrap `sharedDiff` is optional and must be the reviewed digest
reported by qualification. After the first release, installed receipts provide
the baseline; bootstrap commits are never reused for a different version.

The worker is a user LaunchAgent, not GitHub Actions or a T3 schedule. It
polls Ubuntu requests, waits for the Linux build receipt, builds/signs on Mac,
exchanges both artifacts, qualifies compatibility, and waits for idle before
activation. It uses the same single-writer handoff lock. Unknown provenance or
compatibility failures stop it with `worker-status.json` set to `needs-review`.
An offline Ubuntu host waits without installing. Keep the Mac awake for builds.
Do not run the one-shot handoff while this worker is installed.

With the worker installed, future releases need only `request` and `build` on
Ubuntu. The following manual sequence remains useful for diagnosis or hosts
without the worker:

Initiate the release on Ubuntu with `request` and `build`. Use the full commit
from canonical Affil main and a new version. On the Mac, run `mac-pull`, then:

```sh
node scripts/fork-release/release.mjs exchange VERSION SSH_ALIAS REMOTE_CHECKOUT
```

This transfers both artifacts over SSH, checks their hashes on each host, and
writes paired manifests. It does not install anything. Transfer attempts use
unique files and preserve previous artifacts.

Before activation, identify the source commit of each installed runtime. On
each host run:

```sh
node scripts/fork-release/activate.mjs qualify VERSION INSTALLED_SOURCE_SHA
```

Qualification requires unchanged server and contracts source. It records the
current installed version and database schema fingerprint. Changes to those
sources require a separate database and protocol review; this tool does not
override that gate. If shared source changed, inspect its full diff and pass
the reported SHA-256 as the fourth argument only after confirming it does not
change database or protocol compatibility. The receipt records that reviewed
diff. Do not guess the installed source commit.
Linux qualification also tests the deployed Office worker's version predicate
and the live orchestration protocol. The Office worker remains in Nextcard.

Once both qualifications pass, start the detached installer from the Mac:

```sh
node scripts/fork-release/handoff.mjs start VERSION SSH_ALIAS REMOTE_CHECKOUT
```

The one-shot launchd job waits up to 24 hours for both hosts to be idle. It does
not create a recurring schedule. It installs Linux through the native updater
using a loopback-only artifact mirror. It then installs the Mac bundle through
a graceful quit and LaunchServices relaunch. It never force-kills the app.
This works when the initiating chat is hosted in the Mac app: the installer
waits until the chat turn has ended.

The Mac must stay awake and connected. An existing launchd job is never replaced.
Inspect its private `handoff.json`, `handoff-error.json`, and `handoff.log` before
retrying. After a completed or exited job, remove only
`gui/UID/com.affil.t3-fork-release` with `launchctl bootout` before starting a new
release. Never remove a running job or its lock to bypass pending work.

An install can finish on one host while the other becomes busy. Check each
platform's `*-installed.json`. A failed or interrupted activation without a
receipt requires reconciliation; the version string alone is not provenance.
Keep the previous runtime and app bundle. No automatic database restore or
binary rollback is attempted after startup.

The installer verifies target API versions and Linux service health. This is
not UI acceptance. Verify local and remote threads, repository navigation,
browser proxy access, and Office behavior in the actual clients before marking
the release complete.

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
