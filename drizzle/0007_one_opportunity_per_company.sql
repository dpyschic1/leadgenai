DROP INDEX "opportunities_company_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_company_uq" ON "opportunities" USING btree ("company_id");