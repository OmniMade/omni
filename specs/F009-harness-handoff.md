# Feature: Harness Handoff (Task Context)

## Goal

Let an in-flight or finished piece of work move to a different harness without
losing the thread: Omni assembles a **Task Context bundle** — task definition,
conversation transcript, repository state, open follow-ups — and seeds a new run on
the chosen harness with it. The phase-1 capstone: harness switching as a
first-class flow.

## Background

Depends on F003 (runs/lineage) and at least F007 (a second harness to switch to).
Per [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), harnesses never share
sessions — each session format is private and unstable. Handoff is context
transfer, not session sharing: the new run starts fresh but fully briefed, and the
old run stays immutable.

## User Flow

1. On any run (running or finished), the operator picks "Hand off to…" and chooses
   another harness, optionally adding instructions ("continue from here, Codex").
2. hostd generates the Task Context bundle from the run's events and repo state.
3. A new run starts on the target harness with the bundle embedded in its initial
   prompt (`parent_run_id` set); its page links back to the lineage.
4. The conversation picks up with the new harness summarizing what it received;
   everything downstream (chat, approvals, artifacts, acceptance) is unchanged.

## Requirements

- Bundle contents: task title/body and acceptance state; conversation transcript
  (user + agent messages; tool activity as one-line summaries); repo state (base
  branch, run branch, diff stat, worktree path if retained); explicit "open
  follow-ups" section derived from unresolved approvals/questions if any.
- Transcript capping: most recent N messages verbatim (default 100), earlier ones
  compressed to a bullet summary block; total bundle size capped (default 32 KB)
  with a note when truncated.
- Handoff from a running run: the source run is NOT cancelled automatically — the
  operator chooses "hand off and cancel" or "hand off in parallel" (worktrees from
  F006 make parallel safe; without a retained worktree the parallel option uses the
  bundle's diff stat and starts from base).
- `POST /runs/:id/handoff { harness, instructions? }` → new run; lineage chain
  rendered as a breadcrumb of runs on each page.
- The bundle itself is attached to the new run as a `report` artifact — visible,
  inspectable, honest about truncation.

## Business Rules

- Handoff never mutates the source run or its artifacts.
- The target harness must support `resume: false`-agnostic start — handoff works
  even when the target lacks session resume (context rides in the prompt).
- One handoff per source run per click; repeated handoffs create independent
  branches in lineage (allowed).

## Edge Cases

- Source run produced no repo changes → bundle says so explicitly ("no diff").
- Source run has a pending approval → bundle lists it in open follow-ups; the
  source approval remains decidable in its own run.
- Very long conversation → cap + summary; UI shows a "context truncated" hint on
  the new run.
- Target harness undetected/unauthenticated on the host → dispatch fails fast with
  the F003 missing-harness error before any bundle work.

## API / Data Changes

- Endpoint `POST /runs/:id/handoff`; no new tables (`parent_run_id` + artifacts
  cover it). Bundle format versioned (`taskContext.v1`) inside the artifact.

## Acceptance Criteria

- [ ] Handing off an OpenCode run to Claude Code starts a briefed run whose first
      message demonstrates it received task + transcript + repo state.
- [ ] The bundle artifact is attached and human-readable, with truncation notes.
- [ ] Source run is untouched; lineage breadcrumb links both runs.
- [ ] "Hand off and cancel" and parallel variants both behave as specified.
- [ ] A capped long conversation still produces a usable (summarized) bundle.
- [ ] Works with every phase-1 harness as target, including from ad-hoc runs.

## Implementation Plan

### Step 1: Bundle builder
- **Goal:** assemble + cap + summarize transcripts; repo state capture; versioned
  artifact format.
- **Tests:** unit tests over synthetic event histories (short, long, pending
  approval, no diff).
- **Verification:** inspect bundles produced from fake-harness runs.

### Step 2: Handoff flow
- **Goal:** API endpoint, new-run seeding, source-run variants (parallel/cancel),
  lineage wiring.
- **Tests:** integration end-to-end with fake → fake handoff.
- **Verification:** e2e asserts lineage and bundle artifact.

### Step 3: UI
- **Goal:** handoff picker, lineage breadcrumbs, truncation hint, bundle viewer.
- **Tests:** component tests for lineage and truncated states.
- **Verification:** real OpenCode → Claude Code handoff steered from a phone.

## Test Plan

Unit: bundle builder cases. Integration/e2e: full handoff flow between fake
harnesses. Manual: real cross-harness handoff on a real task.

## Open Questions

- Verbatim-message cap (100) and bundle size cap (32 KB) — comfortable defaults?
- Should the bundle prompt instruct the target harness to re-verify assumptions
  (proposed: yes, one standard preamble line)?
