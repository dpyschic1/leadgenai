-- Hand-written: the Web Scraping & Discovery Engine's collected jobs become a data source of Company
-- Discovery (2026-11-19), so each workspace can switch it off in its Data sources settings.
INSERT INTO "sources" ("slug", "name", "type", "authorization_status", "terms_url", "notes") VALUES
  ('web_collection', 'Own web collection', 'job_page', 'approved', NULL, 'Jobs collected by our own Web Scraping & Discovery Engine (src/server/collection): companies'' own careers pages, Gem and Rippling boards and Hacker News''s monthly hiring thread, each under its own collector source row and its terms review. Matched to a workspace''s services and countries by evaluate_boards (matchCollectedJobs), by the company''s own website domain. Only stated facts become rule-based signals; nothing is bought.')
ON CONFLICT ("slug") DO NOTHING;
