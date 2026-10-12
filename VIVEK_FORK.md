# T3 Work

This fork keeps the upstream T3 server protocol, so it connects to an
unmodified T3 server of the same version. All changes are in the desktop and
web client.

## Code and Work modes

The sidebar brand ("T3 Code" / "T3 Work") is a menu that switches modes. The
choice is stored locally under `t3work:work-mode:v1`.

- **Code** is upstream T3 Code: project sidebar, terminal, actions, Open in,
  and Git controls.
- **Work** hides coding controls: the header's actions, Open in, and Git
  controls; the diff shortcut; Pull Requests; and the terminal, diff, pull
  request, and device surfaces in the right panel. It keeps the bottom terminal
  drawer with its toggle and shortcuts, and the workspace (current checkout or
  worktree) and branch strip under the composer. Its sidebar has **Projects** that you
  create, not tied to a repository, and **Chats**, every chat in none of them
  (`apps/web/src/components/LegacySidebar.tsx`,
  `apps/web/src/components/work/workChats.logic.ts`). Drag chats onto a project,
  or use a chat's context menu, to file them; drop them on Chats to remove them.
  Work projects and filings sync through `/api/t3work/state` on the first
  connected environment that serves it (the vivek-affil browser proxy). They
  record which project each `environmentId:threadId` is in and do not change
  server threads, which still run in a repository project. Collapsed state,
  mode, and the default project stay per device. Deleting a Work project moves
  its chats back to Chats. A chat an agent creates through the orchestration
  API can name its
  parent with `<!-- t3work-parent: <thread ID> -->` at the start of its first
  message; the app files it in the parent's Work project and hides the marker
  (`apps/web/src/components/work/threadParent.logic.ts`). Each unfiled chat
  created in the last two days is checked once per app session, and the app
  loads its detail to read the marker. The server is unchanged. The chat header shows the machine icon for chats on another machine.
  Work chat rows start with that machine icon and end with one status icon, no
  label. Row icons reserve no columns: they pack against the row's end, and on
  hover the archive button takes the status icon's place (`ThreadStatusIcon` in `apps/web/src/components/ThreadStatusIndicators.tsx`):
  a rotating dashed circle for Working and Connecting (still under Reduce
  Motion), still icons for Monitoring (an eye), approval, input, Plan Ready,
  and Failed, and a dot for an unseen completion.

In both modes, the right panel's **Chat** surface shows another chat beside
the main thread (`apps/web/src/components/work/DockChatPanel.tsx`). Its picker
starts a new chat in the main chat's project or opens any existing chat, on any
machine, in three sections: the main chat's Work project, its repository, and
the 30 most recent others (`DockChatPanel.logic.ts`). A chat tab records its
environment when it is not the main chat's. The chat itself is the real `ChatView` in
embedded mode (`embedded` prop): same timeline, composer, and workspace strip,
but no header, right panel, terminal, or route changes. A new chat there
starts in the main chat's worktree, or its checkout when it has none; the
strip can switch it to a new worktree. Until its first message, that draft
lives in the view's state rather than the draft store, so it adds no sidebar
row (`apps/web/src/components/localDraftSession.ts`). Window-level shortcuts, typing, and
paste go to the chat that holds focus or was clicked last
(`apps/web/src/components/chat/composerEventScope.ts`). Clicking into one
chat blurs the other chat's composer and rests it into its compact bar.

## Mac app

The packaged app is `T3 Work` with bundle ID `com.volumbe.t3code`. Earlier
builds were named `T3 Code (Vivek)`; the rename keeps the same bundle ID and
data directories, so saved connections carry over.
It stores its desktop state (saved connections, client settings) in
`~/.t3-vivek/userdata` and its Electron data in
`~/Library/Application Support/t3code-vivek`. Its local backend uses the
upstream app's `~/.t3` server state, so local threads appear in both apps
(`apps/desktop/src/backend/DesktopSharedBackendHome.ts`). Never run the two
apps' local backends at once: when the upstream app's backend is running, T3
Work starts its local backend on `~/.t3-vivek` instead and shows no local
threads until it is relaunched with the upstream app closed. It does not register as the
macOS handler for `t3code://` links, so the upstream app can stay installed.
The local build has no automatic update feed. Rebuild it when this fork moves
to a newer upstream release.

The Mac app icon uses the Virtual Office `VO` monogram from Nextcard's
`apps/office/src/features/app-shell/office-mark.tsx`. Its vector source is
`assets/vivek/office-vo-macos.svg`. Regenerate the PNG after changing the SVG:

```sh
sips -s format png assets/vivek/office-vo-macos.svg \
  --out assets/vivek/office-vo-macos-1024.png
```

Install dependencies with `vp i`. Build the macOS app at the release version
used by the connected Ubuntu server. Keep the repository's `node_modules/.bin`
first on `PATH`: the build installs into a staging folder without
`node_modules`, and a global `vp` shim there can recurse through `pnpm exec`:

```sh
PATH="$PWD/node_modules/.bin:$HOME/.cargo/bin:$PATH" \
  env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version 0.0.46-nightly.20261012.3035
```

The DMG and ZIP go to `release/`. Quit the fork before replacing it. To install
the ZIP on this Mac:

```sh
ditto -x -k release/T3-Work-0.0.46-nightly.20261012.3035-arm64.zip /Applications
codesign --force --deep --sign "Apple Development" '/Applications/T3 Work.app'
codesign --verify --deep --strict '/Applications/T3 Work.app'
```

Sign with the Apple Development certificate, not ad hoc (`--sign -`). An ad hoc
signature changes with every build, so macOS treats each build as a new app
and asks again for the "t3code Safe Storage" keychain item even after "Always
Allow". The certificate keeps the signature's designated requirement stable.
Distribution to another Mac requires Developer ID signing and notarization. On first launch, turn off the local environment
in Settings > Connections, then pair the private `ubuntu` environment. The
fork has separate saved connections and needs its own pairing. Do not copy
credentials between the two apps. This Mac's local environment was turned off
before first launch; turn it back on to show the shared local threads.

## Taking upstream releases

Nightly builds use the same app name, bundle ID, VO icon, and Electron profile as stable builds. Before packaging, set the release package versions with `node scripts/update-release-package-versions.ts <version>` so the app and bundled server report the artifact version.

Keep `origin` pointed at `volumbe/t3code` and `upstream` at
`pingdotgg/t3code`. Merge the selected upstream release tag into `main`,
resolve any conflicts in this small customization, then rebuild with that
release's version. Update the private Ubuntu T3 service to the matching
version during a quiet period. The machine repository's `update-t3-release`
skill runs the whole release: this fork, the private server, and, only when
explicitly in scope, the Office T3 overlay and workers.
