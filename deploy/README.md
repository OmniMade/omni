# Deployment notes

## Control plane

```bash
cd deploy
OMNI_POSTGRES_PASSWORD=... OMNI_SESSION_SECRET=$(openssl rand -hex 32) \
  docker compose up -d
```

- The compose stack runs PostgreSQL 16 + the server (`deploy/Dockerfile.server`).
- Set `PUBLIC_URL` in `deploy/docker-compose.yml` when the server is reachable
  under a different origin than it listens on (behind `tailscale serve` or a
  reverse proxy) so the printed `omni-hostd connect` commands are correct.
- Generate the session secret with `openssl rand -hex 32`; without a stable
  secret, admin sessions reset on every server restart.
- The web UI currently runs as a separate Next.js process (`pnpm dev` /
  `pnpm -F @omni/web build && pnpm -F @omni/web start`); serving it from the
  control plane's single origin is deferred until the deployment story is
  exercised on a real Tailnet.

## Host runtime

Build the standalone daemon and copy it to each host:

```bash
pnpm -F @omni/hostd compile   # → apps/hostd/bin/omni-hostd-{darwin-arm64,linux-x64,linux-arm64}
```

Run it under systemd (Linux) or launchd (macOS); service unit templates will
ship with F002. Requires git and the harness CLIs on the host; no inbound
ports — the daemon connects outward only.
