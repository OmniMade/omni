# Omni

Omni is a self-hosted control plane and host runtime that turns your own machines
(Mac mini, Linux boxes, servers) into agent workstations you can drive from any
device. Define tasks, dispatch them to a host, watch runs stream live, converse with
the agent mid-run, approve sensitive actions, and review the resulting diff — all
through one web window, over your private network (Tailscale).

The agent harness (OpenCode, Claude Code, Codex) is replaceable infrastructure.
The task, conversation, approval and acceptance flows do not depend on which harness
executes. **Task is the stable abstraction; harness is replaceable.**

> **Status: implementing.** The documents under `docs/` and `specs/` are the source
> of truth; implementation proceeds feature by feature via the
> [Roadmap](specs/ROADMAP.md). F001 (host enrollment & live connection) is
> delivered: monorepo scaffold, control plane, hostd daemon, and web UI.

## Getting Started

Prerequisites: Node.js 22+, Bun 1.2+ (hostd compile), pnpm 10+, PostgreSQL 16+
(`deploy/docker-compose.yml` or your own), and a Tailscale network covering
your server and client devices.

1. Start PostgreSQL (e.g. `docker compose -f deploy/docker-compose.yml up -d postgres`)
   and run the control plane (`pnpm -F @omni/server dev`, config in
   `apps/server/.env.example`); terminate TLS with `tailscale serve` or your
   reverse proxy (see [Architecture → Deployment](docs/ARCHITECTURE.md#deployment)).
2. Run the web UI (`pnpm -F @omni/web dev`), open it, create the admin account,
   and enroll a host with a token: `omni-hostd connect --server http(s)://… --token …`.
3. Register a workspace (git repository) on the host *(F002, not yet built)*.
4. Create a task, dispatch it, and talk to the agent from the run view *(F003+)*.

## Key Commands

| Command                     | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `pnpm dev`                  | Run server + web UI locally                    |
| `pnpm build`                | Build/typecheck all workspaces                 |
| `pnpm test`                 | Unit tests (all workspaces)                    |
| `pnpm test:integration`     | Integration tests (PostgreSQL via testcontainers) |
| `pnpm e2e`                  | End-to-end: server + real hostd processes      |
| `pnpm -F @omni/hostd compile` | Cross-compile standalone omni-hostd binaries |

## Documentation

- [Product definition](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Database](docs/DATABASE.md)
- [API](docs/API.md)
- [Frontend](docs/FRONTEND.md)
- [Testing](docs/TESTING.md)
- [Feature Roadmap](specs/ROADMAP.md)
