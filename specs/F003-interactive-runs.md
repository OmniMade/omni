# Feature: Interactive Runs (OpenCode Adapter)

## Goal

The keystone: dispatch a task to a host, have OpenCode execute it, watch every
message/tool call/log stream live, and **converse with the agent mid-run** — plus
cancel and continue. Ships the Agent Event Protocol, the Harness Adapter SPI, and
the fake harness that every later feature tests against.

## Background

Depends on F001 (channel) and F002 (workspaces). Establishes the contract described
in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md): adapters live only in hostd;
the server and UI consume AEP events and know nothing about OpenCode specifics.
Until F006, runs execute directly in the workspace root under a
one-active-run-per-workspace lock. OpenCode is the first adapter because its
headless session API is documented and it runs anywhere Bun/Node does.

## User Flow

1. **Dispatch a task**: operator opens a workspace, writes title + instructions,
   picks the OpenCode harness (the only one for now), and sends. A run page opens.
2. **Watch**: `run.started`, then a live conversation — agent messages as bubbles,
   tool calls as collapsible cards, raw stdout/stderr as an inline log tail.
3. **Converse**: the composer at the bottom is always available; the operator sends
   "actually use pnpm, not npm" mid-run and the agent replies in the same thread.
4. **Ad-hoc chat**: from a workspace, "Quick session" opens a run with no task —
   `task_id` null — for questions and exploratory work.
5. **Cancel**: the cancel button stops the run (graceful, then force) and the run
   ends `cancelled`.
6. **Continue**: on a finished run, "Continue" starts a new run that resumes the
   same OpenCode session; the conversation history carries over and the UI shows
   the lineage link.

## Requirements

- `POST /runs` with `{ taskId }` (task dispatch) or `{ workspaceId, message }`
  (ad-hoc chat); run created `queued`, delivered via `cmd.start_run`.
- Executor starts the OpenCode adapter in the workspace root (F006 moves this to a
  worktree) under the workspace's active-run lock; concurrent dispatch to the same
  workspace is queued behind the lock.
- Every harness output line is translated to an AEP event; hostd assigns per-run
  gapless `seq` and journals each event write-ahead before sending (ARCHITECTURE →
  Run Journal & Crash Recovery); server persists to `run_events` (unique
  `(run_id, seq)`) and fans out to `/api/v1/ws/ui` subscribers.
- `POST /runs/:id/messages` persists a `user.message` event and delivers
  `cmd.send_message`; on a finished run it is rejected with a pointer to Continue.
- Run status machine: `queued → starting → running → finished` with outcome
  `completed | failed | cancelled`; unexpected adapter exit → `failed` with the
  tail of captured output in `error`.
- Cancel: SIGTERM/adapter-graceful first, SIGKILL after 10 s (process group).
- Continue: new run row with `parent_run_id`, `resumeFrom` = previous run's
  `session_ref`; adapter restores the OpenCode session and replays prior
  conversation context.
- Event backfill: `GET /runs/:id/events?after=<seq>`; the UI detects gaps on
  reconnect and backfills before appending.
- hostd restart mid-run: the run journal drives reconciliation — orphaned process
  groups are terminated, the run is marked `failed` (outcome) with a system `error`
  event, and journaled events are replayed so the history has no gaps
  (ARCHITECTURE → Run Journal & Crash Recovery).

## Business Rules

- Messages are events: no separate message store; chat history = event log.
- `user.message` events exist only via the API (never synthesized by adapters).
- Unknown AEP event types are stored and rendered as generic cards (forward
  compatibility), never dropped or rejected.
- The adapter may not mutate anything outside the workspace path.
- Harness auth (OpenCode login/API key) is the host's concern — configured in
  OpenCode's own config on the host; Omni reports "harness not authenticated" as a
  `failed` run with the harness's own error text.

## Edge Cases

- Host offline at dispatch → run stays `queued`, delivered on reconnect.
- OpenCode binary missing on host → run fails fast with a clear `error` event and
  the host page flags the harness inventory.
- User message during `starting` → buffered by the adapter until the session is
  live.
- Run produces zero output for minutes → heartbeat `log.line` (system) every 60 s
  so the UI can show liveness.
- Adapter emits malformed output → captured as `log.line`, never crashes the
  executor.

## UI / UX

- Run page = chat-first: message stream center, composer bottom (mobile: sticky),
  status pill, harness/model label, lineage link to parent run.
- Tool cards collapsible; log tail collapsed by default behind a "raw logs" toggle.
- Ad-hoc quick sessions listed with runs, visually distinguished from task runs.

## API / Data Changes

- Tables: `tasks`, `runs`, `run_events` (see [docs/DATABASE.md](../docs/DATABASE.md)).
- Endpoints: runs dispatch/list/detail/events/messages/cancel/continue (see
  [docs/API.md](../docs/API.md)); channel commands `cmd.start_run`,
  `cmd.send_message`, `cmd.cancel_run`.
- Packages: `packages/aep` (envelope + zod schemas), adapter SPI
  (`apps/hostd/src/harness/spi.ts`), fake harness (`harness/fake/`).

## Acceptance Criteria

- [ ] Dispatching a task reaches the host and OpenCode starts in the workspace; the
      run page streams events live in `seq` order.
- [ ] A mid-run user message elicits an agent reply in the same thread.
- [ ] Refreshing (or opening on another device) backfills the full history via
      `?after=` and then streams live.
- [ ] Cancel ends the run `cancelled` within 10 s even if the CLI ignores SIGTERM.
- [ ] Continue resumes the same OpenCode session; lineage (`parent_run_id`) is
      visible in the UI.
- [ ] Ad-hoc quick session works end-to-end with `task_id` null.
- [ ] Killing hostd mid-run reconciles to a `failed` run with complete event
      history after restart.
- [ ] The fake harness passes the identical product-level test suite (used by CI,
      e2e, and web dev without any real harness).

## Implementation Plan

### Step 1: AEP package + fake harness
- **Goal:** `packages/aep` types/schemas; SPI; fake harness that talks a scripted
  conversation, honors send/cancel, and emits every event type. The SPI ships
  attach-capable (`listSessions`, `attach`, capability flag — F010 implements it
  against real harnesses; the fake harness carries working stubs).
- **Tests:** unit tests for schemas, seq assignment, fake harness determinism.
- **Verification:** fake harness drives a hostd executor in a temp dir.

### Step 2: Server run domain + event pipeline
- **Goal:** runs/tasks tables, dispatch API, event persistence, `/api/v1/ws/ui` fan-out,
  gap detection contract.
- **Tests:** integration tests with testcontainers PG (sequencing, backfill,
  queued-while-offline).
- **Verification:** api-client dispatch against fake harness shows live events.

### Step 3: OpenCode adapter
- **Goal:** headless session via OpenCode's programmatic API; translation to AEP;
  session ref capture for resume; approval plumbing stubbed (F004 completes it).
- **Tests:** contract tests from recorded OpenCode output fixtures.
- **Verification:** real OpenCode run on a dev machine, full conversation flow.

### Step 4: Run view UI
- **Goal:** chat stream, composer with optimistic send, tool/log cards, status,
  lineage, backfill-on-reconnect.
- **Tests:** store tests for gap backfill and optimistic reconciliation.
- **Verification:** phone-sized browser session steering a live run.

### Step 5: Cancel, continue, reconciliation
- **Goal:** process-group cancel with escalation; resume flow; hostd-restart
  reconciliation.
- **Tests:** integration tests for kill escalation and reconnect reconciliation.
- **Verification:** acceptance criteria above pass via `pnpm e2e`.

## Test Plan

Unit: AEP schemas, seq/gap logic, adapter translation (fixtures). Integration:
dispatch→events→message→cancel→continue against fake harness over real WS + PG.
E2E: `pnpm e2e` full script (enroll → workspace → task → dispatch → chat → cancel →
continue). Manual smoke: real OpenCode on macOS and Linux.

## Open Questions

- Default model for OpenCode runs, and whether model choice belongs in the dispatch
  form (proposed: harness default in v1, model picker post-v1).
- Should idle (no-output) runs time out automatically, and after how long?
- One-active-run-per-workspace lock until F006 — acceptable for dogfooding?
