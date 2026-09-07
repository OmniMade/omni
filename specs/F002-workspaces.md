# Feature: Workspace Management

## Goal

Register a git repository on an enrolled host; Omni clones it (or adopts an
existing checkout), keeps it fetched, and shows its status in the UI — the place
runs will later execute.

## Background

Depends on F001 (enrolled hosts with a live channel). Introduces the `workspaces`
and `workspace_events` tables and workspace commands on the host channel. Runs
(F003) target a workspace; worktree isolation arrives in F006, so v1 of this
feature maintains one clean checkout per workspace.

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
- Sync is **manual only** (owner decision 2026-09-07): dispatch in F003 uses the
  workspace's local state as-is; no automatic fetch before runs.

## Edge Cases

- Clone fails (auth, network, bad URL) → workspace marked `error` with the git
  stderr surfaced in the UI; retry supported.
- Adopted path is dirty → allowed with a warning badge (dirty state is visible);
  F006 worktrees are always created clean from a fetched ref regardless.
- Repo default branch changes upstream → next sync updates the recorded default
  with a UI note.
- Very large repos → clone runs detached; workspace shows `cloning` until done; UI
  streams progress.
- hostd dies mid-clone → the unacked clone command is replayed on reconnect; the
  partial directory is removed and the clone restarts from scratch.

## API / Data Changes

- Tables: `workspaces`, `workspace_events` (see [docs/DATABASE.md](../docs/DATABASE.md)).
- Endpoints: `GET/POST /workspaces`, `POST /workspaces/:id/sync`,
  `GET /workspaces/:id/events`, `DELETE /workspaces/:id`; channel commands
  `cmd.workspace_clone`, `cmd.workspace_sync`, `cmd.workspace_delete`; host→server
  `workspace.status` messages.

## Acceptance Criteria

- [x] Registering a public repo URL clones it on the host and shows branch + HEAD.
- [x] Registering an existing local path adopts it without copying files.
- [x] Sync updates HEAD after upstream commits; activity log shows the fetch.
- [x] A failed clone (bad URL) surfaces git's error in the UI and allows retry.
- [x] Delete is refused while runs reference the workspace, and never deletes an
      adopted path.

Verification (2026-09-07): unit 57/57 (`pnpm test`: aep 14, hostd 23 incl. 12
fixture-repo git tests, server 7, api-client 4, web 9); integration 31/31 run
three times (workspaces file: 9 tests driving the real WS host endpoint with a
scripted ChannelClient); e2e 4/4 (`pnpm e2e`: F001 flows + F002 lifecycle with
real hostd children against on-disk fixture repos — clone→ready→upstream
commit→sync fast-forward→delete removes cloned files; bad-URL error→retry
recovery; adopt in place survives deletion); typecheck + `next build` clean.
Browser smoke in a phone-sized (390×844) viewport against `pnpm dev` with a
real enrolled hostd: add host→online live; host page → Add workspace dialog →
clone → ready live (branch/HEAD/size/rootPath); activity log recorded
registration, clone, sync (fast-forward); Sync after an upstream commit moved
HEAD live; delete removed the row live and the cloned directory from disk.
The smoke caught and fixed a `getServerSnapshot` infinite loop on the host
page (zustand selector returning a fresh filtered array per call).

## Implementation Decisions (2026-09-07)

- **Status model**: `queued` (row created, command queued) → `cloning` (URL) or
  `adopting` (existing path) → `ready`; `ready` → `syncing` → `ready`; any
  operational state → `error` (retry re-enqueues the same command). Sync is only
  accepted from `ready` (409 `WORKSPACE_NOT_READY` otherwise).
- **Data model**: `workspaces` gains `origin` (`cloned`/`adopted`), `repo_url`
  (nullable — an adopted repo may have no remote; filled from `origin` when
  present), `current_branch`, `head`, `dirty`, `size_bytes`, `error`,
  `last_synced_at` on top of the documented core columns. The activity log is a
  new append-only `workspace_events` table (kind + message + jsonb data) served
  by `GET /workspaces/:id/events` (chronological tail, `limit` default 50).
- **Channel protocol**: `cmd.workspace_clone` payload carries
  `{ workspaceId, name, mode: clone|adopt, repoUrl?, path? }` — hostd resolves
  and reports back the real `rootPath` (the server never guesses host paths).
  `cmd.workspace_sync` carries `{ workspaceId, rootPath }` so commands stay
  self-contained across hostd restarts (hostd holds no workspace state in
  memory). `cmd.workspace_delete` carries `{ workspaceId, rootPath, removeFiles }`
  with `removeFiles = origin === "cloned"`. Progress/status flows host→server as
  `workspace.status` messages (status + snapshot fields + message); the server
  merges the row, appends a `workspace_events` entry, and broadcasts
  `workspace.updated` on the UI socket (new `workspaces` topic).
- **Sync semantics**: `git fetch --prune`, then fast-forward the checkout
  (`merge --ff-only origin/<branch>`) only when on the default branch and clean;
  a dirty checkout or a non-default branch is left untouched and reported.
  Upstream default-branch change is detected with `git ls-remote --symref` and
  updates the recorded default with an activity-log note.
- **Naming**: name defaults from the repo URL's last path segment (`.git`
  stripped) or the adopted path's basename, sanitized to the host-name pattern;
  collisions return 409 `NAME_TAKEN` — no silent suffixing, pass an explicit name.
- **hostd data dir**: `<omni-data>` is `~/.omni` (beside `hostd.json`), so clones
  land in `~/.omni/workspaces/<name>`; `OMNI_HOSTD_DATA` overrides for tests and
  big-disk hosts.
- **Deletion guard**: `workspaceDeletionBlockedReason` ships as the same kind of
  seam F001 used for hosts — trivially "no runs" until the `runs` table lands in
  F003; deletion enqueues the channel command (best-effort file cleanup after
  ack) and removes the row immediately.
- **Git execution**: `node:child_process` spawn of the host's `git` (no binary
  probing; failures surface as `error` with stderr). Workspace operations inside
  hostd serialize on a promise chain (one op at a time per host, commands queue).
- **Live command delivery** (F001 gap surfaced by this feature): commands
  enqueued while the host is connected are pushed to the live socket
  immediately — gated on the connection having completed its `hello`, so the
  reconnect replay never re-sends a seq the host already received. Host-channel
  messages of one connection are applied server-side strictly in arrival order
  (workspace reports read-modify-write one row and must not interleave).
- **UI placement**: the host detail page `/hosts/[id]` owns the workspace list,
  add-workspace dialog, sync button, status badges, and the activity log (the
  F002 user flow opens "a host's page"); a cross-host workspaces page can come
  with F003's dispatch UI.

## Implementation Plan

### Step 1: Workspace domain + API + channel protocol
- **Goal:** `workspaces`/`workspace_events` schema + migration, `@omni/aep`
  workspace schemas (REST DTO, channel commands, `workspace.status`, UI events),
  domain functions, REST routes, channel wiring, api-client methods.
- **Scope:** server app only; hostd still fail-acks the new commands (existing
  F001 behavior).
- **Tests:** aep schema unit tests; server integration driving the real WS host
  endpoint with a scripted ChannelClient (queued→cloning→ready transitions,
  activity log rows, duplicate-name 409, sync guard, blocked-delete seam).
- **Verification:** `pnpm test`, `pnpm -F @omni/server test:integration`, typecheck.

### Step 2: hostd git operations
- **Goal:** clone/adopt/fetch/prune with progress events, error capture, status
  snapshots; command handling wired into the daemon.
- **Scope:** `apps/hostd/src/workspace/` git module (single checkout mode),
  serialized op queue, `workspace.status` reporting, `OMNI_HOSTD_DATA`.
- **Tests:** hostd unit tests against fixture repos created in temp dirs (clone,
  adopt incl. linked-worktree rejection + dirty warning, fetch+ff, default-branch
  change, size walk, progress parsing).
- **Verification:** real repo registered end-to-end on a dev host.

### Step 3: UI
- **Goal:** host detail page with add-workspace form, list with status badges,
  sync button, activity log; live updates via the `workspaces` UI topic.
- **Scope:** `/hosts/[id]` page, workspaces store, api-client already in Step 1,
  host row link.
- **Tests:** store component tests for status transitions.
- **Verification:** full flow from a phone-sized browser.

### Step 4: E2E + document sync
- **Goal:** enroll→workspace-ready as the standard e2e preamble; documents
  updated (DATABASE/API/ARCHITECTURE/TESTING/FRONTEND).
- **Scope:** `apps/e2e` workspace lifecycle test with local fixture repos (clone
  from path, upstream commit + sync, bad URL error + retry, adopt, delete).
- **Verification:** `pnpm e2e` green; docs re-read for consistency.

## Test Plan

Unit: git command building/progress parsing, name/URL/path validation
(hostd + server), workspace store transitions (web). Integration: workspace
lifecycle over the channel with a scripted fake host, API validation and guards.
E2E: enroll→workspace-ready becomes the standard e2e preamble for F003+ (real
hostd children against on-disk fixture repos — no network).

## Open Questions

None — resolved 2026-09-07 by the owner: sync is manual only (no automatic
fetch before dispatch; F003 uses the workspace's local state).

## Tracking

Branch `feat/f002-workspaces` → PR to `main` (GitHub mode; see Roadmap
Tracking).
