# Roadmap

Phase 1 delivers the v1 product defined in [docs/PRODUCT.md](../docs/PRODUCT.md):
a single-user, Tailscale-hosted window for dispatching tasks to, and conversing
with, agents on your own hosts. The shortest credible path runs through the
keystone feature F003 (interactive runs with the first adapter); everything before
it exists to make that real, everything after it hardens and widens it.

## Features

| ID    | Feature                                  | Status | Spec                                |
| ----- | ---------------------------------------- | ------ | ----------------------------------- |
| F001  | Host enrollment & live connection        | Done   | specs/F001-host-enrollment.md       |
| F002  | Workspace management                     | In Progress | specs/F002-workspaces.md       |
| F003  | Interactive runs (OpenCode adapter)      | Draft  | specs/F003-interactive-runs.md      |
| F004  | Approvals                                | Draft  | specs/F004-approvals.md             |
| F005  | Artifacts & task acceptance              | Draft  | specs/F005-artifacts-acceptance.md  |
| F006  | Git worktree parallelism                 | Draft  | specs/F006-worktree-parallelism.md  |
| F007  | Claude Code adapter                      | Draft  | specs/F007-claude-code-adapter.md   |
| F008  | Codex adapter                            | Draft  | specs/F008-codex-adapter.md         |
| F009  | Harness handoff (Task Context)           | Draft  | specs/F009-harness-handoff.md       |
| F010  | Session attach & adopt                   | Draft  | specs/F010-attach-sessions.md       |

Status values:

- **Draft** — described in a spec, not yet scheduled.
- **Next** — selected as the next feature to build (`project-dev` picks this up;
  keep exactly one Next at a time).
- **In Progress** — currently being implemented by `project-dev`.
- **Done** — implemented and verified.

## Notes

- **Sequencing**: F001 → F002 → F003 is the vertical spine (connect a host, give it
  a repo, run and converse). F004/F005 make real work safe and reviewable; F006
  lifts the one-run-per-workspace lock that F003 ships with; F007/F008 reuse the
  SPI and contract-test rig from F003; F009 is the capstone.
- **F003 is the keystone**: the AEP protocol, adapter SPI, and fake harness land
  there. Later adapters (F007, F008) must not require product-level changes — if
  they do, the SPI is wrong and gets fixed first.
- **Deliberately deferred**: DSH adapter, multi-user, PR automation, PWA/push
  notifications, scheduled tasks, event retention/pruning, usage metering.
- **F010 (attach & adopt)** exists because the owner requires access to sessions
  Omni did not start. It can be scheduled any time after F003 — the SPI F003 ships
  is already attach-capable, so F010 adds no protocol rework.

## Tracking

GitHub mode (owner decision 2026-09-07). Each feature is developed on a branch
`feat/F<nnn>-<slug>` cut from `main` and delivered as a pull request to `main`
(one commit per implementation step, spec updated in the same PR). No CI checks
are configured yet; "green" means the spec's recorded local verification
(`pnpm test` / `test:integration` / `e2e` / `typecheck`). Solo repository without
review requirements: the agent merges when green, unless the owner says
otherwise for a specific PR. Force operations, branch deletion, releases, and
deployments always need explicit per-action authorization.
