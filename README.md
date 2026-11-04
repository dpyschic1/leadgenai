# LeadGenAI

B2B Opportunity Intelligence: surface evidence-backed business opportunities
(Company + Person + Problem + Intent + Evidence + Timing + Fit + Action) instead of contact lists.
Specs live in `docs/`:

- [`B2B_Opportunity_Intelligence_PRD.pdf`](docs/B2B_Opportunity_Intelligence_PRD.pdf) — product requirements (what and why)
- [`B2B_Opportunity_Intelligence_SRS.pdf`](docs/B2B_Opportunity_Intelligence_SRS.pdf) — software requirements (numbered FRs, roles, API, enums)
- [`B2B_Opportunity_Intelligence_Product_Specification.pdf`](docs/B2B_Opportunity_Intelligence_Product_Specification.pdf) — screens, schema detail, scoring weights, 30-day plan

## MVP scope

- **Automatic data from free sources, plus manual entry.** Companies, people and signals come from
  Companies House, company websites, public job boards and UK tenders (see below), or are entered by hand.
  Licensed providers (Apollo, Crunchbase…) plug in later as more adapters.
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

### Automatic data (companies, people, signals)

Nothing to set up: from **Services & ICP** (target industries and countries) the system, every day:

1. **finds UK companies**
   - on **Companies House**, by the industries' SIC codes, newly formed ones first (a new business
     is itself a "new startup" signal), with their **directors**;
   - for dental and healthcare ICPs, on the **CQC register** (England only): each provider becomes a
     company and each of its practices a separate location, with website and phone. A Companies
     House number is linked only on an exact name **and** postcode match. The weekly directory
     (zip) needs no key; the optional API adds registration dates (a "new location" signal) and
     registered managers.
2. **finds and reads each company's website.** A site is accepted only when it shows the company
   number, the name plus the town, or links back to the company's own job board. It reads:
   - structured data (schema.org), team, published contacts and its job board;
   - **rule-based checks, before any AI:** no HTTPS, an out-of-support CMS (e.g. WordPress < 6),
     no online booking for dental, health and hospitality. These are recorded as low-intent
     "possible problems", with evidence, only for workspaces that sell a fix.
3. **discovers job boards on its own.**
   - Candidate Greenhouse, Lever, Ashby and Workable boards come from the **Common Crawl** archive index
     (plus boards found on websites). Each is **validated** against the provider's public API, and
     its jobs are cached once for all workspaces (`job_board_directory`, `board_jobs`).
   - Each workspace then judges the jobs in its own target countries with a cheap AI title check.
     A board with relevant jobs becomes a company (matched by evidence, or created **provisional**
     under the board's own name) with an opportunity, even when no register matches. A board with
     none creates nothing.
   - Relevant roles get the full signal analysis (the same role in several places counts once),
     a few per run within Groq's free limits. A deleted signal stays deleted.
   - Coverage is broad, not complete: only boards the archive has crawled. The archive index is
     often slow (504s); progress resumes where it stopped.
4. checks **UK public tenders** (Contracts Finder) for its services;
5. adds **OpenStreetMap** contacts for companies and practices it already has (see below);
6. records signals with source links and re-scores the companies.

It also runs straight after a service is saved, and on **Run now** in Settings → Data sources,
where each source can be switched off. Every fact keeps its source (`source_records`); see a
company's **Sources** card. Adapters live in `src/server/sources/`, the job queue and handlers in
`src/server/ingestion/`.

**Identity and matching rules**
- Companies are matched by registry number, then website domain, then the same source's own
  earlier record. A name counts only together with the same postcode, and never when it fits
  several companies.
- People are never merged on name alone.
- A company is *provisional* (known only by one source's name for it), *partly verified* (website
  confirmed) or *verified* (register number, or entered by hand).

**Emails**
- An address on the company's site that is clearly a person's is stored as **published**.
- A pattern (e.g. `first.last@`) is **inferred** only when at least two people's published
  addresses agree on it and the domain has mail servers (MX). MX shows the domain takes email,
  not that the mailbox exists.
- Inferred addresses are never shown as verified; only a person can verify one.

**OpenStreetMap** (contacts only: it never creates, merges or renames a company)
- *Import, weekly and offline:* `.github/workflows/osm-import.yml` downloads Geofabrik's Great
  Britain extract and keeps only the business categories in `OSM_CATEGORY_INDUSTRY`
  (`src/server/sources/osm.ts`) using `osmium tags-filter` and `osmium export`. Then
  `npm run osm:import -- pois.geojsonseq` loads the named places that have a phone, website or
  email into `osm_places`. Places missing from a later extract are marked removed. Public Overpass
  and Nominatim servers are not used: their policies rule out a SaaS backend and bulk lookups.
  To try it locally, use a small extract (e.g. `europe/united-kingdom/england/west-yorkshire`) with
  `osmium` installed.
- *Matching, daily per workspace (`match_osm`):* each practice or company site links to at most
  one place, in this order:
  1. the CQC location id the place carries (`ref:GB:cqc_location`);
  2. otherwise the same postcode, a category that fits the company's industry, and clearly
     agreeing names (identifying words, not "Dental" or "Ltd"), with exactly one candidate.
  A place two companies could claim links to neither. Links are rechecked on every run.
- *Shown after the company's own contacts,* as "Published on OpenStreetMap, not verified by us"
  with "© OpenStreetMap contributors" linked to openstreetmap.org/copyright: on the card, the
  opportunity page, the Sources card, and in the `contact_type` column of CSV exports.
- *Licence (ODbL 1.0):* OSM data stays in `osm_places` and `osm_matches` and is never copied into
  our company rows, so the OSM-derived database stays separate from ours. This section and
  `osm.ts` are the method of making it, which ODbL 4.6 asks us to offer. Have the design reviewed
  before relying on it commercially. A sole trader's number or email is personal data (UK GDPR,
  PECR): email them only with consent.

**Sources not used**
- **FCA register:** its terms require written permission to store or redistribute register data.
  It is registered as `restricted`, so it cannot run.
- **SRA:** its terms forbid unsolicited marketing.
- **LinkedIn, Google Maps:** their terms forbid scraping.

**Data use**
- CQC data is used under the Open Government Licence v3.0, shown on the company's Sources card.
- Job-board APIs are public, and their docs are silent on third-party storage. We keep only what
  evaluation and evidence need, link to each original posting, honour Ashby's "not listed" flag,
  and delete closed jobs after 90 days.

Settings (`.env` locally, Vercel Environment Variables in production):

- `COMPANIES_HOUSE_API_KEY`: free key from developer.company-information.service.gov.uk
  (Your applications → Create an application → Create new key → REST). Without it, companies
  aren't discovered on Companies House; the other sources still work.
- `CQC_API_KEY` (optional): free key from api-portal.service.cqc.org.uk, for registration dates and
  registered managers. The directory works without it.
- `CRON_SECRET`: any long random string. A free scheduler (e.g. cron-job.org) calls
  `POST /api/v1/internal/tick` every 5 minutes with `Authorization: Bearer <CRON_SECRET>`.

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
| `npm run test:integration` | Database tests (tenant isolation, team, filters, job boards, automatic data); need the database from `.env`, and clean up after themselves |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Browse the database with Drizzle Studio |
| `npm run db:seed:demo` | Create (or reset) the demo workspace |
| `npm run osm:import -- <file.geojsonseq>` | Load OpenStreetMap businesses from an `osmium export` file (see OpenStreetMap above) |

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
| Job boards | `company_job_boards` (one per company), `job_postings` (jobs seen, AI verdict, link to the signal) |
| Automatic data | `sources` (registry, seeded), `workspace_sources` (on/off), `source_records` (provenance), `company_identifiers`, `company_contact_points`, `ingestion_jobs` (queue) |
| Job-board discovery (shared) | `job_board_directory` (validated boards), `board_jobs` (cached public jobs), `directory_crawls` (archive progress) |
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
