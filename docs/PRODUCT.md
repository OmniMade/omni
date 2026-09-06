# PRODUCT

## Goal

Agent harnesses (OpenCode, Claude Code, Codex, …) evolve quickly and are mutually
replaceable, but each is a terminal-bound, single-machine experience. Omni gives them
what they lack: a durable, remote, device-independent window between a human and the
agents working on their machines.

Omni lets you dispatch work to agents running on your own hosts, watch and **steer
them in conversation** while they run, approve sensitive actions, and review and
accept the results — from a phone or laptop browser, without SSH.

The product principle: **Task is the stable abstraction; harness is replaceable
infrastructure.** Nothing above the adapter layer knows which harness is executing.

## Target Users

Version 1 has exactly one user: the self-hosting developer/operator who owns the
hosts and the repositories. They run agents on a Mac mini or Linux box at home or in
a rack, and interact from anywhere over Tailscale. Multi-user and team features are
explicitly deferred.

## Core Use Cases

1. **Enroll a host** — install `omni-hostd` on a machine, enroll it with a one-time
   token, see it online. Hosts connect outward; no local ports are exposed.
2. **Register a workspace** — point a host at a git repository; Omni clones/fetches
   it and keeps it ready.
3. **Dispatch a task** — write a goal, pick workspace + harness, send. A run starts
   and its events (messages, tool calls, logs) stream live.
4. **Converse with the agent** — mid-run or after completion, send messages that
   steer, correct, or question the agent in the same conversation thread. Also open
   an ad-hoc chat session in a workspace without a formal task.
5. **Approve sensitive actions** — permission requests from the harness surface as
   approval cards; approve or deny from any device.
6. **Review and accept** — inspect the diff, logs, and test results; record an
   acceptance decision (accept/reject with a note) on the task.
7. **Resume or switch** — continue a finished run in the same harness, or hand the
   task context (including the conversation) to a different harness.
8. **Attach to an open session** — discover harness sessions already on the host:
   live-attach to a running OpenCode server session and steer it from anywhere, or
   adopt a stored session of any harness as an Omni run. Detach leaves the session
   running.

## Scope (v1)

- Single admin user, single self-hosted control plane on a private network
  (Tailscale).
- Hosts: macOS and Linux daemons connecting via outbound WebSocket.
- Harnesses (phase 1): OpenCode, Claude Code, Codex — integrated via the adapter
  interface, in that order.
- Tasks, runs, bidirectional conversation, approvals, artifacts (diff / log / test
  report), acceptance records, cancel/resume, harness handoff.
- Session attach & adopt: live attach where the harness exposes a session API
  (OpenCode server mode); stored-session adopt for all phase-1 harnesses.
- Git worktree isolation so multiple runs execute in parallel in one workspace.
- Responsive web UI (usable on a phone; no native app, no PWA).

## Out of Scope (v1)

- Multi-user accounts, teams, permissions, multi-tenancy.
- Automatic PR/MR creation or auto-merge. Acceptance records a decision; merging is
  done by the user in their own tooling.
- DSH and other harnesses (the adapter interface is the extension point; they arrive
  post-v1).
- Terminal/pty (tmux) bridging of already-running TUI sessions — the harnesses
  expose no live TUI API; v1 attach/adopt works at the session-API level only.
- Native mobile apps, PWA/offline behavior, push notifications.
- Scheduled/cron tasks, usage metering, billing, marketplace.
- Public-internet (SaaS) deployment.

## Success Criteria

- From a phone over Tailscale, without SSH: a task goes from creation → dispatch →
  live stream → mid-run chat reply → approval → diff review → accepted.
- The same task definition runs on at least two different harnesses with an
  identical UI flow and no product-level changes.
- Two runs execute concurrently in one workspace with no file conflicts (worktree
  isolation).
- If `omni-hostd` dies mid-run and restarts, run state reconciles and the event
  history is complete (no gaps in `seq`).
- From a phone over Tailscale: attach to an OpenCode server session already running
  on the host, steer it mid-conversation, and detach with the session still alive.
