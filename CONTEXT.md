# Affil T3 Work context

This repository is the canonical source for Affil's T3 Work fork. It contains
the T3 Work client, the Firstmate server, and the host-local release workflow.

## Canonical sources

- Fork: `affil-ai/t3code`
- Upstream: `pingdotgg/t3code`
- Fork releases build from an exact commit on Affil `main`.
- Never overwrite newer Affil work with an upstream tree.
- Never force-push or delete repository history as part of a normal release.

## Release language

- **Request** reserves one fork version for one source commit.
- **Build** creates a host-specific artifact.
- **Exchange** transfers paired artifacts and verifies checksums.
- **Qualification** checks installed source, protocol, schema, and Office
  compatibility.
- **Activation** installs the runtime and publishes the matching web payload.
- **Receipt** is durable evidence for one host or target.
- **Paired release** means matching Linux, macOS, and web outputs from one
  source commit and one fork version.

Preparation, qualification, activation, and browser verification are separate
states. A build receipt is not an install receipt. An install receipt is not
web verification.

## Affil release shape

Ubuntu initiates the release and builds Linux plus the production web payload.
The Mac builds and signs macOS. The hosts exchange and verify artifacts.
Activation runs only after the live activity and compatibility gates pass.

The canonical guide is
[`docs/operations/fork-release.md`](docs/operations/fork-release.md).
The reusable procedure is
[`.agents/skills/affil-release/SKILL.md`](.agents/skills/affil-release/SKILL.md).

## Ownership boundaries

- Firstmate requires this fork's server. A stock published `t3` server hides
  Firstmate.
- The Office worker source remains in `affil-ai/nextcard`.
- Office worker changes are not moved into this repository.
- The machine repository is not a runtime dependency of this repository.
- GitHub Actions are not the Affil fork release mechanism.
- `t3.olumbe.com` is the private Affil web target.

## Safety boundaries

- Preserve active T3 and Office work. Do not cancel work to make a host idle.
- Keep Apple signing material on the Mac.
- Do not commit or print credentials, tokens, private environment files, SSH
  keys, private addresses, or customer data.
- Keep release state outside Git.
- Remove only verified disposable build directories after a release. Keep
  requests, manifests, receipts, logs, current artifacts, and the immediate
  previous known-good artifacts.
