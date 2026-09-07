# Feature: Host Enrollment & Live Connection

## Goal

Install `omni-hostd` on a machine, enroll it with a one-time token, and see it
online in the UI. The host connects outward to the control plane over WebSocket and
stays connected — the foundation every later feature rides on.

## Background

First feature of the roadmap ([specs/ROADMAP.md](ROADMAP.md)). Delivers the Control
Plane ↔ Host Runtime split described in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md):
the monorepo scaffold, the server (Hono + Drizzle + PostgreSQL), admin auth, the
host channel protocol, and the `hostd` binary (Bun). No runs, no harnesses yet.

## User Flow

1. Operator starts the server, opens the UI, creates the admin account (first-run
   setup page).
2. Operator clicks "Add host", names it, and receives a one-time enrollment token
   with the exact `omni-hostd connect` command line.
3. Operator runs that command on the Mac mini / Linux box; hostd exchanges the
   token for a persistent credential via `POST /hosts/enroll`, then keeps a WSS
   connection open authenticated with that credential.
4. The hosts page shows the host online, its OS/arch, and its harness inventory
   (initially just what `detect()` finds, possibly empty).

## Requirements

- First-run setup creates the single admin account; afterwards the endpoint refuses.
- Enrollment tokens are one-time, expire (default 15 min), and are shown once.
- hostd authenticates on the WS handshake with the exchanged credential; the server
  invalidates a credential on rotation and the daemon stops retrying with it.
- hostd sends `host.status` heartbeats (every 30 s: uptime, running run count,
  harness inventory, disk free); the server marks a host offline after 3 missed
  intervals.
- Reconnect uses exponential backoff with jitter; a reconnected host replays
  pending commands assigned while it was offline.
- Hosts page lists hosts with online/offline status and last-seen time; a host can
  be renamed, its credential rotated, or the host deleted (only while no runs
  reference it — no runs exist yet, but the guard ships now).
- hostd persists its credential in a config file (`~/.omni/hostd.json`) with 0600
  permissions; system keychain is deferred post-v1 (owner decision 2026-09-06).
- Heartbeat 30 s / offline after 3 missed intervals (≈90 s) ship as configurable
  defaults and are tuned during dogfooding (owner decision 2026-09-06).

## Business Rules

- One active WS connection per host; a second connection with the same credential
  closes the older one (host restarted with stale socket).
- Tokens and credentials are stored hashed; enrollment tokens are single-use.
- All channel messages are validated with zod; malformed messages drop the
  connection (fail closed).

## Edge Cases

- Server unreachable at enroll time → hostd exits with a clear error (enrollment is
  interactive; retry = run the command again).
- Enroll token expired/consumed → explicit error naming the cause.
- Duplicate host names → rejected by unique constraint with a friendly message.
- Clock skew beyond token validity window → treated as expired (tokens are
  short-lived by design).

## API / Data Changes

- Tables: `users`, `host_enrollments`, `hosts` (see [docs/DATABASE.md](../docs/DATABASE.md)).
- Endpoints: `/auth/setup|login|logout|me`, `GET/POST /hosts`, `POST
  /hosts/enroll`, `POST /hosts/:id/rotate-token`, `PATCH /hosts/:id` (rename),
  `DELETE /hosts/:id`; `WS /api/v1/ws/host`, `WS /api/v1/ws/ui`
  (host-status events only at this stage).

## Acceptance Criteria

- [x] First-run setup creates the admin; a second call is rejected.
- [x] Enrolling a host via the printed command makes it appear online in the UI
      within seconds.
- [x] Killing hostd flips the host to offline within ~90 s; restarting it restores
      online without re-enrollment.
- [x] A second host enrolls and both coexist (stable per-host channels).
- [x] Rotating a host credential forces re-enrollment; the old credential is
      refused.
- [x] `bun build --compile` produces a standalone hostd binary for macOS (arm64)
      and Linux (x64/arm64).

Verification (2026-09-06): unit 34/34, integration 22/22 (run twice), e2e 2/2
(`apps/e2e` — enroll→online→kill→offline→restart→rotation + two-host coexistence);
compile produced all three binaries and `omni-hostd-linux-x64 --version` runs;
browser smoke in a phone-sized viewport: setup → add host → enrolled the compiled
binary with the printed command → status flipped online live → killed daemon →
offline live (also detected `opencode 1.18.25` on the real machine).

## Implementation Decisions (2026-09-06)

- **Admin sessions** are stateless HMAC-signed cookies (7-day TTL, `omni_session`);
  no sessions table (keeps the schema as documented). `SESSION_SECRET` env pins
  the key; unset → per-boot random + boot warning.
- **Channel schemas** live in `packages/aep` (`channel.ts`); AEP event types join
  them in F003. Server→host command envelopes accept any `cmd.*` string so old
  hostd fail-acks unknown commands (`result` ok=false) instead of dying — no
  replay storm. Host→server messages are a strict union: malformed → close 4001.
- **F001 command set** is `cmd.ping` (liveness); it exists to exercise the queue
  and replay machinery end-to-end.
- **Close codes**: 4000 superseded, 4001 protocol violation, 4002 heartbeat
  timeout, 4003 revoked (rotation/deletion).
- **Rotation = revoke + fresh enrollment token**: `rotate-token` clears the host
  credential, closes the live socket (4003), and returns a one-time token shown
  once; the daemon treats handshake 401/403 as fatal (clear message, exit 1) and
  never retries a rejected credential.
- **Per-host seq assignment** is an atomic `UPDATE hosts SET command_seq =
  command_seq + 1 RETURNING`; replay covers `pending` + `delivered` (sent but
  unacked), never `acked`.
- **Offline detection** is a server-side sweep (default every 10 s) over
  `last_seen_at`; a clean socket close marks offline immediately.
- **hostd runs on Bun but stays runtime-agnostic** (global fetch, `ws` client,
  node:fs/os APIs), so tests and e2e spawn it under Node/tsx unchanged.
  Credential file `~/.omni/hostd.json` (env `OMNI_HOSTD_CONFIG`), written 0600.
- **Harness detection** in F001 is a lightweight PATH + `--version` probe
  (`opencode`, `claude`, `codex`), cached 10 min; the adapter SPI lands in F003.
- **Web dev shape**: Next dev on :3001 proxies `/api/*` (incl. WS) to the server
  on :3000 (`allowedDevOrigins` covers 127.0.0.1/LAN); single-origin serving of
  the built UI from the control plane is deferred to the first real Tailnet
  deployment. Hand-rolled shadcn-style primitives (Button/Input/Badge/Dialog)
  instead of pulling the shadcn CLI.

## Implementation Plan

### Step 1: Monorepo scaffold + server skeleton
- **Goal:** pnpm workspace with `apps/server`, `apps/hostd`, `apps/web`,
  `packages/aep`, `packages/api-client`; server boots, migrates, serves a health
  endpoint.
- **Scope:** workspace config, Drizzle schema for `users`/`host_enrollments`/
  `hosts`, CI-ready `pnpm test`.
- **Tests:** schema/migration integration test against testcontainers PostgreSQL.
- **Verification:** `pnpm dev` boots server with a migrated database.

### Step 2: Admin auth + hosts API
- **Goal:** first-run setup, login/logout, host registration + enrollment tokens.
- **Scope:** auth routes with session cookies, hosts CRUD, token hashing.
- **Tests:** API integration tests for the full token lifecycle.
- **Verification:** curl/UI round-trip issues and consumes a token.

### Step 3: hostd channel
- **Goal:** hostd connects, authenticates, heartbeats, reconnects; server tracks
  status and replays queued commands.
- **Scope:** WS endpoints (`/api/v1/ws/host`, `/api/v1/ws/ui`), backoff logic, command queue
  table behavior.
- **Tests:** in-process channel integration tests including reconnect replay.
- **Verification:** two local hostd processes show online in the UI; kill/restart
  exercises offline detection.

### Step 4: Web UI shell + hosts page
- **Goal:** setup/login pages, app shell, hosts list with live status via `/api/v1/ws/ui`.
- **Scope:** Next.js app structure, auth wiring, hosts page.
- **Tests:** web store/component tests for online/offline transitions.
- **Verification:** phone-sized browser shows hosts flipping status live.

## Test Plan

Unit (token hashing/expiry, backoff math, session cookies, channel schemas,
hostd config perms, UiSocket reconnect, hosts store) — `pnpm test`.
Integration (auth + token lifecycle + channel reconnect with testcontainers PG;
channel tests drive the real WS endpoints with hostd's ChannelClient in-process)
— `pnpm test:integration` (22 tests). E2E: `pnpm e2e` runs enroll→online→offline
→restart→rotation and two-host coexistence with real hostd child processes
(foundation for later features' e2e). Browser smoke performed manually against
`pnpm dev` (phone viewport, live status flips).

## Open Questions

None — resolved 2026-09-06 by the owner: credential storage is a 0600 config file
for v1; heartbeat ships at 30 s / 3 missed intervals as configurable defaults.
