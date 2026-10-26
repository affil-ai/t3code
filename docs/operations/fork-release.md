# Fork release checks

This is the canonical Affil T3 Work release procedure. It is separate from
the upstream GitHub Actions release workflow. Do not use upstream
`preview`, `nightly`, or `stable` workflow channels for an Affil release.

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

Linux builds need Node 25.7 or later for the single executable (found as
described under Ubuntu activation) and Cargo for the resource monitor. macOS builds need the native build dependencies described
in `FORK.md`. The driver uses the source's exact pnpm version and builds its own
resource monitor; it does not reuse unproven installed binaries.

The Mac pull command is one bounded queue pass, not an installed daemon.
It uses outbound SSH from the Mac; it does not require an inbound Mac port.
Mac builds are signed with the local Apple Development identity before hashing.
That identity must already exist in the Mac keychain.

## Release state model

Use these states in release reports:

1. **Prepared**: one fork version is bound to one source commit.
2. **Built**: host artifacts and the matching web payload exist.
3. **Exchanged**: paired artifacts are present and checksums match.
4. **Qualified**: installed source, protocol, schema, and Office compatibility
   pass for the exact release.
5. **Activated**: the target host installed the release.
6. **Published**: the matching web payload was atomically published.
7. **Verified**: receipts, live API metadata, and browser checks pass.

A build receipt is not an install receipt. An install receipt is not web
verification. Report Mac, Ubuntu, and public web targets separately.

## Paired release

### Public web is a required Ubuntu release target

`https://t3.olumbe.com` is **not** the upstream Vercel app. The existing
`t3-work-web.service` serves `~/.local/share/t3-work-web/current` behind
Cloudflare Access and forwards backend traffic to Ubuntu's browser proxy.
Do not change its authentication, credentials, tunnel, or service configuration.

Linux `release.mjs build` now stages a production web payload from the same
isolated commit, with production branding, no source maps, and no baked-in
backend origin. `web/fork-release.json` records the source SHA, release version,
and every asset checksum. Linux activation refuses to proceed without this
payload. After the server is installed and healthy, activation publishes the
web files through `web.mjs`. Mac-only activation does **not** publish the web.

For existing artifacts made before this integration, run on Ubuntu:

```sh
node scripts/fork-release/web.mjs build VERSION
node scripts/fork-release/web.mjs publish VERSION
```

Build is preparation only. Publish requires a matching Ubuntu installed receipt,
live version, and protocol. If Ubuntu is older and busy, stage the files and
report the pending server activation. Do not bypass the idle or compatibility
gates, and do not call a Mac-only release a completed release of all targets.
The public-web files have their own single-writer lock. Publication checks
checksums and backend compatibility before the atomic symlink change. Old hashed
assets remain available for already-open clients; no service restart is needed.

### Ubuntu activation, including from an agent inside T3

Ubuntu activation always goes through one command:

```sh
node scripts/fork-release/handoff.mjs start-linux VERSION \
  [--restart-thread YOUR_T3_THREAD_ID] [--approved-interrupt "who approved, when"]
```

Never run `t3 update`, `t3 service restart`, `activate.mjs install`, or a
hand-written installer from an agent shell. Each agent runs in a T3-owned
`t3code-*.scope`. Stopping the server stops that scope, so an inline updater
dies halfway and the server stays down. This happened with fork.73 and fork.74.
The updater (`t3 update`, `t3 service restart|install|uninstall`) and
`activate.mjs install` now refuse inside a T3 scope and name this command. The
detached unit sets `T3_DETACHED_SERVICE_UPDATE=1`, the updater's only bypass.

`start-linux` returns immediately. It starts one transient user unit,
`t3-fork-release.service`, outside every T3 process tree. That unit:

1. waits up to 24 hours until no blocking work remains;
2. rechecks artifacts, qualification, schema, Office, and provenance;
3. runs the native updater, starts companion units the server stop took down
   (the browser proxy has `Requires=t3code.service`), waits up to 3 minutes
   for the target API, then publishes web;
4. if the target never becomes healthy, switches back to the previous runtime
   and starts the service, so the host is never left without a server.

By default every running, starting, waiting, or unheld queued run blocks.
`--restart-thread` exempts only the caller's own running turn. The host is
rarely idle, so an operator may pass `--approved-interrupt` with the human
approval to restart over active work. It skips the idle wait, and the note and
interrupted counts are recorded. Do not pass it without that explicit approval.

**Your own turn ends when the server restarts.** After you resume, read
`handoff-linux.json` in the release directory
(`node scripts/fork-release/release.mjs location VERSION`). Its `phase` is
`waiting`, `activating`, `ubuntu-and-web-origin-installed`, `rolled-back`, or
`failed`. Then check `linux-x64-activation.json`, `handoff-error.json`, and
`handoff-linux.log`, and confirm the live version yourself. A second start is
refused while the unit runs; `start-linux` clears an earlier attempt's
`handoff-error.json`.

A Linux-only release, with no Mac artifact, uses
`node scripts/fork-release/release.mjs manifest VERSION --linux-only`. The Mac
refuses that manifest and keeps its version; report the Mac as not released.
A lock whose recorded owner process is gone is renamed to `*-retired-PID-TIME`
and taken; a live owner still blocks.

The Linux build needs Node 25.7 or later for the single executable.
`release.mjs build` uses `T3_FORK_RELEASE_NODE`, the running Node, or the newest
`~/.local/opt/node-v*-linux-x64`, in that order. Patched runtime dependencies
are pinned to their patch version when staged, so a newer upstream release
cannot fail the build with `ERR_PNPM_UNUSED_PATCH`. If the build still fails,
fix the build; never resume from a hand-edited checkout.

`web-published.json` records the previous and new directories and source SHA.
This proves origin publication, not public browser acceptance. Verify the live
domain in an authenticated browser, read `/fork-release.json`, and check the
grid and New agent button. If Access requires sign-in, report that exact
blocker; never create temporary tokens or weaken Access for verification.
Report Mac installed, Ubuntu installed, and public-web verified separately.

Keep requests, receipts, web metadata, current assets, and the previous known-good
artifacts. Delete only disposable build checkouts after preserving their logs.
Never remove an artifact referenced by a retained manifest.

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

For an explicitly requested Mac-only installation of a qualified client-only
change, use `start-mac` with the same arguments. Both artifacts must still be
staged and the Mac compatibility review must pass. It waits for local idle,
does not restart Ubuntu, and records `mac-installed` instead of paired success.
Reconcile the Ubuntu rollout separately; never report both hosts installed.

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
Keep the previous runtime and app bundle. The Mac never rolls back
automatically. Ubuntu switches back to the previous runtime only when the target
API never becomes healthy; qualification's database review must allow the old
binary to run on the new schema. No database restore is ever attempted.

The installer verifies target API versions and Linux service health. This is
not UI acceptance. Verify local and remote threads, repository navigation,
browser proxy access, and Office behavior in the actual clients before marking
the release complete.

`manifest <fork-version>` combines both local platform receipts.
`check-deploy <fork-version>` verifies both local artifact files and reads
the live T3 database read-only. Running, starting, preparing, waiting, and unheld
queued runs block it. Only queued rows with an explicit JSON boolean
`queueHeld: true` are counted separately as `heldQueued`; those preserved requests
do not block idle. Missing hold flags mean unheld. Invalid JSON, unknown statuses,
inconsistent status fields, and malformed hold flags fail closed. No queue row,
message, or hold flag is changed. A stale running row still blocks.
Neither command installs software. Compatibility, migration
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

## Cleanup

After activation and live verification, remove only verified disposable build
material. Keep requests, manifests, checksums, qualification records,
installation receipts, publication receipts, private logs, the current
artifact, the immediate previous known-good artifact, and staged artifacts
awaiting activation.

Never delete a release directory or its request metadata. Never delete a path
referenced by a retained manifest, active installer, or worker. Remove only
temporary source checkouts, dependency directories, unpacked staging copies,
and failed temporary build paths. Check free space again after cleanup.
