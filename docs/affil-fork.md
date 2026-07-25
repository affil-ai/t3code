# Affil T3 Code fork

The maintained Affil line starts from upstream T3 Code and keeps customization
small enough to reapply after upstream updates. The historical `main` branch is
preserved until this line is promoted.

## Shared UI and desktop releases

`apps/web` is the UI used by both the packaged server and the Electron desktop
application. Sidebar changes therefore belong in `apps/web` and must ship with
the same version in both artifacts.

The **Affil synchronized release** workflow accepts one exact semantic version
and publishes one GitHub Release containing:

- `t3-<version>.tgz`, with the server and its built web UI;
- macOS arm64 and x64 desktop artifacts;
- updater manifests pointing the desktop app at `affil-ai/t3code`.

The release is published only after repository checks, typechecking, tests, and
both builds succeed. It never publishes only one half of a version.

Affil builds use the bundle ID `ai.affil.t3code` and product name
`Affil T3 Code`. This keeps the signed fork separate from the upstream desktop
app. Both values remain environment-configurable so upstream defaults stay
unchanged outside the Affil workflow.

GitHub only enables manually dispatched workflows from the repository's default
branch. Promote this maintained line to the default branch before attempting the
first release; do not copy the workflow into the historical branch.

## macOS updater credentials

Unsigned artifacts are useful for build validation and manual installation, but
macOS automatic updates require a signed and notarized application. Configure
these GitHub Actions secrets before treating a release as production:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE`

Configure these Actions variables:

- `APPLE_TEAM_ID`
- `CLERK_PASSKEY_RP_DOMAINS`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `RELAY_URL`

## Updating a server from the same release

Download the server package from the matching GitHub Release and pass its URL to
the normal T3 service updater:

```sh
version=0.0.29-nightly.20260725.898
npx --yes \
  "https://github.com/affil-ai/t3code/releases/download/v${version}/t3-${version}.tgz" \
  service update \
  --base-dir "$HOME/.t3"
```

This preserves T3's pinned-runtime and rollback behavior. The Office worker's
approved T3 version and contract provenance must be updated and deployed with
the same version before cutting a production server over.

## Upstream updates

1. Fetch `upstream`.
2. Create the next Affil branch from the desired upstream release tag.
3. Reapply the small Affil commits.
4. Run `vp check`, `vp run typecheck`, and `vp run test`.
5. Push the branch and dispatch **Affil synchronized release** with the exact
   upstream version.

Do not merge upstream into the historical fork branch. That branch contains an
older orchestration product and is retained only for recovery and reference.
