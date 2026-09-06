# FRONTEND

## Stack

Next.js (App Router) + TypeScript, Tailwind CSS + shadcn/ui components, TanStack
Query for REST fetching, zustand for the live event store, `packages/api-client`
for all server communication. Served by the control plane at the same origin.

## Structure

```
apps/web/src/
├── app/                    # routes (server components for initial data)
│   ├── (auth)/setup, login
│   ├── hosts/              # host list + enrollment
│   ├── workspaces/
│   ├── tasks/              # list + [id] detail
│   └── runs/[id]/          # the run view — the core screen
├── components/
│   ├── chat/               # message stream, composer, event cards
│   ├── approvals/          # approval cards (inline + global badge)
│   └── artifacts/          # diff viewer, log viewer, test report
└── lib/                    # api client wiring, ws subscription, stores
```

## State and Data

- **Initial data** via server components; **mutations and refetching** via TanStack
  Query.
- **Live run view**: one zustand store per open run, fed by the `/api/v1/ws/ui`
  subscription. Events append in `seq` order; a detected gap triggers a REST
  backfill (`GET /runs/:id/events?after=<seq>`) before further appends.
- **Message send** is optimistic: the user message renders immediately, reconciles
  when the server-persisted `user.message` event arrives, and shows a failure state
  if the run is no longer live.
- The run view renders the event stream as a conversation: `user.message` /
  `agent.message` as chat bubbles, `tool.call`/`tool.result` as collapsible cards,
  `log.line` as an inline log tail, `approval.requested` as an actionable card.

## Conventions

- Mobile-first responsive layout; the run view must be fully usable one-handed.
- Server components by default; client components only where interactivity requires
  them (run view, forms).
- Errors: route-level error boundaries + toast for mutation failures; never blank
  screens.
- Capability-driven UI: hide "continue"/handoff entry points when the harness
  reports `resume: false`.
- All user-visible text in English (matching the product docs) through a single
  strings module, so localization remains possible later.
