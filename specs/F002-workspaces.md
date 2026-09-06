# Feature: Workspace Management

## Goal

Register a git repository on an enrolled host; Omni clones it (or adopts an
existing checkout), keeps it fetched, and shows its status in the UI — the place
runs will later execute.

## Background

Depends on F001 (enrolled hosts with a live channel). Introduces the `workspaces`
table and workspace commands on the host channel. Runs (F003) target a workspace;
worktree isolation arrives in F006, so v1 of this feature maintains one clean
checkout per workspace.

## User Flow

1. Operator opens a host's page and clicks "Add workspace": repo URL (SSH or
   HTTPS), optional name, optional existing on-disk path.
2. hostd clones (or adopts) the repository, records the default branch, and reports
   status: current branch, HEAD, dirty state, size.
3. Operator hits "Sync" anytime → hostd runs `git fetch --prune` and reports back.
4. Workspaces list shows per-host workspaces with sync status and last-synced time.

## Requirements

- Register by URL (clone into `<omni-data>/workspaces/<name>`) or by existing path
  (adopt: must be a git repository and not itself a linked worktree; recorded in
  place — a dirty state is allowed and surfaced with a warning, see Edge Cases).
- Clone/fetch run as host channel commands; progress surfaces as events on the
  workspace (visible in UI as a sync activity log).
- Default branch detection (`origin/HEAD`), recorded and editable.
- Sync reports branch/HEAD/dirty-status changes since last sync.
- Deleting a workspace is blocked while any run references it; deletion removes the
  directory only if Omni cloned it (adopted paths are never deleted).

## Business Rules

- Workspace names unique per host.
- Private repos authenticate with the host's own git credentials (ssh-agent,
  `~/.git-credentials`, or deploy key) — Omni never stores repo credentials in v1.
- One workspace operation (clone/sync) at a time per host; commands queue.

## Edge Cases

- Clone fails (auth, network, bad URL) → workspace marked `error` with the git
  stderr surfaced in the UI; retry supported.
- Adopted path is dirty → allowed with a warning badge (dirty state is visible);
  F006 worktrees are always created clean from a fetched ref regardless.
- Repo default branch changes upstream → next sync updates the recorded default
  with a UI note.
- Very large repos → clone runs detached; workspace shows `syncing` until done; UI
  streams progress.

## API / Data Changes

- Table: `workspaces` (see [docs/DATABASE.md](../docs/DATABASE.md)).
- Endpoints: `GET/POST /workspaces`, `POST /workspaces/:id/sync`,
  `DELETE /workspaces/:id`; channel commands `cmd.workspace_clone`,
  `cmd.workspace_sync`.

## Acceptance Criteria

- [ ] Registering a public repo URL clones it on the host and shows branch + HEAD.
- [ ] Registering an existing local path adopts it without copying files.
- [ ] Sync updates HEAD after upstream commits; activity log shows the fetch.
- [ ] A failed clone (bad URL) surfaces git's error in the UI and allows retry.
- [ ] Delete is refused while runs reference the workspace, and never deletes an
      adopted path.

## Implementation Plan

### Step 1: Workspace domain + API
- **Goal:** CRUD, status model, channel commands defined in `packages/aep`-adjacent
  protocol types.
- **Scope:** `workspaces` table/migration, routes, command plumbing.
- **Tests:** API integration tests incl. blocked delete.
- **Verification:** workspace rows transition queued→cloning→ready via fake host.

### Step 2: hostd git operations
- **Goal:** clone/adopt/fetch/prune with progress events and error capture.
- **Scope:** `worktree/`-adjacent git module in hostd (single checkout mode).
- **Tests:** unit tests against fixture repos created in temp dirs.
- **Verification:** real repo registered end-to-end on a dev host.

### Step 3: UI
- **Goal:** add-workspace form, list with status badges, sync button, activity log.
- **Tests:** component tests for status transitions.
- **Verification:** full flow from phone-sized browser.

## Test Plan

Integration: workspace lifecycle over the channel with a local bare fixture repo.
Unit: git command building, path/name validation. E2E: enroll→workspace-ready
becomes the standard e2e preamble for F003+.

## Open Questions

- Should sync run automatically before every dispatch (proposed: yes, cheap
  `git fetch`) or stay manual?
