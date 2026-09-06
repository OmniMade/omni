# Feature: Session Attach & Adopt

## Goal

Let Omni remote-control harness sessions it did not start: **live-attach** to a session
already running on the host (where the harness exposes a session API — OpenCode server
mode), and **adopt** a stored, not-currently-live session of any phase-1 harness as a
new Omni run. This delivers the owner's requirement of accessing already-open sessions
at the API level; terminal/pty bridging of TUI sessions is explicitly out of scope.

## Background

Owner decision (2026-09-06, verification finding #1): a dispatch-only product was
rejected. Feasibility is harness-dependent: OpenCode runs a headless server
(`opencode serve`) with a documented SDK, so live sessions there can be joined
bidirectionally. None of the three harnesses expose a live external API for TUI
sessions, but all three store sessions that can be resumed headlessly
(`claude -p --resume <id>`, `codex exec resume <thread-id>`, OpenCode session by id).

The design reuses existing machinery rather than adding a parallel one:
**attach = `attach(ref)` joining a live session through the harness's session API;
adopt = `start()` with `resumeFrom` = a foreign session's ref** (the F003 resume path).
The SPI grows `listSessions()` and `attach()` plus an `attach` capability flag;
capabilities are declared, not assumed, exactly like `resume`.

Depends on F003 (SPI, runs, resume plumbing). Independent of F006+ (attached and
adopted sessions run in the workspace root, never in Omni worktrees).

## User Flow

1. The host page gains a **Sessions** tab: discovered sessions per harness — live
   OpenCode server sessions and stored sessions of all detected harnesses — with
   title, working directory, and last-active time.
2. **Attach**: pick a live session → a run page opens (origin `attach`); the prior
   transcript replays, new events stream live, and the composer steers the session.
3. **Detach**: ends the Omni view with outcome `detached`; the harness session keeps
   running on the host and can be re-attached later.
4. **Adopt**: pick a stored session → a new run (origin `adopt`) resumes that
   session's context in its original working directory; everything downstream
   (chat, approvals, artifacts, acceptance) is the standard run flow.

## Requirements

- `listSessions()` per adapter returns foreign sessions with a `live` flag, `cwd`,
  optional title and `lastActiveAt`. Discovery runs on demand (Sessions tab,
  attach/adopt picker), never automatically in heartbeats.
- `attach(ref)` joins a live session; the adapter replays the session's prior
  transcript as AEP events (best effort, capped, with a truncation note) and then
  streams live events under the run's `seq`.
- Adopt is a dispatch whose `StartSpec.resumeFrom` is the foreign ref; transcript
  replay is likewise best-effort and capped.
- Attached run: `origin = attach`, `task_id` null, workspace resolved from the
  session's `cwd` (must match a registered workspace root); cancel means **detach**
  (outcome `detached`); the harness session is never killed by Omni.
- Adopted run: standard Omni supervision — cancel escalates and kills as usual.
- Stored sessions whose transcript was written very recently (still-active TUI) are
  refused for adopt with an explicit "session appears active" error.
- Channel command `cmd.list_sessions` carries discovery requests; results return as a
  command `result`, not as AEP events.

## Business Rules

- Omni never kills a session it did not start: detach is the only end for attached
  runs.
- Attach/adopt require the session's `cwd` to match a registered workspace root
  (worktrees are Omni-managed and excluded); otherwise the action is refused with a
  pointer to register the workspace.
- Adopt does not mutate the source session's storage; whether the resumed thread
  shares the harness's own history is harness behavior, surfaced honestly in the UI.
- Approvals in attached sessions are mediated only when the session API exposes them;
  otherwise they degrade to `log.line` and the run header notes that decisions happen
  in the harness's own interface. Omni never fabricates an approval capability.

## Edge Cases

- OpenCode server not running → no live sessions listed; stored OpenCode sessions
  still appear with `live = false`.
- Stored transcript unreadable or corrupt → adopt proceeds; replay degrades to a
  single context-note event.
- Live session disappears mid-attach (server stopped) → the attached run ends
  `failed` with the harness's error; the session storage is untouched.
- Two clients steer one live session (Omni + another SDK client) → both streams
  converge harness-side; Omni renders what the session reports.
- Session listed at discovery time but gone at attach/adopt time → fail fast with a
  clear "session not found; refresh the list" error.

## UI / UX

- Sessions tab: harness-grouped list, live/stored badges, workspace-match indicator,
  Attach/Adopt actions gated by adapter capabilities.
- Attached run view: the standard run page with an "Attached" origin pill, Detach
  instead of Cancel, and no branch/worktree label.

## API / Data Changes

- SPI: `listSessions()`, `attach()`, capability `attach`, `ForeignSession` type (see
  ARCHITECTURE → Harness Adapter SPI).
- `GET /hosts/:id/sessions?harness=` → discovered sessions (live + stored).
- `POST /runs` gains `{ harness, attachRef }` and `{ harness, adoptRef }`; the server
  resolves the workspace from the discovery result's `cwd`.
- `runs.origin` (`dispatch`/`adopt`/`attach`, default `dispatch`); `runs.outcome`
  gains `detached`; AEP `run.started` gains `origin?` (see DATABASE).

## Acceptance Criteria

- [ ] The Sessions tab lists live OpenCode server sessions and stored sessions for
      every detected harness, with correct live flags and workspace matches.
- [ ] Attaching to a live OpenCode server session from another device replays the
      prior transcript, streams live events, and a sent message elicits a reply
      visible in the other client as well.
- [ ] Detach ends the Omni run with outcome `detached`; the harness session keeps
      running and can be re-attached.
- [ ] Adopting a stored session of each phase-1 harness starts a briefed run in the
      right workspace whose first reply demonstrates carried-over context.
- [ ] Adopt is refused for sessions that appear active and for `cwd`s outside
      registered workspaces, with actionable errors.
- [ ] The fake harness exposes attachable and adoptable sessions, so the full loop
      (list → attach → steer → detach; list → adopt → continue) runs in CI offline.

## Implementation Plan

### Step 1: SPI surface + fake harness
- **Goal:** `listSessions`/`attach`/capability in the SPI; fake harness with one
  live attachable session and one stored adoptable session, including transcript
  replay.
- **Scope:** `apps/hostd/src/harness/spi.ts`, fake harness, `packages/aep` (origin
  field).
- **Tests:** unit/contract on the fake harness: discovery flags, replay capping,
  detach semantics.
- **Verification:** fake-harness attach run driven end-to-end in a temp dir.

### Step 2: Discovery + dispatch API
- **Goal:** `cmd.list_sessions`, `GET /hosts/:id/sessions`, `POST /runs`
  attach/adopt variants, `origin`/`detached` in the state machine, workspace
  resolution and guards.
- **Scope:** server run domain, host channel, `runs` migration.
- **Tests:** API integration: attach lifecycle, adopt guards, detach outcome,
  workspace mismatch refusal.
- **Verification:** curl round-trip against the fake harness over real WS + PG.

### Step 3: OpenCode adapter
- **Goal:** server-mode discovery, live attach (join + steer), stored adopt, approval
  mediation or declared degradation.
- **Scope:** `harness/opencode/` adapter.
- **Tests:** contract tests from recorded OpenCode server fixtures.
- **Verification:** real attach from a phone over Tailscale; second client sees the
  same conversation.

### Step 4: UI
- **Goal:** Sessions tab, attach/adopt pickers, origin pill, Detach action.
- **Scope:** hosts pages, run view.
- **Tests:** store/component tests for discovery list and detach transitions.
- **Verification:** phone-sized browser completes attach → steer → detach.

### Step 5: Claude Code & Codex adopt
- **Goal:** stored-session discovery + adopt for both CLIs (no live attach —
  capability `attach: false`).
- **Scope:** `harness/claude/`, `harness/codex/` adapters.
- **Tests:** contract fixtures for stored-session listing and resume.
- **Verification:** manual smoke on macOS and Linux; roadmap update.

## Test Plan

Contract: discovery/attach/adopt fixture corpora per harness. Integration: attach
lifecycle incl. detach semantics, adopt guards, re-attach after detach. E2E: the
standard script gains the fake-harness attach → steer → detach and adopt → continue
segments. Manual: real OpenCode server session steered from a phone.

## Open Questions

- Approval mediation depth in OpenCode server sessions — verify against fixtures in
  Step 1/3; fallback (degrade to `log.line`) is defined either way.
- Transcript replay cap (proposed: most recent 200 events / 64 KB, then a truncation
  note) — comfortable?
