# Fork release checks

The fork owns its release tooling under `scripts/fork-release/`. It must not
depend on a separate machine-configuration repository. Host credentials and
release checkpoints stay in private local state.

These checks are preparation tools, not a complete build or deployment command.
From the repository root:

```sh
node --test scripts/fork-release/release-check.test.mjs
node scripts/fork-release/release-check.mjs preflight
node scripts/fork-release/release-check.mjs cutover-time
node scripts/fork-release/release-check.mjs verify-artifacts /path/to/manifest.json
```

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
