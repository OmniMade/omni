# Feature: Approvals

## Goal

When the harness asks permission (run a command, write outside the sandbox, use a
credential), the request surfaces as an actionable approval card in the run
conversation; the operator approves or denies from any device and the run continues
or aborts the pending action.

## Background

Depends on F003 (adapter SPI, event pipeline, run view). v1 forwards the
harness's own permission requests — Omni does not build its own tool-policy
engine. The OpenCode adapter stubs approval plumbing in F003; this feature
completes the loop end-to-end and generalizes it for F007/F008.

## User Flow

1. Mid-run, the harness requests permission; the adapter emits
   `approval.requested` (tool, input, reason) and the run shows
   "waiting for approval".
2. An approval card renders inline in the conversation; a global badge counts
   pending approvals across runs.
3. The operator taps Approve (optionally with a note); `cmd.resolve_approval`
   reaches the adapter, the harness proceeds, and an `approval.resolved` event
   renders the outcome in place.
4. Deny works identically; the harness receives the refusal and decides how to
   proceed (typically it aborts the action and continues reasoning).

## Requirements

- `approvals` row created on `approval.requested`, unique per
  (run, harness_ref); status `pending → approved | denied | expired`.
- Decision API persists the decision, emits `approval.resolved`, and delivers the
  command; decisions on already-resolved approvals are idempotent no-ops (return
  current state).
- The run header shows a "waiting for approval" state while any approval is
  pending; the agent's own waiting output still streams.
- Pending approvals survive host disconnect: the decision is stored and delivered
  when the host reconnects; the adapter applies it on receipt.
- Push-style visibility: badge + (optional) browser notification API hook — no
  push infrastructure in v1.

## Business Rules

- Only the admin can decide (single-user v1).
- Approving applies to this one request only — never "always allow" in v1.
- An approval pending beyond the harness's own timeout expires (status `expired`,
  resolved by the harness's refusal path); expiry reflects back as
  `approval.resolved` with decision `expired`.

## Edge Cases

- Host disconnects while pending → decision queued; if the run died meanwhile,
      the decision is recorded and the run's failure stands (no zombie).
- Duplicate `approval.requested` for the same harness_ref → deduplicated.
- Two devices decide simultaneously → first write wins; second gets the final
  state (idempotent response), UI reconciles via the resolved event.
- Adapter crash with approvals pending → approvals auto-expire when the run fails.

## API / Data Changes

- Table: `approvals`. Endpoints: `GET /runs/:id/approvals`,
  `POST /approvals/:id/decide`; channel command `cmd.resolve_approval`; AEP events
  `approval.requested` / `approval.resolved` (already in the protocol).

## Acceptance Criteria

- [ ] A permission request from the harness renders as an approval card within 2 s.
- [ ] Approve resumes the run; deny delivers the refusal; both render the resolved
      state inline.
- [ ] A decision made while the host is offline applies on reconnect.
- [ ] Concurrent decisions from two devices converge to one outcome.
- [ ] Approvals pending on a crashed run expire, with visible final state.
- [ ] The fake harness scripts an approval, so CI covers the full loop.

## Implementation Plan

### Step 1: Approval domain + decision path
- **Goal:** rows, API, idempotency, channel delivery incl. offline queueing.
- **Tests:** integration tests for every edge case above.
- **Verification:** decide-by-curl against fake harness.

### Step 2: Adapter approval plumbing
- **Goal:** OpenCode permission requests → `approval.requested`; resolve maps back
  into the harness session; timeout → expiry path.
- **Tests:** contract tests with fixtures of real permission payloads.
- **Verification:** live OpenCode run paused and resumed from a phone.

### Step 3: UI
- **Goal:** inline cards, waiting state, global badge, resolved rendering.
- **Tests:** store/component tests for pending→resolved transitions.
- **Verification:** two-browser decision race shows convergence.

## Test Plan

Integration: full loop with fake harness over real WS + PG; race and offline
cases. Contract: OpenCode permission fixtures. Manual: real OpenCode approval from
a phone over Tailscale.

## Open Questions

- Default pending timeout before auto-expiry (proposed: harness's own timeout,
  fallback 10 min)?
- Should "deny with note" feed the note text to the agent as context (proposed:
  yes, as part of the refusal)?
