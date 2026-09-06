# Feature: Claude Code Adapter

## Goal

Add Claude Code as a second harness: dispatch a task to it, converse mid-run,
approve its permission requests, and resume sessions — through the exact same
product surface, with zero server or UI changes.

## Background

Depends on F003 (SPI, AEP, contract-test rig), F004 (approval loop). This feature
is the first real test of the architecture's promise: **if adding a harness
requires product-level changes, the SPI is wrong and must be fixed first.**
Claude Code runs headless with streaming JSON I/O and supports resuming sessions
by id — chat and resume capabilities are both native.

## User Flow

1. The host page shows Claude Code in the harness inventory once its CLI is
   detected and authenticated.
2. At dispatch (or continue/handoff), the harness picker now offers OpenCode and
   Claude Code.
3. Everything else — live stream, chat, approvals, cancel, artifacts, acceptance —
   behaves identically; the run page labels the harness.

## Requirements

- Adapter `claude-code` implements the SPI: start in headless streaming mode,
  translate CLI JSON events → AEP (`agent.message`, `tool.call/result`,
  `approval.requested` on permission prompts, `log.line` fallback).
- `send()` delivers mid-run user input into the live session; `cancel()` escalates
  per executor policy; `ref()` returns the session id for resume; continue flow
  passes `resumeFrom` through the CLI's resume mechanism.
- Permission prompts map to the F004 approval loop, including permission modes
  where the CLI asks once per tool.
- Model selection: CLI's configured default in v1.
- Harness inventory on the hosts page reflects detected version and auth state
  (reported by `detect()`), not just binary presence.

## Business Rules

- Claude Code authentication (subscription or API key) is configured in Claude
  Code's own config on the host; Omni surfaces auth failures verbatim.
- Adapter must not depend on undocumented CLI flags: flags in use are pinned in
  fixtures, and a CLI version bump that breaks the contract tests fails CI loudly.

## Edge Cases

- CLI not installed/not authenticated → dispatch fails fast with actionable error
  (same as F003's missing-harness path).
- Permission-mode configurations that auto-approve (e.g. accept-edits) → no
  `approval.requested` events; that's correct behavior, not a bug.
- Streaming output that pauses on rate limits → heartbeat `log.line` keeps the UI
  informed; eventual failure → `failed` with the CLI's error.
- Session resume after CLI upgrade invalidates session ids → resume fails with a
  clear error; fallback is a handoff run (F009).

## API / Data Changes

None beyond new `harness` value `"claude-code"` flowing through existing fields.

## Acceptance Criteria

- [ ] Dispatching to Claude Code streams a live conversation with tool cards, with
      no server or UI code changes beyond the picker listing.
- [ ] Mid-run messages and approvals work identically to OpenCode.
- [ ] Continue resumes a Claude Code session by id.
- [ ] The full `pnpm e2e` suite passes with Claude Code swapped in for OpenCode
      (one-line harness switch in the e2e config).
- [ ] Contract tests cover recorded fixtures for every AEP event type the adapter
      emits.

## Implementation Plan

### Step 1: Contract fixtures
- **Goal:** capture representative headless session transcripts (messages, tool
  use, permission prompts, completion) as fixtures; define expected AEP mappings.
- **Tests:** the fixtures ARE the tests' inputs.
- **Verification:** mapping table reviewed against real transcripts.

### Step 2: Adapter implementation
- **Goal:** process spawn/management, streaming parse, send/cancel/ref,
  approval plumbing, resume.
- **Tests:** contract tests green offline.
- **Verification:** live dogfood run with real conversation + approval.

### Step 3: Registration + e2e parity
- **Goal:** register in the harness registry; e2e harness-switch config; inventory
  auth-state reporting.
- **Tests:** e2e parity run.
- **Verification:** manual smoke on macOS and Linux; roadmap update.

## Test Plan

Contract: fixture corpus → AEP sequences. E2E: full suite on both harnesses.
Manual: real Claude Code conversation steered from a phone, approval, continue.

## Open Questions

- Which auth setup should the docs assume on hosts — subscription login or API
  key (affects the setup guide, not the code)?
- Permission-mode default for dispatched runs (proposed: CLI default; Omni never
  loosens permissions silently)?
