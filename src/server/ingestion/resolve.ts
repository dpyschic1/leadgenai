import "server-only";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { db, Tx } from "@/db";
import {
  auditLogs,
  companies,
  companyContactPoints,
  companyIdentifiers,
  companyLocations,
  companyPeople,
  contactPoints,
  people,
  sourceRecords,
} from "@/db/schema";
import { identityColumns } from "@/lib/domain/people";
import type { CompanyIdScheme, SourceSlug } from "@/lib/domain/sources";
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
/** "LS1 4AP" and "ls14ap" compare equal. */
export const normalizePostcode = (postcode: string | null | undefined) => postcode?.replace(/\s+/g, "").toUpperCase() || null;

type Match = { companyId: string | null; ambiguousWith: string[] };

/**
 * The existing company a found one refers to, in order of strength: a registry number, then the
 * website domain, then the same source's own earlier record of it (re-reading a source never
 * duplicates). A name only counts together with the same postcode, and only when exactly one
 * company fits; several fits are ambiguous and nothing is merged.
 */
async function matchCompany(tx: Tx, workspaceId: string, found: FoundCompany): Promise<Match> {
  const none = { companyId: null, ambiguousWith: [] };
  for (const identifier of found.identifiers) {
    const [hit] = await tx
      .select({ companyId: companyIdentifiers.companyId })
      .from(companyIdentifiers)
      .where(and(eq(companyIdentifiers.workspaceId, workspaceId), eq(companyIdentifiers.scheme, identifier.scheme), eq(companyIdentifiers.value, identifier.value)))
      .limit(1);
    if (hit) return { ...none, companyId: hit.companyId };
  }
  if (found.domain) {
    const [hit] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.domain, found.domain)))
      .limit(1);
    if (hit) return { ...none, companyId: hit.id };
  }

  const sameName = and(eq(companies.workspaceId, workspaceId), sql`lower(${companies.canonicalName}) = lower(${found.name})`);
  // The same source's own earlier record of this name (e.g. a buyer seen in a previous tender).
  const [own] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(sameName, eq(companies.sourceSlug, found.record.sourceSlug)))
    .limit(2);
  if (own && found.identifiers.length === 0) return { ...none, companyId: own.id };

  const postcode = normalizePostcode(found.hq?.postalCode);
  if (!postcode) return none;
  const candidates = await tx
    .selectDistinct({ id: companies.id })
    .from(companies)
    .innerJoin(companyLocations, eq(companyLocations.companyId, companies.id))
    .where(and(sameName, sql`upper(replace(${companyLocations.postalCode}, ' ', '')) = ${postcode}`));
  if (candidates.length === 1) return { ...none, companyId: candidates[0].id };
  return { companyId: null, ambiguousWith: candidates.map((c) => c.id) };
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

  const match = await matchCompany(tx, actor.workspaceId, found);
  let companyId = match.companyId;
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
        // A registry number identifies the business; anything else starts provisional.
        identityStatus: found.identity ?? (found.identifiers.length > 0 ? "verified" : "provisional"),
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
  // A name that fit several companies is kept on the record, so a person can merge later.
  const ref = match.ambiguousWith.length > 0 ? { ...found.record, data: { ...found.record.data, ambiguousWith: match.ambiguousWith } } : found.record;
  const record = await saveSourceRecord(tx, actor.workspaceId, ref, companyId);
  return { companyId, created, recordId: record.id };
}

/**
 * Adds the people a source found at the company and returns how many were new. A person the same
 * source already gave us is not added again (re-reading is idempotent), but people are never merged
 * across sources on name alone: the same name from another source is kept as its own record.
 */
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
    .where(and(eq(companyPeople.companyId, companyId), eq(companyPeople.workspaceId, actor.workspaceId), eq(companyPeople.sourceSlug, sourceSlug)));
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
    // Published by the register for this person: shown as published, never as verified.
    if (person.phone) {
      await tx.insert(contactPoints).values({ personId: row.id, type: "phone", value: person.phone, isPrimary: true, source: sourceSlug }).onConflictDoNothing();
    }
    if (person.email) {
      await tx.insert(contactPoints).values({ personId: row.id, type: "email", value: person.email, isPrimary: true, source: sourceSlug }).onConflictDoNothing();
    }
    added++;
  }
  return added;
}

/**
 * Saves the sites a source lists for a company (e.g. each of a CQC provider's practices) as their
 * own locations, keyed by the source's id, so re-reading updates them instead of adding copies.
 */
export async function saveSourceLocations(
  tx: Tx,
  companyId: string,
  sourceSlug: SourceSlug,
  sites: { externalId: string; name: string; address: string | null; city: string | null; region: string | null; postalCode: string | null; website: string | null; phone: string | null }[],
  country = "GB",
): Promise<void> {
  for (const site of sites) {
    const values = { name: site.name, address: site.address, city: site.city, region: site.region, postalCode: site.postalCode, website: site.website, phone: site.phone };
    await tx
      .insert(companyLocations)
      .values({ companyId, type: "branch", country, sourceSlug, externalId: site.externalId, ...values })
      .onConflictDoUpdate({
        target: [companyLocations.companyId, companyLocations.sourceSlug, companyLocations.externalId],
        targetWhere: sql`${companyLocations.externalId} is not null`,
        set: values,
      });
  }
}

/**
 * Records what one source currently publishes as the company's email/phone (switchboard, info@),
 * replacing what it published before: an address the source no longer shows is removed. A type
 * the read found nothing of is left alone, so a contact page that failed to load once doesn't
 * wipe the company's numbers. Other sources' contacts are never touched.
 */
export async function replaceCompanyContacts(
  tx: Tx,
  companyId: string,
  contacts: { emails: string[]; phones: string[] },
  source: { slug: SourceSlug; url: string | null },
): Promise<void> {
  for (const [type, values] of [["email", contacts.emails], ["phone", contacts.phones]] as const) {
    if (values.length === 0) continue;
    await tx
      .delete(companyContactPoints)
      .where(
        and(
          eq(companyContactPoints.companyId, companyId),
          eq(companyContactPoints.sourceSlug, source.slug),
          eq(companyContactPoints.type, type),
          notInArray(companyContactPoints.value, [...values]),
        ),
      );
  }
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

/** Known registry numbers of one scheme in the workspace, so discovery only returns new companies. */
export async function knownIdentifiers(tx: Tx | typeof db, workspaceId: string, scheme: CompanyIdScheme = "gb_company_number"): Promise<Set<string>> {
  const rows = await tx
    .select({ value: companyIdentifiers.value })
    .from(companyIdentifiers)
    .where(and(eq(companyIdentifiers.workspaceId, workspaceId), inArray(companyIdentifiers.scheme, [scheme])));
  return new Set(rows.map((r) => r.value));
}
