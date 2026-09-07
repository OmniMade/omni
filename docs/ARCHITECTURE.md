# ARCHITECTURE

## System Overview

Omni is split into a **Control Plane** (state, API, UI) and one **Host Runtime** per
machine (process supervision, harness execution). The two connect over a single
**outbound-only WebSocket** per host: commands flow server → host, events flow
host → server. Hosts are never addressable from the internet; only the control plane
is, and only inside the Tailnet.

```
┌──────────── Any device (browser, over Tailscale) ────────────────┐
│                       Web UI (Next.js)                           │
└──────────────┬──────────────────────────▲────────────────────────┘
               │ HTTPS  (REST)            │ WSS (live events)
┌──────────────▼──────────────────────────┴────────────────────────┐
│                Control Plane  (apps/server, Hono)                │
│   REST API · auth · task/run state machine · live fan-out        │
│                     PostgreSQL (state + events)                  │
└──────────────▲──────────────────────────┬────────────────────────┘
               │ events ↑, host.status ↑  │ commands ↓ (start/send/
               │ (outbound WSS, per host) │ cancel/approve/sync)
┌──────────────┴──────────────────────────▼────────────────────────┐
│                 Host Runtime  (apps/hostd, Bun)                  │
│   channel · executor (process supervision) · worktree manager    │
│   artifact collector · Harness Adapter SPI                       │
│      opencode/ adapter   claude/ adapter   codex/ adapter        │
└───────────────────────────────────────────────────────────────────┘
```

**Task is the stable abstraction; harness is replaceable infrastructure.** The
control plane stores tasks, runs, events, approvals, and artifacts — never harness
sessions or harness-specific state beyond an opaque session reference.

## Modules

| Module            | Lives in        | Responsibility                                          |
| ----------------- | --------------- | ------------------------------------------------------- |
| REST API          | `apps/server`   | Auth, hosts, workspaces, tasks, runs, approvals, artifacts |
| Live fan-out      | `apps/server`   | Persist AEP events, push to subscribed UI clients       |
| Host channel      | both            | Outbound WSS: command/event envelopes, acks, reconnect  |
| Executor          | `apps/hostd`    | Spawn/supervise harness processes (process groups), cancel with escalation |
| Workspace manager| `apps/hostd`    | Clone/adopt/sync workspace checkouts (`src/workspace/`), progress + status reports |
| Worktree manager  | `apps/hostd`    | Create/clean per-run git worktrees and branches (F006) |
| Harness adapters  | `apps/hostd`    | Translate each harness CLI into the adapter SPI         |
| Artifact collector| `apps/hostd`    | Capture diff, logs, test reports at run end             |
| `packages/aep`    | shared          | Agent Event Protocol types + zod schemas (used by all three apps) |
| `packages/api-client` | shared     | Typed REST/WS client (used by web, tests, e2e)          |

## Data Flow

### Task dispatch and run lifecycle

1. User creates a task and dispatches it → `POST /runs` → run row `queued`.
2. Server sends `cmd.start_run` down the host's channel (queued in DB if the host is
   offline; delivered on reconnect).
3. hostd executor prepares the workspace (worktree in F006+, workspace root before
   that), calls `adapter.start(spec)`.
4. Adapter translates harness output into AEP events → hostd assigns per-run `seq`,
   journals the event (write-ahead, see Run Journal & Crash Recovery), then pushes it
   up the channel.
5. Server validates, persists to `run_events` (unique `(run_id, seq)`), fans out to
   UI clients subscribed to the run.
6. On completion the executor collects artifacts (`artifact.produced` events), the
   server transitions the run to `finished` with an outcome.

### Conversation

- User message → `POST /runs/:id/messages` → persisted as a `user.message` event →
  `cmd.send_message` to the host → adapter writes it into the live harness session.
- Replies arrive as ordinary `agent.message` events. Messages are events: the chat
  history is the event log, replayable via `GET /runs/:id/events?after=<seq>`.
- Continue a finished run → `POST /runs/:id/continue` → new run with
  `parent_run_id` set and `resumeFrom` = the harness session ref; the adapter
  resumes the same harness session (OpenCode session id / Claude Code `--resume` /
  Codex resume), so the thread survives.

### Approval

1. Harness asks permission → adapter emits `approval.requested` (payload: tool,
   input, reason) and pauses its process.
2. Server creates an `approvals` row and pushes a card to the UI.
3. User decides → `POST /approvals/:id/decide` → `cmd.resolve_approval` → adapter
   resumes or aborts the pending tool call, emits `approval.resolved`.

## Agent Event Protocol (AEP)

The single contract between harness execution and everything above it. Defined once
in `packages/aep` (TypeScript types + zod schemas, versioned `v: 1`).

```jsonc
// envelope
{ "v": 1, "runId": "uuid", "seq": 128, "ts": "2026-09-06T12:00:00Z",
  "type": "agent.message", "data": { "text": "..." } }
```

| Type                 | data (essentials)                    |
| -------------------- | ------------------------------------ |
| `run.started`        | harness, model?, branch, worktreePath, origin? |
| `run.finished`       | outcome: completed/failed/cancelled, summary? |
| `user.message`       | text                                  |
| `agent.message`      | text                                  |
| `agent.reasoning`    | text (optional thinking trace)        |
| `tool.call`          | tool, input                           |
| `tool.result`        | tool, output, isError                 |
| `approval.requested` | approvalId, kind, tool?, input?, reason? |
| `approval.resolved`  | approvalId, decision (approve/deny/expired), note?           |
| `log.line`           | stream: stdout/stderr/system, text    |
| `artifact.produced`  | artifactId, kind (diff/log/test_report/report), summary? |
| `error`              | message, fatal?                       |

Rules: events are immutable facts; `seq` is gapless per run (UI detects gaps and
backfills via REST); unknown `type` values are stored and rendered as generic cards, never rejected
(forward compatibility); adapters must map every harness-specific concept onto this set —
anything unmappable degrades to `log.line`.

## Harness Adapter SPI

```ts
interface HarnessAdapter {
  id: string;              // "opencode" | "claude-code" | "codex" | …
  capabilities(): { chat: boolean; approvals: boolean; resume: boolean; attach: boolean };
  detect(): Promise<{ version: string } | null>;    // binary present on host?
  listSessions(): Promise<ForeignSession[]>;        // sessions on this host, live or stored
  start(spec: StartSpec, emit: EventSink): Promise<HarnessSession>;
  attach(ref: SessionRef, emit: EventSink): Promise<HarnessSession>;  // join a live session
}

interface ForeignSession {
  ref: SessionRef;         // opaque, harness-specific
  title?: string;
  cwd: string;             // must map to a registered workspace root to be usable
  lastActiveAt?: string;
  live: boolean;           // live session (attachable) vs stored session (adoptable)
}

interface StartSpec {
  workspacePath: string;          // the run's worktree
  baseBranch: string;
  prompt: string;                 // task instructions (may embed a Task Context bundle on handoff)
  model?: string;
  resumeFrom?: SessionRef;        // continue the same harness session
}

interface HarnessSession {
  send(text: string): Promise<void>;                          // conversation
  resolveApproval(id: string, decision: "approve" | "deny", note?: string): Promise<void>;
  cancel(reason: string): Promise<void>;                      // graceful → SIGKILL escalation
  ref(): SessionRef;                                          // opaque, persisted for resume
  close(): Promise<void>;
}
```

Adapters live only in `apps/hostd` (they spawn local binaries). Adding a harness =
one new adapter directory + fixture corpus; no server or UI changes. Capabilities
are declared, not assumed: the UI hides "continue" or approval UI when a harness
lacks the capability.

Attach and adopt follow the same capability rule (F010): `attach()` joins a **live**
session through the harness's own session API (OpenCode server mode); **adopting** a
stored, not-currently-live session is `start()` with `resumeFrom` = the foreign
session's ref — the F003 resume path, no parallel mechanism. Terminal/pty bridging
of already-running TUI sessions is out of scope for v1.

## Host Channel

One outbound WSS per host (`GET /api/v1/ws/host`), authenticated with the host
credential issued at enrollment. Message envelopes both directions:

- **host → server**: `hello` (auth), `host.status` (heartbeat: running runs,
  harness inventory, disk), `event` (AEP), `result` (command ack/outcome),
  `workspace.status` (F002: workspace phase transitions, progress, snapshots).
- **server → host**: `cmd.start_run`, `cmd.send_message`, `cmd.cancel_run`,
  `cmd.resolve_approval`, `cmd.workspace_clone`, `cmd.workspace_sync`, and
  `cmd.workspace_delete` (F002), `cmd.list_sessions` (session discovery for
  attach/adopt, F010).

Reliability: commands are persisted in the `host_commands` table (see
[DATABASE](DATABASE.md)) with a per-host monotonic `seq`. Commands enqueued
while the host is connected are pushed to the live socket immediately — but
only after its `hello` has been processed, so the reconnect replay (which
re-sends everything unacked, in `seq` order) never duplicates a delivery. The
host acks each command after applying it. Messages of one connection are
applied server-side strictly in arrival order (workspace status reports are
read-modify-write on one row and must not interleave). Events carry per-run
`seq` so the server can detect and request retransmission of gaps. Reconnect
uses exponential backoff + jitter. `hostd` keeps no supervision state in memory
across restarts — the per-run journal below is the reconciliation source of
truth, and workspace commands carry their full payload (repo URL, root path)
so they stay self-contained across restarts.

## Run Journal & Crash Recovery

Every run has an append-only journal at `<omni-data>/journals/<runId>.jsonl`. The
executor writes each AEP event to the journal (with its `seq`, flushed) **before**
sending it up the channel, and records supervision metadata (adapter id, workspace
path, child pid/pgid) in the journal header. This is the mechanism behind the
no-gaps-in-`seq` promise:

- On reconnect, hostd compares its journal high-water mark with the server's last
  persisted `seq` per run and replays the delta; the server's unique
  `(run_id, seq)` constraint makes replay idempotent.
- On hostd restart, each journal is scanned: if the recorded process group is still
  alive it is terminated (SIGTERM → SIGKILL escalation), the run is reconciled to
  `failed`, and every journaled event is delivered — the event history has no gaps.
- A journal is deleted only after its run is terminal **and** the server has
  confirmed every journaled event; otherwise it survives restarts as the recovery
  record.

## Git Worktree Strategy

- Each run gets a worktree at `<workspace>/.omni/worktrees/<run-short-id>` on branch
  `omni/<task-slug>-<run-short-id>`, based on the workspace's default branch (or a
  user-chosen base).
- Worktrees make parallel runs in one repository conflict-free and give every run a
  clean, reviewable branch — this is what acceptance reviews diff against.
- Until worktree support ships (F006), the executor runs directly in the workspace
  root with a one-active-run-per-workspace lock; F002 maintains that single checkout
  (clone or adopt, manual `Sync` = `git fetch --prune` + fast-forward when clean on
  the default branch).
- Cleanup: worktrees are removed after the task is accepted or the run is discarded;
  retention policy is an open question in F006.

## Harness Handoff (Task Context)

Switching harnesses does **not** share sessions — each harness's session format is
private. Instead, on handoff hostd generates a **Task Context bundle**:

- task definition and acceptance state,
- the conversation transcript (capped, summarized if large),
- repository state: base branch, branch, diff stat, worktree path,
- unresolved follow-ups (e.g. pending questions).

The bundle is embedded in the new run's `StartSpec.prompt`. The new run gets
`parent_run_id` set; the UI shows run lineage. The old run stays immutable.

## External Dependencies

| Dependency       | Why                                                        |
| ---------------- | ---------------------------------------------------------- |
| Hono             | HTTP/WS server framework, runs on Node or Bun              |
| Drizzle ORM + postgres.js | Typed schema, migrations, query builder           |
| zod              | Validation shared end-to-end (AEP, API, forms)             |
| Next.js (App Router) | Web UI; server components for initial data            |
| TanStack Query + zustand | REST fetching + live event store in the UI          |
| Bun              | hostd runtime: `Bun.spawn` process groups, single-binary compile |
| Harness CLIs (OpenCode, Claude Code, Codex) | The actual agents; detected, not bundled |
| Tailscale        | Private network; TLS termination via `tailscale serve`     |

## Deployment

- **Control plane**: one `apps/server` process + PostgreSQL 16+, on a machine in the
  Tailnet (a small VPS or one of the hosts). TLS via `tailscale serve` or a reverse
  proxy; no public exposure. `deploy/` ships a compose file and notes.
- **Host runtime**: `omni-hostd` compiled with `bun build --compile` to a single
  binary, run under systemd (Linux) or launchd (macOS). Requires git and the harness
  CLIs on the host; no inbound ports.
- **Web UI**: built and served by the control plane (single origin), so the browser
  only ever talks to one endpoint.

## Repository Layout

```
omni/
├── apps/
│   ├── server/            # control plane (Hono)
│   │   └── src/{api,ws,db,domain,auth}/
│   ├── hostd/             # host runtime (Bun)
│   │   └── src/{channel,workspace,executor,worktree,artifact,harness}/
│   │       └── harness/{spi.ts, opencode/, claude/, codex/, fake/}
│   └── web/               # Next.js UI
│       └── src/{app,components,lib}/
├── packages/
│   ├── aep/               # Agent Event Protocol types + zod (shared by all apps)
│   └── api-client/        # typed REST/WS client (web, tests, e2e)
├── deploy/                # compose file, systemd/launchd units, tailscale notes
├── docs/
└── specs/
```

## Key Technical Decisions

| Decision | Rationale | Alternative considered |
| -------- | --------- | ---------------------- |
| TypeScript full-stack (Node server, Bun hostd) | AEP types shared by all three apps; harness CLIs are themselves TS/Bun; hosts need a JS runtime anyway | Go: stronger process supervision, but duplicate protocol types across languages |
| Outbound-only host WSS | Hosts sit behind NAT/home networks with no inbound ports | Host exposing an API + server polling: worse latency, worse security |
| Events as the chat history | One storage path for conversation, logs, tool calls; replay for free | Separate messages table: duplicates and drift |
| Adapter SPI in hostd only | Adapters spawn local binaries; keeps server harness-agnostic | Server-side adapters: would require remote exec, breaks the boundary |
| Handoff via Task Context, not session sharing | Harness session formats are private and unstable | Shared session format: unsupported by every target harness |
| PostgreSQL as the only server-side store | Relational state + append-only events + JSONB payloads cover the needs | Event store/streaming infra: over-engineering at this scale. SQLite: lighter single-host ops, but weaker concurrency for live event writes + fan-out and no testcontainers parity — revisit only if single-host ops cost hurts |
| Single admin + host tokens for auth | v1 is single-user on a private network | Full OAuth/multi-tenant: out of scope, deferred |
| Worktrees per run | Parallel runs, clean diffs, cheap cleanup | Docker per run: heavier, worse on macOS hosts |
| Attach via harness session APIs; adopt via `resumeFrom` | Live attach only where the harness exposes a session API (OpenCode server mode); adopting reuses the F003 resume path — no parallel mechanism | tmux/pty bridging of TUI sessions: screen-scraping is fragile, control drops to keystrokes, and it breaks the AEP event model |
