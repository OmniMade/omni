# Feature: Git Worktree Parallelism

## Goal

Give every run its own git worktree and branch, so multiple runs execute
concurrently in one workspace without file conflicts — and every run gets a clean,
reviewable branch for acceptance diffs.

## Background

Depends on F003/F005 (runs, artifact diffs). Until now the executor ran directly in
the workspace root with a one-active-run-per-workspace lock. This feature moves run
execution into `<workspace>/.omni/worktrees/<run-short-id>` on branch
`omni/<task-slug>-<run-short-id>`, lifts the lock, and adds cleanup and
concurrency caps.

## User Flow

1. Operator dispatches two tasks to the same workspace; both run immediately in
   separate worktrees, streaming concurrently.
2. Each run page shows its branch; the artifacts diff is the worktree branch vs
   the merge-base of the chosen base (default: workspace default branch).
3. Optionally the operator picks a non-default base branch at dispatch.
4. After acceptance (or explicit discard), the worktree and its local branch are
   removed; runs retain their diff artifacts, so history stays reviewable.

## Requirements

- Worktree creation: `git worktree add` from the fetched base ref, clean state,
  unique path per run; creation is part of `starting`, visible in the run event
  log.
- Branch naming `omni/<task-slug>-<run-short-id>` (slugified, length-capped);
  ad-hoc runs use `omni/chat-<run-short-id>`.
- Per-host concurrency cap (default 2, configurable) on top of per-workspace
  unlimited parallelism (worktrees make them independent); excess runs queue.
- Cleanup: automatic after task acceptance or run discard (cancel + explicit
  "discard worktree"); failed runs keep their worktree until discarded, for
  post-mortem.
- Disk guard: before creating a worktree, check free space (refuse below a
  threshold with a clear error); workspace page shows `.omni` footprint.

## Business Rules

- Worktrees live under the workspace's `.omni/` directory and never touch the root
  checkout — the root clone stays clean for fetches.
- A worktree is never reused across runs.
- Cleanup removes the worktree and its local branch; remote branches are never
  pushed or deleted by Omni in v1.

## Edge Cases

- Base branch deleted upstream after fetch → worktree creation falls back to the
  last-known ref with a warning event.
- Stale worktrees from crashed runs (pre-cleanup) → reconciled on hostd restart:
  listed as orphaned, auto-cleaned if their run is terminal.
- Same task re-dispatched → new run, new worktree, new branch (suffix makes it
  unique).
- Worktree creation fails (disk, index lock) → run fails fast with the git error,
  no partial directory left behind.

## API / Data Changes

- `runs.worktree_path` / `runs.branch` become real (already in schema); dispatch
  gains optional `baseBranch`; host config gains `maxConcurrentRuns` via
  `PATCH /hosts/:id`; `POST /runs/:id/discard` removes a terminal run's worktree
  and branch. No new tables.

## Acceptance Criteria

- [ ] Two runs dispatch to one workspace simultaneously and both complete with
      independent, correct diffs — no lock, no conflicts.
- [ ] Every run's branch follows the naming scheme and appears on the run page.
- [ ] Concurrency cap queues a third run while two are active on a capped host.
- [ ] Accepted/discarded runs have their worktrees and branches removed; failed
      runs keep theirs until discarded.
- [ ] hostd restart reconciles orphaned worktrees from terminal runs.

## Implementation Plan

### Step 1: Worktree manager
- **Goal:** create/list/clean worktrees + branches, disk guard, base-ref fallback.
- **Tests:** unit/integration on fixture repos covering every edge case.
- **Verification:** manual git inspection after scripted runs.

### Step 2: Executor integration + concurrency
- **Goal:** runs execute in worktrees; per-host semaphore; queueing; cleanup hooks
  wired to acceptance/discard.
- **Tests:** integration with two fake-harness runs racing in one workspace.
- **Verification:** e2e asserts parallel completion and cleanup.

### Step 3: UI touches
- **Goal:** branch/base display, base picker at dispatch, discard action, storage
  footprint.
- **Tests:** component tests for queueing/discard states.
- **Verification:** phone dispatch of two tasks, both streaming side by side.

## Test Plan

Integration: parallel fake-harness runs, cap queueing, cleanup on all outcomes,
orphan reconciliation. E2E: extend the standard script with a parallel dispatch.

## Open Questions

- Default per-host concurrency cap (proposed: 2) and whether to cap per-workspace
  too.
- Cleanup timing: immediately on acceptance vs delayed grace period (proposed:
  immediate; the diff artifact preserves the review record)?
- Free-space threshold (proposed: 5 GB)?
