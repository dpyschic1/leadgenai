import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { db, Tx } from "@/db";
import {
  auditLogs,
  companies,
  companyContactPoints,
  companyIdentifiers,
  companyLocations,
  companyPeople,
  people,
  sourceRecords,
} from "@/db/schema";
import { identityColumns } from "@/lib/domain/people";
import type { SourceSlug } from "@/lib/domain/sources";
import type { Actor } from "@/server/auth/actor";
import type { FoundCompany, FoundPerson, SourceRef } from "@/server/sources";

/**
 * Entity resolution (FR-ENT-001..003): a found company is matched to an existing one by registry
 * number, then website domain, then exact name; otherwise it is created. People are matched by
 * name within the company. Every stored fact keeps its source (provenance, PRD §13).
 */

/** Saves (or refreshes) a source record; `changed` is false when its content hash is unchanged. */
export async function saveSourceRecord(
  tx: Tx,
  workspaceId: string,
  ref: SourceRef,
  companyId: string | null,
): Promise<{ id: string; changed: boolean; isNew: boolean }> {
  const [previous] = await tx
    .select({ id: sourceRecords.id, contentHash: sourceRecords.contentHash })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.workspaceId, workspaceId), eq(sourceRecords.sourceSlug, ref.sourceSlug), eq(sourceRecords.externalId, ref.externalId)))
    .limit(1);

  const values = {
    url: ref.url,
    recordType: ref.recordType,
    publishedAt: ref.publishedAt,
    contentHash: ref.contentHash ?? null,
    data: ref.data,
    companyId,
    observedAt: new Date(),
  };
  if (previous) {
    await tx.update(sourceRecords).set(values).where(eq(sourceRecords.id, previous.id));
    const changed = !ref.contentHash || previous.contentHash !== ref.contentHash;
    return { id: previous.id, changed, isNew: false };
  }
  const [row] = await tx
    .insert(sourceRecords)
    .values({ workspaceId, sourceSlug: ref.sourceSlug, externalId: ref.externalId, ...values })
    .returning({ id: sourceRecords.id });
  return { id: row.id, changed: true, isNew: true };
}

/** The existing company a found one refers to, if any. */
async function matchCompany(tx: Tx, workspaceId: string, found: FoundCompany): Promise<string | null> {
  for (const identifier of found.identifiers) {
    const [hit] = await tx
      .select({ companyId: companyIdentifiers.companyId })
      .from(companyIdentifiers)
      .where(and(eq(companyIdentifiers.workspaceId, workspaceId), eq(companyIdentifiers.scheme, identifier.scheme), eq(companyIdentifiers.value, identifier.value)))
      .limit(1);
    if (hit) return hit.companyId;
  }
  if (found.domain) {
    const [hit] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.domain, found.domain)))
      .limit(1);
    if (hit) return hit.id;
  }
  const [hit] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), sql`lower(${companies.canonicalName}) = lower(${found.name})`))
    .limit(1);
  return hit?.id ?? null;
}

/**
 * Finds or creates the company, attaches its identifiers and source record. An existing company's
 * details entered by a person are never overwritten; only empty fields are filled in.
 */
export async function resolveCompany(
  tx: Tx,
  actor: Actor,
  found: FoundCompany,
): Promise<{ companyId: string; created: boolean; recordId: string }> {
  // Serialise resolution per workspace + name, so two jobs can't create the same company twice.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`resolve:${actor.workspaceId}:${found.name.toLowerCase()}`}))`);

  let companyId = await matchCompany(tx, actor.workspaceId, found);
  const created = companyId === null;

  if (companyId === null) {
    const [row] = await tx
      .insert(companies)
      .values({
        workspaceId: actor.workspaceId,
        canonicalName: found.name,
        domain: found.domain,
        industry: found.industry,
        sourceSlug: found.record.sourceSlug,
        discoveredAt: new Date(),
      })
      .returning({ id: companies.id });
    companyId = row.id;
    if (found.hq && (found.hq.city || found.hq.region || found.hq.country)) {
      await tx.insert(companyLocations).values({ companyId, type: "headquarters", ...found.hq });
    }
    await tx.insert(auditLogs).values({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "company.discovered",
      entityType: "company",
      entityId: companyId,
      metadata: { source: found.record.sourceSlug, externalId: found.record.externalId },
    });
  } else if (found.industry) {
    await tx
      .update(companies)
      .set({ industry: found.industry })
      .where(and(eq(companies.id, companyId), isNull(companies.industry)));
  }

  for (const identifier of found.identifiers) {
    await tx
      .insert(companyIdentifiers)
      .values({ workspaceId: actor.workspaceId, companyId, ...identifier })
      .onConflictDoNothing();
  }
  const record = await saveSourceRecord(tx, actor.workspaceId, found.record, companyId);
  return { companyId, created, recordId: record.id };
}

/** Adds the people a source found at the company; existing people (same name) only gain a source. Returns how many were new. */
export async function addFoundPeople(
  tx: Tx,
  actor: Actor,
  companyId: string,
  found: FoundPerson[],
  sourceSlug: SourceSlug,
): Promise<number> {
  if (found.length === 0) return 0;
  const existing = await tx
    .select({ personId: companyPeople.personId, name: people.name })
    .from(companyPeople)
    .innerJoin(people, eq(people.id, companyPeople.personId))
    .where(and(eq(companyPeople.companyId, companyId), eq(companyPeople.workspaceId, actor.workspaceId)));
  const known = new Set(existing.map((p) => p.name.toLowerCase()));

  let added = 0;
  for (const person of found) {
    if (known.has(person.name.toLowerCase())) continue;
    known.add(person.name.toLowerCase());
    // Found people are "likely": a person still confirms them before treating them as certain.
    const [row] = await tx
      .insert(people)
      .values({ workspaceId: actor.workspaceId, name: person.name, ...identityColumns(person.confidence >= 80 ? "likely" : "unsure") })
      .returning({ id: people.id });
    await tx.insert(companyPeople).values({
      workspaceId: actor.workspaceId,
      companyId,
      personId: row.id,
      title: person.title,
      seniority: person.seniority,
      jobFunction: person.jobFunction,
      relationship: person.relationship,
      confidence: person.confidence,
      sourceSlug,
      observedAt: new Date(),
    });
    added++;
  }
  return added;
}

/** Records the company's published email/phone (switchboard, info@). */
export async function addCompanyContacts(
  tx: Tx,
  companyId: string,
  contacts: { emails: string[]; phones: string[] },
  source: { slug: SourceSlug; url: string | null },
): Promise<void> {
  const rows = [
    ...contacts.emails.map((value) => ({ type: "email" as const, value })),
    ...contacts.phones.map((value) => ({ type: "phone" as const, value })),
  ];
  if (rows.length === 0) return;
  await tx
    .insert(companyContactPoints)
    .values(rows.map((r) => ({ companyId, ...r, sourceSlug: source.slug, sourceUrl: source.url })))
    .onConflictDoUpdate({
      target: [companyContactPoints.companyId, companyContactPoints.type, companyContactPoints.value],
      set: { observedAt: new Date() },
    });
}

/** Known registry numbers in the workspace, so discovery only returns new companies. */
export async function knownIdentifiers(tx: Tx | typeof db, workspaceId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ value: companyIdentifiers.value })
    .from(companyIdentifiers)
    .where(and(eq(companyIdentifiers.workspaceId, workspaceId), inArray(companyIdentifiers.scheme, ["gb_company_number"])));
  return new Set(rows.map((r) => r.value));
}
