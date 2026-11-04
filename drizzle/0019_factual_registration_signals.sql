-- Registration signals state only what the register says ("registered at Companies House on
-- 12 October 2026"), as the "Company formation" type. The old wording added a guess ("a new
-- business that may need help to get started") that the register doesn't support.
UPDATE "signals"
SET "signal_type" = 'company_formation',
    "summary" = regexp_replace("summary", ': a new business that may need help to get started\.$', '.')
WHERE "signal_type" = 'new_startup' AND "source" = 'provider';
