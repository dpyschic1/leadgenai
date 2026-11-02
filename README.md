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
- PostgreSQL 17 (installed locally)
- Drizzle ORM + drizzle-kit migrations, `postgres` driver, Zod

## Getting started

Requires Node 22+ and PostgreSQL 17.

### 1. Install PostgreSQL 17

Download the installer from [postgresql.org/download/windows](https://www.postgresql.org/download/windows/)
(EDB installer, **17.x**, Windows x86-64; the file is `postgresql-17.x-…-windows-x64.exe`, not `pgadmin4-…`).
In the installer keep **PostgreSQL Server** and **Command Line Tools**, set a password for the
`postgres` superuser and note the **port** you choose (default `5432`). It runs as the Windows
service `postgresql-x64-17` and starts with Windows. pgAdmin 4 is the optional graphical tool.

### 2. Create the app's login and database

In pgAdmin (Login/Group Roles → Create, then Databases → Create) or with `psql`:

```sh
psql -U postgres -p <port> -c "CREATE ROLE leadgenai LOGIN PASSWORD 'leadgenai';"
psql -U postgres -p <port> -c "CREATE DATABASE leadgenai OWNER leadgenai;"
```

`psql` lives in `C:\Program Files\PostgreSQL\17\bin`; add that folder to `PATH` to run it by name.

### 3. Configure and run

```sh
npm install
cp .env.example .env      # set DATABASE_URL's port to the one PostgreSQL listens on
npm run db:migrate        # create the tables and reference data
npm run dev               # http://localhost:3000
```

Health check: `GET /api/v1/health`.

### Demo data

```sh
npm run db:seed:demo
```

Creates the workspace **Northwind Digital (demo)**: sign in as `demo@leadgenai.example` / `Demo@12345`
(teammate: `priya@leadgenai.example`, same password). It covers the three MVP workflows from the
Product Specification (§13.1) with fictional companies (`.example` domains):

| Workflow | Companies | Shows |
| --- | --- | --- |
| Website / digital | Harbourside Legal, BrightSmile Dental, Calder & Co | explicit vendor search, stacked signals, a weak (low-score) rebrand |
| Staff augmentation | Ledgerline Payments, Freightly, Quillstack | hiring surge, long-open vacancy, a hiring freeze lowering the score |
| Startup / MVP | Medora Health, Tidepool Robotics | seed funding + a direct request for a development partner, a new startup |

It also adds lists, opportunities in progress (contacted, meeting), team feedback, and people with
different identity and email-verification states. Re-running it replaces the demo workspace and
leaves every other workspace alone.

### Backup and restore

```sh
pg_dump -U leadgenai -h localhost -p <port> -d leadgenai -Fc -f leadgenai.dump
pg_restore -U leadgenai -h localhost -p <port> -d leadgenai --no-owner leadgenai.dump   # into an empty database
```

Or in pgAdmin: right-click the database → **Backup…** / **Restore…** (format *Custom*).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm test` / `npm run test:watch` | Unit tests (Vitest) |
| `npm run test:integration` | Database tests (tenant isolation, team, filters); need the database from `.env`, and clean up after themselves |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse the database with Drizzle Studio |
| `npm run db:seed:demo` | Create (or reset) the demo workspace |

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

The schema (`src/db/schema.ts`) is normalized so post-MVP features can be added without reworking it.

| Area | Tables |
| --- | --- |
| Identity & tenancy | `users` (login identity), `workspaces`, `workspace_members` (role per workspace), `workspace_invitations`, `sessions` |
| Entities | `companies`, `company_locations`, `people`, `contact_points`, `company_people` (title, seniority, job function) |
| Signals | `signals`, `signal_evidence`, `signal_service_categories` |
| Customer config | `services` + `service_service_categories`, `service_target_industries`, `service_target_job_functions`, `service_target_countries`; `scoring_profiles`, `recipes` |
| Opportunities | `opportunities`, `opportunity_signals`, `lists`, `saved_opportunities` |
| Governance | `audit_logs`, `rate_limits` |
| Reference data (global, seeded) | `signal_categories`, `signal_types`, `service_categories`, `industries`, `job_functions`, `opportunity_types` |

Rules:

- **Lookups, not free text.** Shared vocabularies are lookup tables keyed by a stable slug
  (e.g. `web_development`); code and AI output use the slug. Add values with a migration.
- **No matched-on arrays.** Multi-valued attributes are join tables.
- **Tenant isolation in the database.** Tenant-owned rows carry `workspace_id`, and references
  between them are composite FKs on `(id, workspace_id)`, so a row can never point at another
  workspace's data. Child rows (locations, contact points, evidence) are scoped via their parent.
  All queries must still be scoped by the session's workspace (PRD §19).
- **Derived values are derived.** Location count and headquarters come from `company_locations`;
  a signal's category comes from its `signal_type`. The few cached values (opportunity scores,
  `latest_signal_at`) are marked `Denormalized:` in the schema with the reason.
- **Countries** are ISO 3166-1 alpha-2 codes (`GB`, `US`), enforced by a check constraint.

Enum values (roles, intent level, opportunity status, identity status, contact verification)
follow SRS Appendix B.

Migrations are append-only: never edit one that has been committed. A few migrations contain
hand-edited SQL (ordering, `ON DELETE SET NULL (column)`, data copies); each edit is commented.
