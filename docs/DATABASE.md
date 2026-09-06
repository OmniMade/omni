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
       └──* host_commands (outbound command queue)
```

| Table              | Key columns                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `users`            | id, username, password_hash (argon2), created_at                            |
| `host_enrollments` | id, token_hash, expires_at, consumed_at (one-time enrollment tokens)        |
| `hosts`            | id, name (unique), token_hash, status, harnesses jsonb, last_seen_at        |
| `host_commands`    | id, host_id → hosts, seq int (per-host monotonic), type, payload jsonb, status (pending/delivered/acked/failed), created_at, acked_at; unique (host_id, seq) |
| `workspaces`       | id, host_id → hosts, name, repo_url, default_branch, root_path, status; unique (host_id, name) |
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
  `seq`; the host acks after applying; unacked commands are re-sent on reconnect.
- `runs.origin` distinguishes dispatched runs from adopted foreign sessions
  (`adopt`) and live-attached sessions (`attach` — cancel means detach, outcome
  `detached`).

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
