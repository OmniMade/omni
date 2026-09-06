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

- [ ] First-run setup creates the admin; a second call is rejected.
- [ ] Enrolling a host via the printed command makes it appear online in the UI
      within seconds.
- [ ] Killing hostd flips the host to offline within ~90 s; restarting it restores
      online without re-enrollment.
- [ ] A second host enrolls and both coexist (stable per-host channels).
- [ ] Rotating a host credential forces re-enrollment; the old credential is
      refused.
- [ ] `bun build --compile` produces a standalone hostd binary for macOS (arm64)
      and Linux (x64/arm64).

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

Unit (token hashing/expiry, backoff math), integration (auth + token lifecycle +
channel reconnect with testcontainers PG), E2E seed: `pnpm e2e` gains
enroll→online→offline assertions (foundation for later features' e2e).

## Open Questions

- Heartbeat interval/timeout tuning (30 s / 90 s proposed) — confirm during
  dogfooding.
- Should hostd store its credential in the system keychain instead of a config
  file? (Proposed: config file with 0600 perms for v1.)
