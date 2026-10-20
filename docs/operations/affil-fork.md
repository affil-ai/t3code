# Affil fork operations

This document records the safe operating boundary for the Affil T3 Work fork.
It intentionally excludes credentials, private addresses, SSH keys, and
machine administration details.

## Repository roles

- `affil-ai/t3code` is the canonical fork.
- `pingdotgg/t3code` is the upstream source.
- The fork's `main` is the source for Affil releases.
- Firstmate requires the fork's server and contracts.
- Office worker source remains in `affil-ai/nextcard`.

## Host roles

- Ubuntu initiates releases and builds Linux.
- Ubuntu stages the production web payload.
- The Mac builds and signs macOS.
- The existing private web service publishes `t3.olumbe.com`.
- The detached fork installer performs activation after live gates pass.

Host access, service names, and credentials belong in the machine's private
runbooks. This repository should use configured host aliases and environment
paths supplied by the release command. It must not embed those values.

## Operational rules

- Use the paired workflow in `fork-release.md`.
- Do not use upstream GitHub Actions release channels.
- Do not run a Mac-only install as if it released Ubuntu or the web.
- Do not interrupt active T3 or Office work to create idle time.
- Do not change Office source or move it into this repository.
- Do not change credentials or security settings as part of a release.
- Verify the live API, install receipts, web metadata, and authenticated
  browser separately.

## Project registration

The Ubuntu T3 project must point to the live fork checkout. A checkout rename
must update the registered project path and future worktree setup together.
Do not edit production database rows or guess a project path from old notes.

The project setup command must:

1. use the repository's declared package manager;
2. put the repository's `node_modules/.bin` first on `PATH`;
3. install dependencies in a new worktree;
4. avoid global `vp` recursion;
5. leave the shared live T3 state untouched.
