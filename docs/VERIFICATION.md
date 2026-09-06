# Verification Report

Pass of **2026-09-06**. Working tree is **not a git repository** (no commit to pin).
Documents read: `README.md`, all of `docs/` (PRODUCT, ARCHITECTURE, DATABASE, API,
FRONTEND, TESTING), `specs/ROADMAP.md`, and all nine feature specs (F001–F009).

Scope note: the project is **design-phase by its own declaration** — README states the
commands are "targets the roadmap delivers, not yet present in the repository", and the
repo indeed contains zero implementation (only `README.md`, `docs/`, `specs/`). There is
nothing executable to run, so this pass verifies three things instead: **(a) design vs
the owner's stated intent** (deployable on a Mac mini or Linux host; remote access to
multiple harnesses on that machine), **(b) internal consistency of the documents**,
and **(c) the external feasibility claims** the design rests on (the three harnesses'
headless capabilities).

**Resolution log (2026-09-06, design revision):** findings #1–#3 were turned into
work the same day — #1 by owner decision (API-level attach + adopt; new spec
`specs/F010-attach-sessions.md`), #2 by the Run Journal & Crash Recovery design
(`docs/ARCHITECTURE.md`), #3 by the `host_commands` table (`docs/DATABASE.md`).
Findings #4–#12 were resolved in a follow-up pass the same day: #4 F002 adopt
hygiene decided warn-only and both sections aligned (open question retired); #5
`cmd.workspace_clone` added to the channel command list; #6 `POST /runs/:id/discard`
and `PATCH /hosts/:id` documented in API.md and F006; #7 unknown-AEP-type semantics
aligned to store-and-render-generic-card; #8 `approval.resolved` decision vocabulary
enumerated (approve/deny/expired); #9 WebSocket paths canonicalized to
`/api/v1/ws/*` across docs and specs; #10 enrollment exchange pinned to
`POST /hosts/enroll` (REST exchange, then credential-authenticated WS); #11 the
SQLite trade-off recorded in the architecture decisions table (PostgreSQL kept
deliberately); #12 repository initialized as git with an initial commit. No
findings from this pass remain open.

## Verified Promises

| Promise (source)                                                             | Evidence                                                                 | Result |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| README: design phase, commands are targets, not yet present                   | Repo contains only `README.md`, `docs/`, `specs/` — no code, no `package.json` | Verified (status is honest) |
| ROADMAP rule: exactly one `Next` at a time, none falsely `Done`               | F001 = `Next`, F002–F009 = `Draft`; no `Done`/`In Progress` claims exist  | Verified |
| Owner intent: deployable on Mac mini / Linux host                             | ARCHITECTURE Deployment: hostd as single binary under launchd/systemd; control plane may run on one of the hosts; F001 AC pins `bun build --compile` for macOS arm64 + Linux x64/arm64 | Verified (covered by design) |
| Owner intent: remote access over the network, hosts behind NAT                | Outbound-only WSS host channel, no inbound host ports; web UI + Tailscale; conversation/approval from any device (PRODUCT core cases 1, 3–6) | Verified (covered by design) |
| Owner intent: multiple harnesses on one machine                              | Adapter SPI in hostd; F003/F007/F008 deliver OpenCode + Claude Code + Codex; F009 handoff; F007/F008 acceptance explicitly requires zero server/UI changes | Verified (covered by design) |
| F003 premise: OpenCode has a documented headless session API                 | opencode.ai docs: `opencode serve` headless HTTP server + official JS/TS SDK with session management | Verified (public docs) |
| F007 premise: Claude Code headless streaming JSON + resume by session id     | code.claude.com headless docs: `-p`, `--input-format/--output-format stream-json`, `--resume <session-id>`, permission modes | Verified (public docs) |
| F008 premise: Codex headless structured events + resumable threads           | `codex exec --json` event stream; `codex exec resume <thread-id>`/`--last`; sandbox + approval-policy flags | Verified (public docs) |
| DATABASE schema covers every spec's declared data changes                    | Cross-read: workspaces/tasks/runs/run_events/approvals/artifacts, `task_id` nullable (F003 ad-hoc), `parent_run_id` + `session_ref` (F003/F009), `tasks.acceptance` (F005), artifact kinds incl. `report` (F009) all present | Verified |
| AEP event vocabulary consistent across documents                             | Same 12 event types used consistently in ARCHITECTURE, F003–F005, F009     | Verified |
| All F001–F009 acceptance criteria                                            | No implementation exists to produce executable evidence                  | Unverified (expected at this stage) |

## Findings

| # | Finding | Evidence | Affected document / spec | Severity | Recommended next work |
| --- | --- | --- | --- | --- | --- |
| 1 | The design only supports harness sessions **started by Omni**. There is no capability to attach to a harness session started outside Omni (e.g. an OpenCode TUI already running in tmux). The owner's phrasing "远程访问本机的多个harness" is ambiguous between this and the documented model. If attach-mode is wanted, it changes the adapter SPI (`start()` vs `attach()`) and should be decided before F003. | SPI (ARCHITECTURE) has only `start(spec)`; PRODUCT scope is dispatch-centric; OpenCode upstream has an open feature request for attaching to a running server session (anomalyco/opencode#3165, #5256), i.e. attach is feasible upstream but untracked here | PRODUCT scope, ARCHITECTURE SPI, F003 | **High** (decision, not a bug) | Owner decides: dispatch-only (current design, fine) vs add an attach-mode feature spec post-v1 or into F003 |
| 2 | The "no gaps in `seq` after hostd dies mid-run" promise is not achievable as specified: ARCHITECTURE says hostd is **stateless across restarts** and no durable per-run event journal on the host is specified anywhere. Events emitted but undelivered at crash time are lost → permanent gap, contradicting PRODUCT success criterion 4 and F003 AC 7. | PRODUCT Success Criteria; F003 Requirements/AC; ARCHITECTURE Host Channel ("stateless across restarts") | PRODUCT, F003, ARCHITECTURE | Medium | Specify a hostd write-ahead journal per run (persist before send, replay undelivered on reconnect), or explicitly weaken the guarantee (server detects the gap and seals it with a system `error` event) |
| 3 | The offline command queue is promised but not designed: ARCHITECTURE says commands are "queued in DB if the host is offline"; F001 Step 3 scopes "command queue table behavior"; DATABASE.md defines **no such table**. | ARCHITECTURE Data Flow; F001 Step 3; DATABASE table list | ARCHITECTURE, F001, DATABASE | Medium | Decide: explicit `host_commands` table (add to DATABASE.md) or derive-on-reconnect from run/approval state; document whichever |
| 4 | F002 contradicts itself on adopting dirty checkouts: Requirements say adopt "must be a … clean clone", Edge Cases say a dirty adopted path is "allowed with a warning badge", and Open Questions still asks which. | F002 Requirements vs Edge Cases vs Open Questions | F002 | Low | Resolve the open question and align the two sections |
| 5 | Host-channel command list drift: ARCHITECTURE lists five server→host commands but omits `cmd.workspace_clone`, which F002 defines. | ARCHITECTURE Host Channel; F002 API/Data Changes | ARCHITECTURE, F002 | Low | Add `cmd.workspace_clone` to the command list |
| 6 | F006 introduces a "discard worktree" action and host config `maxConcurrentRuns`, but API.md documents no endpoint or configuration surface for either. | F006 Requirements vs API.md | F006, API | Low | Add the discard endpoint (e.g. `POST /runs/:id/discard`) and host-config surface to API.md when F006 is scheduled |
| 7 | Unknown-AEP-type semantics disagree: ARCHITECTURE says "ignored, not rejected"; F003 says "stored and rendered as generic cards". Storing is required for backfill consistency. | ARCHITECTURE AEP rules vs F003 Business Rules | ARCHITECTURE, F003 | Low | Align wording to: server stores unknown types; UI renders generic cards |
| 8 | `approval.resolved` decision vocabulary is undefined where it matters: F004 emits decision `expired`, the AEP table lists only "approvalId, decision, note?", and the SPI's `resolveApproval` is `"approve" \| "deny"`. | F004 Business Rules vs ARCHITECTURE AEP/SPI | F004, ARCHITECTURE | Low | Enumerate decision values (`approve/deny/expired`) in the AEP schema; keep SPI at approve/deny |
| 9 | WebSocket path prefix ambiguity: ARCHITECTURE's diagram says `GET /api/v1/ws/host`; API.md's WebSocket section lists `/ws/host`, `/ws/ui` without stating the prefix. | ARCHITECTURE Host Channel vs API.md | ARCHITECTURE, API | Low | Pick one path form and use it in both |
| 10 | Enrollment-token exchange mechanism is described two ways: API.md says the credential is issued "during the WS handshake"; F001 says hostd "exchanges the token … and keeps a WSS connection open" (reads as REST-then-connect). | API.md Conventions vs F001 User Flow | API, F001 | Low | Pin the mechanism (recommended: one REST exchange, then WS connect with the credential) |
| 11 | PostgreSQL is the heaviest piece of a single-Mac-mini deployment (brew/compose dependency) for a single-user system; the alternatives table considered event-stream infra but not SQLite/LiteFS. | ARCHITECTURE Deployment + Key Technical Decisions | ARCHITECTURE | Low (decision confirmation) | Confirm PG deliberately (defensible: JSONB events, one engine); if minimizing host ops matters more, record the SQLite trade-off before F001 scaffolding |
| 12 | The repo is not a git repository, so future passes cannot pin a commit and implementation work has no history. | `ls -la` — no `.git/` | repo | Low | `git init` + initial commit of docs/specs before F001 starts |

Not a finding but worth recording: Codex's headless `exec` mode interacts approvals
differently from Claude Code (approval policy + sandbox interplay; prompts effectively
bypassed under some sandbox configurations). F008's mapping assumption is plausible but
its fixture capture (Step 1) should validate the approval surface early — partially
acknowledged in F008's open questions.

## Not Exercised

- All documented commands (`pnpm dev/build/test/test:integration/e2e`) — targets only;
  no code exists to run. Re-run this verification after F001 lands.
- Every F001–F009 acceptance criterion — Unverified by definition at design phase.
- Live-harness behavior (real OpenCode/Claude Code/Codex runs) and Tailscale
  deployment flows — require external binaries, credentials, and a Tailnet; the
  design's fixture-based offline contract tests are the right proxy for now.
- Design-vs-intent question #1 above needs the owner's answer; this pass recorded it
  rather than guessing.
