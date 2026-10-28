# LeadGenAI

B2B Opportunity Intelligence: surface evidence-backed business opportunities
(Company + Person + Problem + Intent + Evidence + Timing + Fit + Action) instead of contact lists.
Specs live in `docs/`:

- [`B2B_Opportunity_Intelligence_PRD.pdf`](docs/B2B_Opportunity_Intelligence_PRD.pdf) — product requirements (what and why)
- [`B2B_Opportunity_Intelligence_SRS.pdf`](docs/B2B_Opportunity_Intelligence_SRS.pdf) — software requirements (numbered FRs, roles, API, enums)
- [`B2B_Opportunity_Intelligence_Product_Specification.pdf`](docs/B2B_Opportunity_Intelligence_Product_Specification.pdf) — screens, schema detail, scoring weights, 30-day plan

## MVP scope

- **No automated ingestion.** Companies, people and signals are entered manually.
  Provider adapters, enrichment and the ingestion pipeline (PRD §14) come later.
- **No pgvector.** Semantic similarity is only needed for NL search / entity resolution
  over ingested data; it can be added later as a single migration.
- Single Next.js app: UI + REST API (`/api/v1/*` route handlers).

## Stack

- Next.js 16 (App Router, Cache Components), React 19, TypeScript, Tailwind CSS 4
- PostgreSQL 17 via Docker Compose
- Drizzle ORM + drizzle-kit migrations, `postgres` driver, Zod

## Getting started

Requires Node 22+ and Docker Desktop.

```sh
npm install
cp .env.example .env      # DATABASE_URL for the local container
npm run db:up             # start Postgres
npm run db:migrate        # apply migrations
npm run dev               # http://localhost:3000
```

Health check: `GET /api/v1/health`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm test` / `npm run test:watch` | Unit tests (Vitest) |
| `npm run db:up` | Start Postgres (Docker) |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse the database with Drizzle Studio |

## Architecture

```
src/
  app/
    (auth)/             login, signup (public)
    (app)/              signed-in app shell + pages
    api/v1/             REST route handlers — thin: parse → service → DTO
  server/               server-only code
    auth/               password hashing, DB sessions
    http/               route wrappers (auth, roles, errors, request ids), AppError
    services/           business logic; always scoped by the session's workspaceId
  db/                   Drizzle schema, client, DB error helpers
  lib/
    api/                typed fetch client + one module per resource, DTO types, error contract
    validation/         Zod schemas shared by forms and route handlers
  hooks/                TanStack Query hooks (call lib/api only)
  components/           UI (call hooks only); components/ui = shadcn/ui
  providers/            client providers (query client, theme, toasts)
  proxy.ts              optimistic redirects by session-cookie presence
drizzle/                generated SQL migrations
docs/                   PRD, SRS, product specification
```

Frontend data flow is one-directional: **component → hook → `lib/api` → `/api/v1` route → service → DB**.
Components never call `fetch`; route handlers never contain business logic.

### Conventions

- **Route handlers** use `publicRoute` / `authedRoute` from `src/server/http/handler.ts`, which add
  the request id, enforce roles, block cross-origin mutations and map errors to the
  SRS §12.3 contract: `{ "error": { "code", "message", "request_id", "field_errors?" } }`.
- **Tenant isolation:** services take `workspaceId` from the authenticated session, never from
  the request body or URL.
- **Auth:** database sessions (revocable). The browser holds a random token in the httpOnly
  `lg_session` cookie; the DB stores only its SHA-256. Passwords are hashed with argon2id.
- **Validation:** one Zod schema per input in `src/lib/validation`, used by both the form
  (react-hook-form) and the route handler.

## Data model (MVP)

`workspaces`, `users`, `companies`, `company_locations`, `people`, `company_people`, `signals`,
`signal_evidence`, `services`, `scoring_profiles`, `recipes`, `opportunities`,
`opportunity_signals`, `lists`, `saved_opportunities`, `audit_logs`.

Enum values (roles, intent level, opportunity status, identity status, contact verification)
follow SRS Appendix B.

Every tenant-owned table carries `workspace_id`; all queries must be scoped by it (PRD §19).
