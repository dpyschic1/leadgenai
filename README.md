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

Requires Node 20+ and Docker Desktop.

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
| `npm run db:up` | Start Postgres (Docker) |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse the database with Drizzle Studio |

## Layout

```
src/
  app/              routes (pages + /api/v1 route handlers)
  db/schema.ts      data model (PRD §13, MVP subset)
  db/index.ts       Drizzle client (server-only)
drizzle/            generated SQL migrations
docs/               PRD, SRS, product specification
```

## Data model (MVP)

`workspaces`, `users`, `companies`, `company_locations`, `people`, `company_people`, `signals`,
`signal_evidence`, `services`, `scoring_profiles`, `recipes`, `opportunities`,
`opportunity_signals`, `lists`, `saved_opportunities`, `audit_logs`.

Enum values (roles, intent level, opportunity status, identity status, contact verification)
follow SRS Appendix B.

Every tenant-owned table carries `workspace_id`; all queries must be scoped by it (PRD §19).
