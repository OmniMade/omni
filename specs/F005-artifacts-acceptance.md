# Feature: Artifacts & Task Acceptance

## Goal

When a run finishes, Omni captures what it produced — diff, test results, logs —
as reviewable artifacts, and the operator records an acceptance decision
(accept/reject + note) on the task. Merging remains the operator's own business.

## Background

Depends on F003 (runs). Introduces `artifacts` and the acceptance fields on
`tasks`. Artifact content lives on the host filesystem under
`<workspace>/.omni/artifacts/<runId>/`; metadata in PostgreSQL; content is
streamed to the UI through the server over the host channel on demand.

## User Flow

1. A run finishes; the executor collects artifacts automatically:
   - `diff`: `git diff <merge-base>…HEAD` in the run's checkout (workspace root
     until F006, worktree after),
   - `test_report`: harness-reported test outcomes when the harness emits them,
   - `log`: the run's full event log rendered to text.
2. Each capture emits `artifact.produced`; the run page shows an Artifacts tab with
   the diff (syntax-highlighted, per-file collapsible) and test summary.
3. The operator reviews, then on the task records **Accept** or **Reject** with an
   optional note, optionally referencing the run that earned it.
4. Task status moves to `accepted` / `rejected`; the decision (note, run, time) is
   shown on the task forever after. Rejected tasks can be re-dispatched.

## Requirements

- Artifact collection is automatic on every terminal outcome (completed, failed,
  cancelled) — best effort, never blocks run finalization.
- Diff is computed against the merge-base of the run's base branch; stat summary
  stored in `meta` (files changed, insertions, deletions).
- Large/binary files: diffs over 1 MB are stored but the UI paginates/truncates
  with a "download full" action; binary blobs are listed by name only.
- Acceptance decision: `POST /tasks/:id/acceptance { decision, note?, runId? }`;
  once `accepted`, the task locks (archived view); `rejected`/`open` allow
  re-dispatch.
- Artifact content endpoint streams from the host; 404 with a clear message if the
  host purged files.

## Business Rules

- Acceptance is a task-level decision referencing at most one run.
- Artifacts are immutable once produced; re-collecting replaces nothing.
- No-changes runs still produce a (empty) diff artifact — "the agent did nothing"
  is reviewable information.

## Edge Cases

- Workspace dirty before a root-checkout run (pre-F006) → diff computed from a
  recorded pre-run HEAD snapshot, with a warning banner that pre-existing changes
  are excluded by snapshot diffing.
- Harness emits no test results → no `test_report` artifact; UI shows "not
  reported".
- Host offline when viewing an artifact → content endpoint returns a
  host-unavailable error; UI offers retry.

## UI / UX

- Run page: Artifacts tab (diff viewer, test summary, log download).
- Task page: decision controls, decision history line, links to contributing runs.

## API / Data Changes

- Table: `artifacts`; `tasks.acceptance` JSONB. Endpoints:
  `GET /runs/:id/artifacts`, `GET /artifacts/:id/content`,
  `POST /tasks/:id/acceptance`. AEP event `artifact.produced` (already in the
  protocol).

## Acceptance Criteria

- [ ] A completed run automatically yields a diff artifact with correct stat
      summary, viewable in the UI.
- [ ] A cancelled run still captures the partial diff.
- [ ] Accepting a task records decision + note + run and locks further dispatch;
      rejecting allows re-dispatch.
- [ ] Empty-diff runs show an explicit "no changes" artifact.
- [ ] Artifact content streams through the API when the host is online and errors
      clearly when offline.

## Implementation Plan

### Step 1: Artifact collection in hostd
- **Goal:** post-run collector (snapshot HEAD pre-run; diff at finish; test report
  extraction hook), artifact storage layout, `artifact.produced`.
- **Tests:** unit/integration on fixture repos incl. empty-diff and binary cases.
- **Verification:** fake-harness run produces inspectable artifacts on disk.

### Step 2: Serving + acceptance API
- **Goal:** artifacts list/content endpoints via channel fetch; acceptance
  endpoint with locking rules.
- **Tests:** integration tests for lifecycle and lock semantics.
- **Verification:** curl round-trip; acceptance state visible in DB/UI.

### Step 3: UI
- **Goal:** Artifacts tab with diff viewer and test summary; task decision flow.
- **Tests:** component tests for diff rendering modes and locked states.
- **Verification:** full review on a phone: run → diff → accept with note.

## Test Plan

Integration: collection on all three outcomes, content streaming, acceptance lock.
E2E: e2e script extends to diff + acceptance assertions. Manual: review a real
OpenCode change from a phone.

## Open Questions

- Diff base: merge-base of default branch (proposed) vs the recorded pre-run HEAD?
- Should test_report parsing target a standard format (e.g. JUnit XML) in v1, or
  only harness-native output?
