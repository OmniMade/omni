# DATABASE

## Engine

PostgreSQL 16+. Chosen for relational task/run state plus append-only event storage
with JSONB payloads — one engine covers both without extra infrastructure. Accessed
through Drizzle ORM (typed schema in `apps/server/src/db`) over postgres.js.

## Schema Overview

Core entities and relationships:

```
users (single admin row in v1)
hosts 1──* workspaces 1──* tasks 1──* runs 1──* run_events
       │                   │         ├──* approvals
       │                   │         └──* artifacts
       │                   └──────── runs.parent_run_id (resume/handoff lineage)
       ├──* workspace_events (activity log per workspace)
       └──* host_commands (outbound command queue)
```

| Table              | Key columns                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `users`            | id, username, password_hash (argon2), created_at                            |
| `host_enrollments` | id, host_id → hosts, token_hash, expires_at, consumed_at (one-time enrollment tokens) |
| `hosts`            | id, name (unique), token_hash, status (pending/online/offline), os, arch, agent, hostname, harnesses jsonb, last_seen_at, command_seq |
| `host_commands`    | id, host_id → hosts, seq int (per-host monotonic), type, payload jsonb, status (pending/delivered/acked/failed), created_at, delivered_at, acked_at; unique (host_id, seq) |
| `workspaces`       | id, host_id → hosts, name; unique (host_id, name). repo_url (null when an adopted repo has no remote), origin (cloned/adopted), root_path (absolute, resolved by hostd), default_branch, status (queued/cloning/adopting/syncing/ready/error), current_branch, head, dirty, size_bytes (bigint), error, last_synced_at |
| `workspace_events` | id bigserial, workspace_id → workspaces (cascade), kind (registered/progress/ready/sync/info/warn/error), message, data jsonb, ts; index (workspace_id, id) |
| `tasks`            | id, workspace_id → workspaces, title, body, status (open/accepted/rejected/archived), acceptance jsonb (decision, note, run_id, decided_at) |
| `runs`             | id, task_id → tasks (nullable: ad-hoc/attached chat), workspace_id, host_id, harness, origin (dispatch/adopt/attach, default dispatch), model, status (queued/starting/running/finished), outcome (completed/failed/cancelled/detached, null while open), parent_run_id (nullable), session_ref jsonb (opaque adapter ref), worktree_path, branch, error, started_at, finished_at |
| `run_events`       | id bigserial, run_id, seq int, type, data jsonb, ts; unique (run_id, seq)    |
| `approvals`        | id, run_id, harness_ref, kind, payload jsonb, status (pending/approved/denied/expired), note, decided_at |
| `artifacts`        | id, run_id, kind (diff/log/test_report/report), storage_path (host filesystem), meta jsonb |

Design notes:

- **Conversation = events.** User and agent messages are `user.message` /
  `agent.message` rows in `run_events`; there is no separate messages table.
- `runs.session_ref` is opaque JSON produced by the adapter (e.g. a session id);
  the server never interprets it — only stores and returns it for resume.
- `runs.parent_run_id` records lineage for continue-in-place and harness handoff.
- `host_commands` is the outbound queue behind "commands are queued in DB if the
  host is offline": the server enqueues each host command with a per-host monotonic
  `seq`; the host acks after applying; unacked commands (pending or delivered)
  are re-sent on reconnect. `hosts.command_seq` is the counter the enqueue
  increments atomically (`UPDATE … RETURNING`) to keep `seq` gap-tolerant and
  unique per host.
- `hosts.os/arch/agent/hostname` come from the host's `hello` message;
  `hosts.token_hash` is null until first enrollment and after rotation.
- `runs.origin` distinguishes dispatched runs from adopted foreign sessions
  (`adopt`) and live-attached sessions (`attach` — cancel means detach, outcome
  `detached`).
- **Workspace state is host-reported.** The server only writes rows and
  enqueues commands; every status/snapshot column (`root_path`, `default_branch`,
  `current_branch`, `head`, `dirty`, `size_bytes`, `error`, `last_synced_at`)
  is merged from the host's `workspace.status` channel messages. `origin`
  decides deletion behavior: `cloned` directories are removed on delete,
  `adopted` paths are never touched.
- `workspace_events` is the workspace activity log (clone progress, sync
  results, errors); append-only like `run_events` and served as a chronological
  tail by `GET /workspaces/:id/events`.

## Migrations

Drizzle Kit generates SQL migrations (`apps/server/drizzle/`), forward-only, applied
on server boot when `AUTO_MIGRATE=true` or via `pnpm db:migrate`. No handwritten
down-migrations; roll forward with a new migration.

## Conventions

- UUID v7 primary keys (time-ordered, index-friendly); `bigserial` for `run_events.id`.
- All timestamps `timestamptz` (UTC).
- `run_events` is append-only and never updated or deleted; retention/pruning is a
  post-v1 concern.
- Runs and events are soft state: no hard deletes except explicit workspace/host
  removal, which is blocked while active runs exist.
- Secrets (password, host/enrollment tokens) stored as hashes only; enrollment
  tokens are one-time and expire.
