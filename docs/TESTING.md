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

- **Unit (vitest)** — pure logic: AEP schemas, event sequencing, worktree/branch
  naming, acceptance rules, adapter pure translation functions.
- **Integration** — server API + PostgreSQL via testcontainers; hostd channel tests
  running server and hostd in-process over a local WebSocket with the fake harness.
- **Adapter contract tests** — recorded fixture corpora per harness
  (`apps/hostd/src/harness/<name>/fixtures/`): raw CLI transcripts in, expected AEP
  event sequences out. CI runs them offline; live-harness runs are a manual
  pre-release step.
- **E2E smoke** — `pnpm e2e`: compose (server + PostgreSQL + hostd with the fake
  harness), then drive the full flow through `packages/api-client`: enroll →
  workspace → task → dispatch → live events → mid-run message → approval → diff
  artifact → acceptance. Asserts observable API/UI-serving behavior, not internals.
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
