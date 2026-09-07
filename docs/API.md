# API

## Style

JSON REST under `/api/v1`, plus two WebSocket endpoints (host channel, UI live
events). Typed end-to-end: `packages/aep` defines event schemas, `packages/api-client`
exports the client used by the web UI and tests. No GraphQL; no version negotiation
beyond the `/v1` prefix and the AEP envelope's `v` field.

## Conventions

- **Auth** — admin: username/password login → HttpOnly session cookie (stateless,
  HMAC-signed, 7-day TTL; set `SESSION_SECRET` for restart survival); first-run
  `POST /auth/setup` creates the account only while the `users` table is empty.
  Hosts: one-time enrollment token exchanged for a persistent credential via
  `POST /hosts/enroll`; the credential authenticates the WS handshake
  (`Authorization: Bearer …` at upgrade time).
- **Errors** — `{ "error": { "code": "string", "message": "string", "details": {} } }`
  with appropriate HTTP status.
- **Health** — `GET /healthz` (outside `/api/v1`, unauthenticated) returns
  `{ "status": "ok" }` once the server is serving.
- **Pagination** — cursor-based: `?after=<seq>` for events, `?cursor=<id>` +
  `?limit` for lists.
- **IDs** — UUIDs in paths.

## Endpoints

### Auth
| Method | Path              | Purpose                                |
| ------ | ----------------- | -------------------------------------- |
| POST   | /auth/setup       | Create admin account (first run only)  |
| POST   | /auth/login       | Login → session cookie                 |
| POST   | /auth/logout      | Clear session                          |
| GET    | /auth/me          | Current user                           |

### Hosts
| Method | Path                    | Purpose                                        |
| ------ | ----------------------- | ---------------------------------------------- |
| GET    | /hosts                  | List hosts (status, harness inventory)         |
| GET    | /hosts/:id/sessions     | Discover harness sessions (live + stored)      |
| POST   | /hosts                  | Register host → one-time enrollment token      |
| POST   | /hosts/enroll           | Exchange one-time enrollment token → host credential |
| PATCH  | /hosts/:id              | Rename host; update host config (e.g. `maxConcurrentRuns`) |
| POST   | /hosts/:id/rotate-token | Re-issue host credential                       |
| DELETE | /hosts/:id              | Remove host (blocked while runs are active)    |

### Workspaces
| Method | Path                      | Purpose                                  |
| ------ | ------------------------- | ---------------------------------------- |
| GET    | /workspaces               | List (per host)                          |
| POST   | /workspaces               | Register repo on host → clone            |
| POST   | /workspaces/:id/sync      | Fetch/prune the repo on the host         |
| DELETE | /workspaces/:id           | Remove (blocked while runs are active)   |

### Tasks
| Method | Path                          | Purpose                                    |
| ------ | ----------------------------- | ------------------------------------------ |
| GET    | /tasks                        | List (filter by workspace/status)          |
| POST   | /tasks                        | Create (workspace, title, body)            |
| GET    | /tasks/:id                    | Detail with runs                            |
| PATCH  | /tasks/:id                    | Edit title/body; archive                    |
| POST   | /tasks/:id/acceptance         | Record accept/reject { decision, note, runId } |

### Runs
| Method | Path                        | Purpose                                            |
| ------ | --------------------------- | -------------------------------------------------- |
| POST   | /runs                       | Dispatch { taskId }, ad-hoc chat { workspaceId, message }, or session attach/adopt { harness, attachRef \| adoptRef } |
| GET    | /runs                       | List (filter by task/workspace/status)             |
| GET    | /runs/:id                   | Detail (status, outcome, lineage)                  |
| GET    | /runs/:id/events?after=seq  | Event history backfill (paginated)                |
| POST   | /runs/:id/messages          | Send user message into the live conversation      |
| POST   | /runs/:id/cancel            | Cancel run (graceful → force; attached runs: detach, session survives) |
| POST   | /runs/:id/discard           | Remove a terminal run's worktree + branch (artifacts kept) |
| POST   | /runs/:id/continue          | New run resuming this run's harness session       |
| POST   | /runs/:id/handoff           | New run on a different harness with Task Context  |

### Approvals & Artifacts
| Method | Path                             | Purpose                                     |
| ------ | -------------------------------- | ------------------------------------------- |
| GET    | /runs/:id/approvals              | List approvals for a run                    |
| POST   | /approvals/:id/decide            | Approve/deny { decision, note }             |
| GET    | /runs/:id/artifacts              | List artifacts                              |
| GET    | /artifacts/:id/content           | Stream artifact content (fetched via host)  |

### WebSocket
| Path          | Auth     | Purpose                                                       |
| -------------- | -------- | ------------------------------------------------------------- |
| /api/v1/ws/host       | host credential | Host channel: commands ↓, `event`/`host.status`/`result` ↑ |
| /api/v1/ws/ui         | admin session   | UI subscriptions: AEP events, run/host status changes       |

The UI opens one `/api/v1/ws/ui` connection and subscribes/unsubscribes to run ids as the
user navigates; commands are sent over REST, never over the UI socket.
