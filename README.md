# Omni

Omni is a self-hosted control plane and host runtime that turns your own machines
(Mac mini, Linux boxes, servers) into agent workstations you can drive from any
device. Define tasks, dispatch them to a host, watch runs stream live, converse with
the agent mid-run, approve sensitive actions, and review the resulting diff — all
through one web window, over your private network (Tailscale).

The agent harness (OpenCode, Claude Code, Codex) is replaceable infrastructure.
The task, conversation, approval and acceptance flows do not depend on which harness
executes. **Task is the stable abstraction; harness is replaceable.**

> **Status: design phase.** The documents under `docs/` and `specs/` are the source
> of truth. Implementation proceeds feature by feature via the
> [Roadmap](specs/ROADMAP.md); the commands below are the targets the roadmap
> delivers, not yet present in the repository.

## Getting Started (target)

Prerequisites: Node.js 22+, Bun 1.2+, pnpm 10+, PostgreSQL 16+, and a Tailscale
network covering your server and client devices.

1. Run the control plane (`apps/server`) against a PostgreSQL database; terminate
   TLS with `tailscale serve` or your reverse proxy (see
   [Architecture → Deployment](docs/ARCHITECTURE.md#deployment)).
2. Open the web UI, create the admin account, and enroll a host with a token:
   `omni-hostd connect --server wss://… --token …`.
3. Register a workspace (git repository) on the host.
4. Create a task, dispatch it, and talk to the agent from the run view.

## Key Commands (target)

| Command                     | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `pnpm dev`                  | Run server + web UI locally                    |
| `pnpm build`                | Build server, hostd, and web                   |
| `pnpm test`                 | Unit tests (all workspaces)                    |
| `pnpm test:integration`     | Integration tests (PostgreSQL via containers)  |
| `pnpm e2e`                  | End-to-end smoke against the fake harness      |

## Documentation

- [Product definition](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Database](docs/DATABASE.md)
- [API](docs/API.md)
- [Frontend](docs/FRONTEND.md)
- [Testing](docs/TESTING.md)
- [Feature Roadmap](specs/ROADMAP.md)
