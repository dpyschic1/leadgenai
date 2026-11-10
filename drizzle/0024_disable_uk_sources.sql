-- Product focus moved to US companies (2026-11-10): the UK-only sources stop running for every
-- workspace. Their code and the data they already found stay; to switch one back on, set its
-- authorization_status to 'approved' again.
UPDATE "sources" SET "authorization_status" = 'disabled',
  "notes" = coalesce("notes", '') || ' Switched off on 2026-11-10: product focus on US companies.'
WHERE "slug" IN ('companies_house', 'cqc', 'uk_tenders', 'openstreetmap') AND "authorization_status" = 'approved';
