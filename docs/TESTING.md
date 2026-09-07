# TESTING

## Testing Strategy

Risk concentrates in four places, and testing targets each directly:

1. **Protocol correctness** — AEP validation, gapless `seq`, gap detection
   (unit tests on `packages/aep` and server fan-out).
2. **Adapter translation** — each harness's raw CLI output → AEP events, in
   dispatch, adopt, and attach modes (fixture-driven contract tests, no live
   harness needed).
3. **Run supervision** — process lifecycle, cancel escalation, journal
   durability/replay, reconnect reconciliation (integration tests with a fake
   harness binary).
4. **State machines** — run/task/approval transitions, acceptance rules
   (unit + API integration tests against real PostgreSQL).

## Test Levels

- **Unit (vitest)** — pure logic: AEP/channel schemas (`packages/aep`), session
  cookie signing and token hashing (`apps/server/test/unit`), backoff math +
  config-file permissions + PATH detection (`apps/hostd`), UiSocket reconnect
  semantics (`packages/api-client`), hosts store transitions (`apps/web`).
- **Integration** — `apps/server/test/integration` against testcontainers
  PostgreSQL (one container per run, one database per test file): auth + hosts +
  enrollment token lifecycle, and the host channel — the real server WS
  endpoints driven by hostd's `ChannelClient` in-process (hello/heartbeat,
  supersede, fail-closed malformed messages, offline sweeper, reconnect replay,
  UI socket fan-out, rotation kick).
- **Adapter contract tests** — recorded fixture corpora per harness
  (`apps/hostd/src/harness/<name>/fixtures/`): raw CLI transcripts in, expected AEP
  event sequences out (ships with F003).
- **E2E smoke** — `pnpm e2e` (`apps/e2e`): testcontainers PostgreSQL + the
  in-process server + **real hostd child processes** (the same entry point
  `bun build --compile` bundles): enroll → online → kill → offline → restart →
  online → rotate (daemon exits instead of retrying), plus two hosts online
  simultaneously. Later features extend this flow through
  `packages/api-client`.
- **Manual smoke checklist per real harness** — before releasing an adapter, run the
  real CLI path once on macOS and Linux (documented in the adapter's spec).

## Test Environment

- PostgreSQL via testcontainers (no shared dev database).
- The **fake harness** (`apps/hostd/src/harness/fake/`) implements the adapter SPI
  with a scripted, deterministic agent: it emits messages, requests an approval,
  writes a file, and finishes, and it exposes one live attachable and one stored
  adoptable session (F010) — enough to exercise every product flow offline.
- No network access required for unit/contract tests; integration tests need only
  the Docker socket.
- Harness credentials/API keys are never needed in CI; live-harness smoke is manual.

## Key Commands (target)

| Command                 | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `pnpm test`             | Unit + contract tests (all workspaces)     |
| `pnpm test:integration` | Integration tests (testcontainers)         |
| `pnpm e2e`              | End-to-end smoke with fake harness         |
| `pnpm -F @omni/web test`| Web UI component/store tests               |
