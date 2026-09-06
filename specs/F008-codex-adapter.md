# Feature: Codex Adapter

## Goal

Add Codex as the third harness: identical product surface, third implementation of
the SPI — completing phase-1 harness coverage and proving the adapter pattern at
scale.

## Background

Depends on F003 (SPI/AEP), benefits from F004 (approval loop) and the F007 rig
(contract fixtures, e2e parity). Codex runs headless with structured event output
and workspace-sandbox modes; its sandbox/approval model maps onto Omni's approval
loop.

## User Flow

Identical to F007 with Codex in the picker: dispatch, converse live, approve
sandbox escalations, cancel, resume; run page labels the harness.

## Requirements

- Adapter `codex` implements the SPI over Codex's headless mode: translate its
  event stream → AEP; `send()` for mid-run input; `ref()` for resumable threads;
  cancel via executor policy.
- Sandbox/approval mapping: requests that would escalate privileges (network
  access, writes outside the workspace) surface as `approval.requested`; decisions
  map back to the pending action.
- Default sandbox: workspace-write with network disabled unless a run requests
  otherwise (v1 default; configurable later).
- Harness inventory reports Codex version + auth state.

## Business Rules

- Same boundary rules as F007: no undocumented flags; contract tests pin the
  mapping; CLI auth is the host's concern.
- Omni never widens a sandbox beyond what the user approved in the approval card.

## Edge Cases

- Sandbox denial without an approval path → surfaces as a `tool.result` with
  `isError`, visible in the tool card.
- Resume/thread id invalidated → clear error; handoff (F009) is the fallback.
- Model unavailable (quota/plan) → `failed` with the CLI's error text.

## API / Data Changes

None beyond `harness: "codex"` values.

## Acceptance Criteria

- [ ] Dispatch, live conversation, approvals, cancel, and continue all work with
      Codex through the unchanged product surface.
- [ ] Sandbox escalation requests render as approval cards and decisions apply.
- [ ] `pnpm e2e` passes with Codex as the harness (three-way parity).
- [ ] Contract tests cover recorded fixtures for every emitted event type.

## Implementation Plan

### Step 1: Contract fixtures — capture transcripts, define AEP mappings.
### Step 2: Adapter implementation — spawn, stream parse, send/cancel/ref, approval
and sandbox mapping, resume.
### Step 3: Registration + three-way e2e parity + manual smoke (macOS/Linux).

(Steps mirror F007's plan; see there for the goal/tests/verification pattern.)

## Test Plan

Contract fixtures → AEP; e2e three-way parity matrix (fake, OpenCode, Codex);
manual smoke checklist.

## Open Questions

- Default sandbox preset (proposed: workspace-write, no network) — confirm?
- Resume support depth: full thread resume vs new-thread-with-context in v1?
