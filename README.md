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

> **Focus on US companies (2026-11-10):** the UK-only sources (Companies House, CQC, UK tenders,
> OpenStreetMap) are switched off for every workspace (migration `0024`, `authorization_status =
> 'disabled'`); their code and the data they already found stay. New companies come from
> **Y Combinator companies**, TheirStack, job-board discovery and the US NPI Registry. To switch a
> UK source back on, set its `sources.authorization_status` to `'approved'`.

0. **takes Y Combinator startups** (`discover_yc`, `src/server/sources/yc.ts`): every YC company
   (~6,400; ~4,800 in the US) is kept in the global `yc_companies` table, loaded from the
   third-party [`yc-oss/api`](https://github.com/yc-oss/api) dataset (`npm run yc -- import`, then
   refreshed by the job when a week old). Each run takes 15 active companies in the workspace's
   target countries (and industries, when set), hiring ones first, newest batch first, with their
   YC website (identity "partly verified"); their website and job board are read next. The dataset
   is unofficial with no stated licence, and YC's site terms restrict reuse of directory content:
   using it was the product owner's decision, recorded on its `sources` row. No people or contact
   details are taken from it.
   - *Their job boards join the shared pool* (`detectYcBoards`, one company per tick; `npm run yc --
     boards [count]` for a first pass): the board each US YC company's own website links to, else a
     board under its own slug or domain that states its website or whose jobs mention its domain (a
     shared name alone proves nothing). Hiring and bigger companies first. A matched job on such a
     board makes the company from its YC record (name, website, location), not a provisional one.
1. **finds UK companies** *(switched off, see above)*
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
   - Candidate Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Personio and Breezy HR boards come from the **Common Crawl** archive index
     (plus boards found on websites). Each is **validated** against the provider's public API, and
     its jobs are cached once for all workspaces (`job_board_directory`, `board_jobs`).
   - **Shared job intelligence** (`src/server/ingestion/shared-jobs.ts`): *discover once, analyse
     once, match many times.*
     1. *Categorise (shared, free):* every cached job gets the service categories its title points
        to (`categorizeJob` rules, `board_job_categories`), a few thousand per tick.
     2. *Match (per workspace, no AI, seconds):* `evaluate_boards` takes the open jobs in the
        workspace's service categories and target countries (last 90 days), 40 companies per run.
        Each board becomes a company (matched by evidence, or created **provisional** under the
        board's own name) with its jobs and an opportunity at once: a job already read by the AI
        gives the AI's signal, any other a rule-based one stating only the facts (source
        "provider", `ruleJobSignal`). It runs straight after a service is saved (`after()`), so a
        new workspace fills up in minutes.
     3. *Analyse (shared, AI, background):* the jobs behind rule-based signals are read in full by
        the AI **once** (`job_analyses`), newest first; every workspace's signal from that job is
        upgraded, or removed (job marked skipped) when the AI finds no buying signal. Its
        categories replace the title rules'.
   - The job-board sync (`syncCompanyJobs`) uses no AI either: categories decide relevance, the
     shared analysis or a rule signal records it. The same role in several places counts once; a
     deleted signal stays deleted.
   - *Ranking* (`boardScore`): matched companies come strongest first: several distinct matching
     roles, a buying signal the AI confirmed, a known (YC) company, a fresh post, several of the
     workspace's services.
   - *TheirStack posts are shared too* (`theirstack_jobs`): each post is bought once (one credit)
     and read by the AI once; a workspace first takes the shared posts that fit its services and
     countries, and buys new ones only when none are left.
   - *Websites are read once* (`site_reads`): a site read for one workspace is reused by the others
     for 7 days, and the AI's reading of its profile pages (description, team) while they are
     unchanged. Each workspace saves its own contacts and people from it. "Refresh from sources"
     always reads the site afresh.
   - Coverage is broad, not complete: only boards the archive has crawled. The archive index is
     often slow (504s); progress resumes where it stopped.
4. checks **UK public tenders** (Contracts Finder) for its services;
5. adds **OpenStreetMap** contacts for companies and practices it already has (see below);
6. records signals with source links and re-scores the companies.

**The worker** (`runTick`, every minute via cron-job.org → `POST /api/v1/internal/tick` on
Vercel) runs the shared steps, then **9 lanes side by side**: one takes jobs in the usual order
(discovery and matching first, workspaces taking turns), eight take only website and contact jobs
(`enrich_company`, `scan_website`, `scan_job_board`), best-scored opportunities first. Opening an
opportunity with no contacts puts its company's look-up at the front (`contactsWanted`, job
`priority`). Each website still gets one request a second (`politeGet`).

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
- Inference runs only for UK and US companies (`INFERRED_EMAIL_COUNTRIES` in
  `src/server/ingestion/handlers.ts`). EU regulators treat a guessed named address as personal data
  that needs a lawful basis, and Germany needs prior consent for any marketing email. For the UK,
  keep a documented legitimate-interest assessment.

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

**Overture Maps** (contacts and candidate websites for companies we already have)
- *Lookup, weekly (Mondays) and offline* (`.github/workflows/overture-match.yml`):
  1. `npm run overture -- targets targets.csv` lists our companies' websites and, for those
     without one, their headquarters' postcode.
  2. DuckDB reads only the matching places from Overture's public bucket (newest release,
     confidence of at least 0.7). The full dataset (about 88 million places) is never copied.
  3. `npm run overture -- load places.json` matches and saves (`--dry-run` shows what it would
     save without writing).
- *Matching* (`proposeOvertureMatches` in `src/server/sources/overture.ts`):
  - a place on the company's own website domain gives its phone and own-domain email, stored as
    company contacts with source "Overture Maps";
  - for a company without a website, exactly one place at its postcode with clearly the same name
    gives a *candidate* website. `enrich_company` accepts it only after the usual evidence on the
    site itself (company number, or name with postcode or town);
  - anything ambiguous matches nothing.
- *Licence:* CDLA Permissive 2.0 (Apache 2.0 for Foursquare, CC0 for some sources). Storing and
  showing the data is allowed with attribution: "© Overture Maps Foundation; includes data from
  Meta, Microsoft, Foursquare and others" (`OVERTURE_ATTRIBUTION`).
- To run it by hand, install the DuckDB CLI and run the three steps with `DATABASE_URL` set.

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

### Web Scraping & Discovery Engine (shared collection layer)

A separate engine (`src/server/collection/`) that collects public items **once for every
workspace** into global tables. It is independent of the Company Discovery Engine and the LeadGen
Engine, which read what it collected:

- **Company Discovery** (`matchCollectedJobs` in `ingestion/shared-jobs.ts`, run by `evaluate_boards`
  after the board matching, in the same time budget): open collected jobs in a workspace's service
  categories and countries become companies found by their own website's domain (never a job
  site's), each job recorded as looked at (`web_collection` source records), the strongest 3 roles
  as rule-based signals, ranked like board companies. A company the workspace already follows
  through its job board is left out. Switchable per workspace as the "Own web collection" data
  source (`web_collection`, migration `0040`). Not in a company's Jobs tab (that is built on the
  job-board tables) and not read by the AI yet.
- **LeadGen** (`yc-batches.ts`): a recent YC startup's open roles include the jobs collected from its
  own careers page, Gem or Rippling board, by its domain.

- **Collectors** (`collectors/`) implement one contract (`types.ts`) and only read their source; the
  runner stores, deduplicates, categorizes and logs. A source runs only when its `sources` row is
  `approved` (Phase 0 review, migration `0036`).
- **Tables:** `collection_targets` (what to collect, cursor, schedule, lease), `collection_runs` (the
  collection log), `collected_items` (original URL, page read from, extraction method, first/last
  seen, closed, content hash, dedupe key, `duplicate_of`), `collected_item_categories`.
- **HTTP** goes through `politeGet` (robots.txt, one request a second per site, public addresses
  only) plus a hard block on sites whose terms forbid automated collection (LinkedIn, Indeed,
  Google Search, Glassdoor…; `collection/fetch.ts`), a request budget and a deadline per run.
- **Load:** at most 8 targets are collected at once across every call and server instance (leases
  counted in the database, claims serialized by an advisory lock); a site is one target, so one run
  at a time reads it, one request a second.
- **Freshness:** a target's interval halves when something changed and doubles when nothing did
  (6 h to 7 days); a complete run closes items it no longer finds; an item past its stated expiry
  (`valid_through`) is closed on the next call; failures back off 1, 4, 16, 64 minutes. Closed items
  go after 14 days and items older than 60 days are pruned.
- **Duplicates:** items sharing a dedupe key form a group whose original is the earliest-seen open
  item (the earliest item when all are closed); the rest point at it. The group is recomputed
  whenever a member is added, changes, closes, reopens or is pruned.
- **Websites that moved:** a home page redirecting to another domain is followed (at most two moves)
  only to a public website: never an IP address, a local host, a parked domain, a blocked platform,
  or back to a domain already passed (a loop); the new site's own fetch keeps every network check.
  The old target keeps the original URL and redirect history and is switched off; the new domain
  becomes a target once (`params.movedFrom`), so a domain change never makes a duplicate.
- **Scheduler:** `POST /api/v1/internal/collect` with `Authorization: Bearer <CRON_SECRET>`, every
  few minutes (a second cron-job.org job beside the tick). The local dev ticker calls it too.
- **First collector, `career_pages`:** jobs on a company's own careers page (home page link or
  sitemap, then job pages). Targets come from US YC companies and websites already read. A careers
  page that links to a job board we already read is skipped; one that needs a browser is flagged
  (`cursor.needsRender`), not rendered.
  - *Markup first:* schema.org JobPosting (extraction `json_ld`).
  - *Else HTML* (`collectors/html-jobs.ts`, extraction `html`): each link on the listing that points
    at a job (its own page, a `?job_id=`/`#job` anchor, or a job board such as YC's or an ATS) and
    whose title reads as a role, with its facts (place, contract, pay); then each job's own page for
    the description, accepted only when it reads as one (and never template placeholder text). Team
    bios, quotes, menus, footers and filters are not jobs, nor are links to job areas, searches or
    filters ("…Opportunities", "Support Services", `?jobFamily=`). Job boards elsewhere are linked
    (`data.applyUrl`), never fetched; a job's address there is its id.
- **Gem and Rippling boards** (`collectors/hosted-boards.ts`, sources `gem_board`, `rippling_board`):
  ATSs where startups post that the Company Discovery Engine doesn't read. A careers page (or a
  home page without one) that links its jobs to a Gem or Rippling board hands them over: the board
  becomes a target of its collector (`params.company`), the page's own cards for those jobs close at
  once (`handedOver`), and the board gives the full list with dates, places and descriptions.
  - *Gem:* the public Job Board API Gem documents (`api.gem.com/job_board/v0/{board}/job_posts/`).
  - *Rippling:* the public board pages' data (`ats.rippling.com/{board}/jobs`, 20 jobs a page) and
    each new job's own page for its description, read once (dates kept in the cursor).
  - Jobs first posted more than 60 days ago are left out, as everywhere (`isStaleJob`).
  - Phase 0 (migration `0037`): Dover is not collected (its jobs load from `/api/`, disallowed by its
    robots.txt); BambooHR's careers feed is undocumented and waits for a decision (`pending_review`).
  - First run (2026-11-18): 12 boards found on the careers pages already read, 48 open jobs from 8
    companies with dates and places, replacing title-only cards; Gem and Rippling sometimes answer
    slower than the 10 s limit, and the normal backoff retries them.
- A job that comes back without its text (its page not read this run) keeps the stored description.
- **Hacker News** (`collectors/hacker-news.ts`, source `hacker_news`, public HN Search API, no key),
  three targets, twice a day:
  - `who-is-hiring`: the monthly "Ask HN: Who is hiring?" thread, read whole in one request. Each
    company's post with the "Company | Role | Place | …" header is a job (company, first role, place,
    pay, contract); the company's website is one its header states, else the first link that isn't
    a job board, code host, form, video or profile. Posts without a role (a PhD, "Shepherd | ONSITE")
    are left out; last month's posts close when the new thread arrives.
  - `seeking-freelancer`: SEEKING FREELANCER posts (in that thread or the hiring one) are buyer
    requests (kind `post`, intent high), with the work they name as categories.
  - `ask-hn-requests`: Ask HN posts whose title asks to hire an agency or developer (the LeadGen
    Engine's `readIntent`, imported, unchanged).
  - First run (2026-11-18): 243 posts in the November thread → 157 jobs (99 with the company's
    website, 83 with a country, 55 in the US, 96 fitting a service category) and 1 buyer request;
    a manual review of 30 found company and role right in all 30. The November freelancer thread had
    only SEEKING WORK posts (freelancers), so no requests; Ask HN found none in 60 days.
- **SAM.gov** (`collectors/sam-gov.ts`, source `sam_gov`): US federal contract opportunities through
  GSA's Get Opportunities Public API. Needs `SAM_GOV_API_KEY` (free: SAM.gov → Account Details →
  Public API Key); without it the target waits, it never fails. A personal key may allow only about
  10 calls a day, so it runs once a day and makes at most 3 calls (1,000 notices each) for
  everything posted since its last run. Keeps open solicitations, presolicitations and
  sources-sought notices in IT, web, design and marketing NAICS codes (`SAM_NAICS`), or whose title
  names such work, as tenders (kind `tender`): agency, place, deadline, set-aside. Contracting
  officers' names and emails are not kept. Not yet run live (no key).
- Countries in text: current ISO codes only (the shared `countriesNamedIn` also returns obsolete DD
  for "Germany"), and "US"/"USA" in capitals is the United States.
- **Search** (`src/server/collection/search.ts`, `searchCollected`): our own index of everything
  collected, full-text search in Postgres (GIN index `collected_items_search_idx`, migration `0039`)
  over each item's title (weighs most), company and text. Words as people type them (`react "web
  app" -wordpress`, `seo or "google ads"`), with filters for kind, service category, country and
  remote; closed items and copies of an item are left out unless asked for. Best match first,
  halved for each month since the item was posted, so a fresh match beats an old one; each hit
  carries its categories and the words around the match. Read-only; not yet used by either engine.
- **Workday** (source `workday_board`, `pending_review`, migration `0039`): not collected. Its careers
  sites allow their job pages in robots.txt, but Workday's Terms of Use forbid robots and
  applications on its Sites without written consent and don't say whether the careers sites are
  among them. Workday jobs a company's own careers page shows are still read by `career_pages`.
- **Targets from Overture Maps** (`npm run collect:overture`, `src/server/collection/overture-seed.ts`):
  US businesses with their own website in 30 of Overture's real `basic_category` values (tier 1:
  offices, professional, technical, financial, legal, design and media firms; tier 2: clinics,
  trades, industry and logistics). Platform and social sites (Wix, Squarespace, Facebook…),
  government sites and franchise-agent pages are not a business's own website; a chain's branches
  are one domain. Read offline with DuckDB from Overture's public bucket, a few map areas at a time;
  nothing of Overture is stored except each chosen domain as a target, with its place, release and
  attribution in `params.overture` (kept when the website moves). Seeded in batches (categories and
  areas taking turns) whose first runs are spread over hours. The existing Overture contact lookup
  (`scripts/overture.ts`) is unchanged.

  ```sh
  duckdb -c "$(npm run -s collect:overture -- sql places.json austin=-97.80,30.22,-97.68,30.34)"
  npm run collect:overture -- seed places.json --limit 300 --per-category 15 --spread-hours 24 [--dry-run]
  ```
- **Targets from Common Crawl** (`npm run collect:common-crawl`, `src/server/collection/common-crawl-seed.ts`):
  `.com` websites whose careers page (`/careers`, `/jobs`, `/join-us`, `/work-with-us`…) the crawl
  fetched in English, read offline with DuckDB from the URL index's Parquet files, a few at a time
  (~80 MB and ~2 min each; a crawl has 300, about half of them `.com`). Left out: job sites by name
  (`…job…`, `…careers…`, `…staffing…`, `…recruit…`), job hosts and blocked platforms, and families
  of template microsites (10+ sites sharing the start or end of their name with 85 %+ at exactly the
  same careers path: insurance agents' "/jobs" sites; companies that merely share a name's start
  vary their paths and are kept). A batch is spread over the whole extraction (hash order), its
  first runs over hours, behind YC's companies (priority -1), each starting at the careers page the
  crawl found. Only the domain, crawl and careers URL are kept (`params.commonCrawl`). Common
  Crawl's terms neither allow nor forbid commercial use outright; no page content is taken from it.

  ```sh
  npm run -s collect:common-crawl -- sql sites.json --files 150-152 > crawl.sql && duckdb < crawl.sql
  npm run collect:common-crawl -- seed sites.json --limit 500 --spread-hours 24 [--dry-run]
  ```
- **Jobs no longer current** (`currentJob`, every careers-page job): posts marked filled, closed or
  expired are left out; a site builder's copies ("… Copy 4", "(Copy)") count once under the post's
  title; on pages that give no dates, a date written in the place or facts is read ("Posted on 01 Dec
  2025" → older than 60 days, left out; "Closes on 30 May 2026" → a passed deadline, left out; a
  future deadline becomes the expiry). Checked on the pilot: the filled post, the 2021 posts and an
  Indian lender's expired post with its 5 copies are closed.

**Seed populations compared** (2026-11-18, Overture release 2026-10-21.0; same collector, 8 runs at
once, one request a second per site):

| | YC trial (US YC startups) | Overture pilot (5 metro cores) |
| --- | --- | --- |
| Pool | ~4,800 US YC companies | 18.4 M US places; 11.7 M with a website (confidence ≥ 0.7). Austin, Denver, Columbus, Boston, Charlotte cores: 107,978 → 45,894 in seeded categories → 33,264 unique domains |
| Companies collected | 141 | 315 (300 seeded + 15 whose website moved) |
| Careers page found | 95 (67 %), 30 of them on a job board the Company Discovery Engine reads | 103 (33 %), 3 on a job board (none of them in its directory yet) |
| Companies with readable jobs | 19 (13.5 %) | 9 (2.9 %) |
| Unique open jobs | 132 (≈ 94 per 100 companies) | 35 valid (≈ 11 per 100); 10 US, 10 elsewhere, 16 unknown |
| Jobs the existing ATS integration covers | 140 open, on 26 of the 30 boards skipped | 0 (3 boards, not yet discovered there) |
| Failed runs | 5 % | 25 %: 24 bot-blocked (403), 17 timeouts, 16 refused/TLS, 16 dead domains (DNS), 2 rate-limited (429), 1 robots.txt |
| Requests | 885 over 323 runs | 988 over 408 runs (2.0–2.3 per company); first pass of 300 took 243 s |
| Accuracy (manual review) | 30/30 sampled jobs real, title on its source page | 36/36 titles on their source page; 35 real jobs, 1 careers-area page (from before the area rule; closes on its next complete run) |

**Common Crawl pilot** (2026-11-19, crawl CC-MAIN-2026-43, offline with DuckDB, before the seeder
and the current-job rules below): 3 of the URL index's 300 files (≈ 80 MB read each, ~7 min) gave 4,331 English `.com` sites
with a careers page at `/careers`, `/jobs`, `/join-us`… (≈ 13 % insurance agents' template
microsites). 300 random others, run by the same collector: careers page found 187 (62 %), readable
jobs at 15 (5.0 %), 84 unique open jobs (≈ 28 per 100 companies; 24 US, 11 elsewhere, 19 fitting a
service category), 20 % failed (mostly connection failures), 660 requests in 243 s. About 1 in 8
jobs was not a current job (copies of one post, "POSITION FILLED", 2021 posts on undated pages, a
job board's listings). Between Overture (2.9 % with jobs) and YC (13.5 %), and the whole crawl
would give well over 100,000 such sites.

Findings: YC startups give 8× more jobs per company: they hire and publish open roles. Overture's
local businesses are a much larger pool but mostly have no careers page or list no jobs, a quarter
of their websites block or fail, and their few job-rich sites are larger firms (architecture,
manufacturing, outpatient care, rentals). Per category, manufacturers, outpatient care, design
firms and corporate offices yielded jobs; financial, legal, technical and b2b services, dental and
real estate yielded none in the pilot. Overture is better used as a broad, cheap pool for the
categories that yielded, and for the companies' own websites, than as a primary job source.

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
| `npm run overture -- targets / sql / load …` | Look our companies up in Overture Maps (see Overture Maps above) |
| `npm run yc -- import` | Load (or refresh) every Y Combinator company into `yc_companies` |
| `npm run collect:overture -- sql / seed …` | Careers-page targets from Overture Maps places (see Targets from Overture Maps above) |
| `npm run collect:common-crawl -- sql / seed …` | Careers-page targets from Common Crawl's URL index (see Targets from Common Crawl above) |

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
