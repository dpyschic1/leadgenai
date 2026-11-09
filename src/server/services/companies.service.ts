import "server-only";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { isForeignKeyViolation, isUniqueViolation } from "@/db/errors";
import { auditLogs, companies, companyLocations, companyPeople, opportunities } from "@/db/schema";
import type { CompanyDetail, CompanySummary } from "@/lib/api/types";
import type { SourceSlug } from "@/lib/domain/sources";
import type { CompanyValues } from "@/lib/validation/companies";
import { FIRST_PAGE, offsetOf, type Page, type Pagination } from "@/lib/validation/pagination";
import type { AuthContext } from "@/server/auth/session";
import { AppError } from "@/server/http/errors";
import { deleteOrphanedPeople, listCompanyPeople } from "./people.service";

const headquartersOf = (companyId: string | typeof companies.id) =>
  and(eq(companyLocations.companyId, companyId), eq(companyLocations.type, "headquarters"));

/** One page of the workspace's companies, A to Z (code-like names last), optionally narrowed by name or domain. */
export async function listCompanies(auth: AuthContext, search?: string, page: Pagination = FIRST_PAGE): Promise<Page<CompanySummary>> {
  const pattern = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const matches = and(
    eq(companies.workspaceId, auth.workspaceId),
    pattern ? or(ilike(companies.canonicalName, pattern), ilike(companies.domain, pattern)) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        company: companies,
        hqCity: companyLocations.city,
        hqCountry: companyLocations.country,
        hqId: companyLocations.id,
        peopleCount: db.$count(companyPeople, eq(companyPeople.companyId, companies.id)),
      })
      .from(companies)
      .leftJoin(companyLocations, headquartersOf(companies.id))
      .where(matches)
      // Real names first: a first word of letters ("Smile Dental", "O'Neill & Co") before code-like
      // names ("00567 LTD", "A134 LTD"); each group A to Z. The id breaks ties between same-named
      // companies, so pages never repeat or skip a row.
      .orderBy(
        sql`${companies.canonicalName} !~ '^[[:alpha:]][[:alpha:]''&.-]*([[:space:]]|$)'`,
        sql`lower(${companies.canonicalName})`,
        asc(companies.id),
      )
      .limit(page.pageSize)
      .offset(offsetOf(page)),
    db.select({ total: sql<number>`count(*)::int` }).from(companies).where(matches),
  ]);

  const items = rows.map(({ company, hqCity, hqCountry, hqId, peopleCount }) => ({
    id: company.id,
    name: company.canonicalName,
    domain: company.domain,
    industry: company.industry,
    employeeCount: company.employeeCount,
    headquarters: hqId ? { city: hqCity, country: hqCountry } : null,
    peopleCount,
    discoveredBy: (company.sourceSlug as SourceSlug | null) ?? null,
  }));
  return { items, total, ...page };
}

export async function getCompany(auth: AuthContext, companyId: string): Promise<CompanyDetail> {
  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!company) throw notFound();

  const [locations, companyPeopleRows, [opportunity]] = await Promise.all([
    db
      .select()
      .from(companyLocations)
      .where(eq(companyLocations.companyId, company.id))
      .orderBy(asc(companyLocations.createdAt)),
    listCompanyPeople(auth, company.id),
    db
      .select({ id: opportunities.id, score: opportunities.opportunityScore, status: opportunities.status, scoreFactors: opportunities.scoreFactors })
      .from(opportunities)
      .where(eq(opportunities.companyId, company.id))
      .limit(1),
  ]);

  return {
    id: company.id,
    name: company.canonicalName,
    domain: company.domain,
    industry: company.industry,
    employeeCount: company.employeeCount,
    description: company.description,
    discoveredBy: (company.sourceSlug as SourceSlug | null) ?? null,
    identityStatus: company.identityStatus,
    locations: locations.map((l) => ({
      id: l.id,
      type: l.type,
      address: l.address,
      city: l.city,
      region: l.region,
      country: l.country,
      postalCode: l.postalCode,
    })),
    people: companyPeopleRows,
    // A row without factors has lost its last positive signal and is no longer scored.
    opportunity: opportunity
      ? { id: opportunity.id, score: "intent" in opportunity.scoreFactors ? opportunity.score : null, status: opportunity.status }
      : null,
  };
}

export async function createCompany(auth: AuthContext, input: CompanyValues): Promise<CompanyDetail> {
  const id = await translateErrors(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(companies)
        .values({ workspaceId: auth.workspaceId, ...companyColumns(input) })
        .returning({ id: companies.id });
      await saveHeadquarters(tx, row.id, input);
      await audit(tx, auth, "company.created", row.id);
      return row.id;
    }),
  );
  return getCompany(auth, id);
}

export async function updateCompany(
  auth: AuthContext,
  companyId: string,
  input: CompanyValues,
): Promise<CompanyDetail> {
  await translateErrors(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(companies)
        .set(companyColumns(input))
        .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
        .returning({ id: companies.id });
      if (!row) throw notFound();
      await saveHeadquarters(tx, row.id, input);
      await audit(tx, auth, "company.updated", row.id);
    }),
  );
  return getCompany(auth, companyId);
}

/**
 * Deletes the company with its locations, signals and opportunities (FK cascades), and the people
 * who were linked only to this company.
 */
export async function deleteCompany(auth: AuthContext, companyId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const linked = await tx
      .select({ personId: companyPeople.personId })
      .from(companyPeople)
      .where(and(eq(companyPeople.companyId, companyId), eq(companyPeople.workspaceId, auth.workspaceId)));

    const [row] = await tx
      .delete(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, auth.workspaceId)))
      .returning({ id: companies.id });
    if (!row) throw notFound();

    await deleteOrphanedPeople(tx, linked.map((l) => l.personId));
    await audit(tx, auth, "company.deleted", row.id);
  });
}

function companyColumns(input: CompanyValues) {
  return {
    canonicalName: input.name,
    domain: input.domain,
    industry: input.industry,
    employeeCount: input.employeeCount,
    description: input.description,
  };
}

/** The headquarters is one row in company_locations; empty HQ fields remove it. */
async function saveHeadquarters(tx: Tx, companyId: string, input: CompanyValues): Promise<void> {
  const hq = { city: input.hqCity, region: input.hqRegion, country: input.hqCountry };
  const hasHq = Object.values(hq).some((value) => value !== null);

  const [existing] = await tx
    .select({ id: companyLocations.id })
    .from(companyLocations)
    .where(headquartersOf(companyId))
    .limit(1);

  if (existing && hasHq) await tx.update(companyLocations).set(hq).where(eq(companyLocations.id, existing.id));
  else if (existing) await tx.delete(companyLocations).where(eq(companyLocations.id, existing.id));
  else if (hasHq) await tx.insert(companyLocations).values({ companyId, type: "headquarters", ...hq });
}

async function audit(tx: Tx, auth: AuthContext, action: string, companyId: string): Promise<void> {
  await tx.insert(auditLogs).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    action,
    entityType: "company",
    entityId: companyId,
  });
}

async function translateErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error, "companies_workspace_domain_idx")) {
      const message = "A company with this domain is already in your workspace.";
      throw new AppError("ALREADY_EXISTS", message, { domain: [message] });
    }
    if (isForeignKeyViolation(error)) {
      throw new AppError("VALIDATION_FAILED", "The selected industry no longer exists. Refresh and try again.");
    }
    throw error;
  }
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Company not found.");
}
