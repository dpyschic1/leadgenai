/**
 * Demo workspace for showing the product: the three MVP workflows from the Product Specification
 * (§13.1: website / digital, staff augmentation, startup / MVP) with realistic, fictional data.
 *
 *   npm run db:seed:demo
 *
 * Everything goes through the app's own services, so it's validated and scored exactly like real
 * use. Re-running replaces the demo workspace and leaves every other workspace alone. All
 * companies, people and links are made up (`.example` domains).
 */
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { users, workspaceMembers, workspaces } from "@/db/schema";
import { companySchema, personSchema } from "@/lib/validation/companies";
import { feedbackSchema } from "@/lib/validation/feedback";
import { listSchema } from "@/lib/validation/lists";
import { opportunityListQuerySchema } from "@/lib/validation/opportunities";
import { serviceSchema } from "@/lib/validation/services";
import { signalSchema } from "@/lib/validation/signals";
import type { AuthContext } from "@/server/auth/session";
import { rescoreCompany } from "@/server/scoring/rescore";
import { registerOwner } from "@/server/services/auth.service";
import { createCompany } from "@/server/services/companies.service";
import { giveFeedback } from "@/server/services/feedback.service";
import { addToList, createList } from "@/server/services/lists.service";
import { listOpportunities, updateOpportunity } from "@/server/services/opportunities.service";
import { addPerson, listCompanyPeople } from "@/server/services/people.service";
import { createService } from "@/server/services/services.service";
import { createSignal } from "@/server/services/signals.service";

export const DEMO_OWNER = { name: "Alex Morgan", email: "demo@leadgenai.example", password: "Demo@12345" };
const DEMO_TEAMMATE = { name: "Priya Shah", email: "priya@leadgenai.example", password: "Demo@12345" };
const DEMO_WORKSPACE = "Northwind Digital (demo)";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// What the demo agency sells
// ---------------------------------------------------------------------------

const SERVICES = [
  {
    name: "Website redesign & SEO",
    description: "Modern, mobile-first websites with booking and local SEO for professional services.",
    categories: ["web_development", "ui_ux_design", "seo"],
    targetIndustries: ["legal", "accounting", "dental", "healthcare", "professional_services"],
    targetJobFunctions: ["marketing", "founder_executive"],
    targetCountries: ["GB", "IE"],
    companySizeMin: 5,
    companySizeMax: 250,
  },
  {
    name: "Dedicated developers",
    description: "Senior React, Node and QA engineers who join your team within two weeks.",
    categories: ["staff_augmentation", "software_development", "qa_testing"],
    targetIndustries: ["saas", "financial_services", "logistics", "ecommerce"],
    targetJobFunctions: ["engineering", "founder_executive"],
    targetCountries: ["GB", "US", "DE", "NL"],
    companySizeMin: 20,
    companySizeMax: 1000,
  },
  {
    name: "MVP development",
    description: "From idea to launched product in 12 weeks: discovery, design, build and launch.",
    categories: ["mvp_development", "mobile_development", "software_development"],
    targetIndustries: [],
    targetJobFunctions: ["founder_executive", "product"],
    targetCountries: [],
    companySizeMin: 1,
    companySizeMax: 50,
  },
] as const;

// ---------------------------------------------------------------------------
// The companies being watched, by workflow
// ---------------------------------------------------------------------------

type DemoPerson = {
  name: string;
  title: string;
  seniority: "owner" | "c_level" | "vp" | "director" | "manager" | "senior";
  jobFunction: string;
  relationship?: "employee" | "founder";
  identity?: "confirmed" | "likely" | "unsure";
  email?: string;
  emailVerification?: "unknown" | "valid" | "invalid";
  phone?: string;
};

type DemoSignal = {
  signalType: string;
  intentLevel: "explicit" | "high" | "medium" | "low";
  urgency: "high" | "medium" | "low" | "unknown";
  serviceCategories: string[];
  summary: string;
  excerpt: string;
  daysAgo: number;
  /** Index into the company's people: the person behind the signal. */
  person?: number;
};

type DemoCompany = {
  name: string;
  domain: string;
  industry: string;
  employees: number;
  city: string;
  country: string;
  description: string;
  people: DemoPerson[];
  signals: DemoSignal[];
};

const COMPANIES: DemoCompany[] = [
  // Workflow A: website / digital
  {
    name: "Harbourside Legal LLP",
    domain: "harbourside-legal.example",
    industry: "legal",
    employees: 62,
    city: "Bristol",
    country: "GB",
    description: "Family and property law firm with three offices in the South West.",
    people: [
      { name: "Eleanor Price", title: "Marketing Manager", seniority: "manager", jobFunction: "marketing", identity: "confirmed", email: "eleanor.price@harbourside-legal.example", emailVerification: "valid", phone: "+44 117 496 0321" },
      { name: "David Okafor", title: "Managing Partner", seniority: "owner", jobFunction: "founder_executive", identity: "likely", email: "d.okafor@harbourside-legal.example" },
    ],
    signals: [
      {
        signalType: "vendor_search",
        intentLevel: "explicit",
        urgency: "high",
        serviceCategories: ["web_development", "ui_ux_design", "seo"],
        summary: "Harbourside Legal is looking for an agency to rebuild its outdated website with online consultation booking before its new Exeter office opens in January.",
        excerpt: "We're looking for a web agency to rebuild our website and add online consultation booking ahead of our Exeter office opening in January.",
        daysAgo: 2,
        person: 0,
      },
      {
        signalType: "new_location",
        intentLevel: "medium",
        urgency: "medium",
        serviceCategories: ["web_development", "seo"],
        summary: "Opening a third office in Exeter, which needs location pages and local search presence.",
        excerpt: "Harbourside Legal will open its third office, in Exeter, in January.",
        daysAgo: 9,
      },
    ],
  },
  {
    name: "BrightSmile Dental Group",
    domain: "brightsmile-dental.example",
    industry: "dental",
    employees: 140,
    city: "Leeds",
    country: "GB",
    description: "Group of nine dental practices across Yorkshire.",
    people: [
      { name: "Sophie Clarke", title: "Head of Patient Experience", seniority: "director", jobFunction: "operations", identity: "confirmed", email: "sophie.clarke@brightsmile-dental.example" },
    ],
    signals: [
      {
        signalType: "website_conversion_problem",
        intentLevel: "medium",
        urgency: "medium",
        serviceCategories: ["web_development", "ui_ux_design"],
        summary: "Patients complain that booking online is confusing and doesn't work on mobile; the group says it is reviewing options for a new site this quarter.",
        excerpt: "Online booking has been the top complaint in our patient survey, and we're reviewing options for a new website this quarter.",
        daysAgo: 6,
        person: 0,
      },
    ],
  },
  {
    name: "Calder & Co Accountants",
    domain: "calder-accountants.example",
    industry: "accounting",
    employees: 28,
    city: "Manchester",
    country: "GB",
    description: "Accountancy practice for owner-managed businesses.",
    people: [
      { name: "Martin Calder", title: "Founding Partner", seniority: "owner", jobFunction: "founder_executive", relationship: "founder", identity: "confirmed" },
    ],
    signals: [
      {
        signalType: "rebrand",
        intentLevel: "low",
        urgency: "low",
        serviceCategories: ["web_development"],
        summary: "Announced a rebrand next year after merging with a smaller practice; no website plans mentioned yet.",
        excerpt: "Following the merger, the combined practice will trade under a new name from next spring.",
        daysAgo: 35,
      },
    ],
  },
  // Workflow B: staff augmentation
  {
    name: "Ledgerline Payments",
    domain: "ledgerline.example",
    industry: "financial_services",
    employees: 230,
    city: "London",
    country: "GB",
    description: "B2B payments platform for mid-sized merchants.",
    people: [
      { name: "Rahul Mehta", title: "VP Engineering", seniority: "vp", jobFunction: "engineering", identity: "confirmed", email: "rahul.mehta@ledgerline.example", emailVerification: "valid" },
      { name: "Hannah Lee", title: "Talent Partner", seniority: "manager", jobFunction: "human_resources", identity: "likely", email: "hannah.lee@ledgerline.example" },
    ],
    signals: [
      {
        signalType: "engineering_hiring",
        intentLevel: "high",
        urgency: "high",
        serviceCategories: ["staff_augmentation", "software_development"],
        summary: "Hiring eight senior React and Node engineers at once to deliver a new merchant dashboard by the end of Q1.",
        excerpt: "We're hiring 8 senior React and Node engineers to deliver our new merchant dashboard by the end of Q1.",
        daysAgo: 4,
        person: 0,
      },
      {
        signalType: "long_running_vacancy",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["staff_augmentation", "qa_testing"],
        summary: "A Senior QA Engineer role has been open for over three months and was reposted this week.",
        excerpt: "Senior QA Engineer (reposted): we've been looking for the right person since the summer.",
        daysAgo: 12,
      },
    ],
  },
  {
    name: "Freightly",
    domain: "freightly.example",
    industry: "logistics",
    employees: 410,
    city: "Rotterdam",
    country: "NL",
    description: "Digital freight forwarding for European shippers.",
    people: [
      { name: "Jeroen de Vries", title: "CTO", seniority: "c_level", jobFunction: "engineering", identity: "likely", email: "jeroen@freightly.example" },
    ],
    signals: [
      {
        signalType: "contractor_hiring",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["staff_augmentation"],
        summary: "Looking for contract developers for six months to migrate their booking platform to the cloud.",
        excerpt: "We're looking for contract backend developers for a six-month cloud migration of our booking platform.",
        daysAgo: 8,
        person: 0,
      },
    ],
  },
  {
    name: "Quillstack",
    domain: "quillstack.example",
    industry: "saas",
    employees: 95,
    city: "Berlin",
    country: "DE",
    description: "Document automation software for legal teams.",
    people: [
      { name: "Lena Fischer", title: "Head of Engineering", seniority: "director", jobFunction: "engineering", identity: "unsure", email: "lena.fischer@quillstack.example", emailVerification: "invalid" },
    ],
    signals: [
      {
        signalType: "engineering_hiring",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["staff_augmentation", "software_development"],
        summary: "Advertised four backend engineering roles last month.",
        excerpt: "Join our backend team: four new engineering roles in Berlin.",
        daysAgo: 30,
      },
      {
        signalType: "hiring_freeze",
        intentLevel: "low",
        urgency: "unknown",
        serviceCategories: [],
        summary: "Announced a hiring freeze for the rest of the year after a funding round fell through.",
        excerpt: "We are pausing all new hiring for the rest of the year.",
        daysAgo: 3,
      },
    ],
  },
  // Workflow C: startup / MVP
  {
    name: "Medora Health",
    domain: "medora-health.example",
    industry: "healthcare",
    employees: 12,
    city: "Austin",
    country: "US",
    description: "Seed-stage startup building appointment reminders for independent clinics.",
    people: [
      { name: "Maya Brooks", title: "Co-founder & CEO", seniority: "c_level", jobFunction: "founder_executive", relationship: "founder", identity: "confirmed", email: "maya@medora-health.example", emailVerification: "valid", phone: "+1 512 555 0144" },
    ],
    signals: [
      {
        signalType: "funding",
        intentLevel: "high",
        urgency: "medium",
        serviceCategories: ["mvp_development", "mobile_development"],
        summary: "Raised a $2.4M seed round to build the first version of its patient reminders app, launching in six months.",
        excerpt: "Medora Health raised $2.4M in seed funding to build the first version of its reminders app, with a launch planned within six months.",
        daysAgo: 5,
        person: 0,
      },
      {
        signalType: "development_partner_request",
        intentLevel: "explicit",
        urgency: "high",
        serviceCategories: ["mvp_development", "mobile_development"],
        summary: "The CEO asked publicly for recommendations for a development partner to build their MVP.",
        excerpt: "Looking for recommendations: a development partner who can take us from designs to an MVP on iOS and Android.",
        daysAgo: 3,
        person: 0,
      },
    ],
  },
  {
    name: "Tidepool Robotics",
    domain: "tidepool-robotics.example",
    industry: "manufacturing",
    employees: 6,
    city: "Glasgow",
    country: "GB",
    description: "Newly founded startup making inspection drones for offshore wind farms.",
    people: [
      { name: "Callum Reid", title: "Founder", seniority: "owner", jobFunction: "founder_executive", relationship: "founder", identity: "likely" },
    ],
    signals: [
      {
        signalType: "new_startup",
        intentLevel: "medium",
        urgency: "low",
        serviceCategories: ["mvp_development", "software_development"],
        summary: "A new startup preparing a prototype of its fleet-monitoring software for a pilot next year.",
        excerpt: "Tidepool Robotics is building a prototype of its drone fleet monitoring software ahead of a pilot next year.",
        daysAgo: 18,
      },
    ],
  },
];

// ---------------------------------------------------------------------------

async function removeExistingDemo(): Promise<void> {
  const demoUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [DEMO_OWNER.email, DEMO_TEAMMATE.email]));
  if (demoUsers.length === 0) return;
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, demoUsers.map((u) => u.id)));
  // Deleting a workspace removes everything in it; only the demo users' own workspaces are touched.
  const demoWorkspaces = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.id, memberships.length ? memberships.map((m) => m.workspaceId) : ["00000000-0000-0000-0000-000000000000"]));
  const ids = demoWorkspaces.map((w) => w.id);
  if (ids.length > 0) await db.delete(workspaces).where(inArray(workspaces.id, ids));
  await db.delete(users).where(inArray(users.id, demoUsers.map((u) => u.id)));
}

async function seed(): Promise<void> {
  await removeExistingDemo();

  const me = await registerOwner({ ...DEMO_OWNER, workspaceName: DEMO_WORKSPACE });
  const owner: AuthContext = { userId: me.user.id, workspaceId: me.workspace.id, role: "owner" };

  // A teammate, so feedback and the team page show more than one person.
  const mate = await registerOwner({ ...DEMO_TEAMMATE, workspaceName: "Priya's workspace (demo)" });
  await db.insert(workspaceMembers).values({ workspaceId: owner.workspaceId, userId: mate.user.id, role: "member" });
  const teammate: AuthContext = { userId: mate.user.id, workspaceId: owner.workspaceId, role: "member" };

  for (const service of SERVICES) {
    await createService(owner, serviceSchema.parse(service));
  }

  const companyIds = new Map<string, string>();
  for (const company of COMPANIES) {
    const { id } = await createCompany(
      owner,
      companySchema.parse({
        name: company.name,
        domain: company.domain,
        industry: company.industry,
        employeeCount: company.employees,
        description: company.description,
        hqCity: company.city,
        hqRegion: null,
        hqCountry: company.country,
      }),
    );
    companyIds.set(company.name, id);

    for (const person of company.people) {
      await addPerson(
        owner,
        id,
        personSchema.parse({
          name: person.name,
          title: person.title,
          seniority: person.seniority,
          jobFunction: person.jobFunction,
          relationship: person.relationship ?? "employee",
          email: person.email ?? null,
          phone: person.phone ?? null,
          professionalUrl: null,
          location: company.city,
          identity: person.identity ?? "likely",
          emailVerification: person.emailVerification ?? "unknown",
          phoneVerification: "unknown",
        }),
      );
    }
    const people = await listCompanyPeople(owner, id);
    const personId = (index: number | undefined) =>
      index === undefined ? null : (people.find((p) => p.name === company.people[index].name)?.id ?? null);

    for (const signal of company.signals) {
      await createSignal(
        owner,
        id,
        signalSchema.parse({
          signalType: signal.signalType,
          intentLevel: signal.intentLevel,
          urgency: signal.urgency,
          serviceCategories: signal.serviceCategories,
          summary: signal.summary,
          personId: personId(signal.person),
          occurredOn: daysAgo(signal.daysAgo),
          sourceUrl: `https://${company.domain}/news/${signal.signalType.replaceAll("_", "-")}`,
          excerpt: signal.excerpt,
          evidenceLabel: "observed",
          source: "manual",
          confidence: null,
        }),
      );
    }
    await rescoreCompany(owner.workspaceId, id);
  }

  // Work in progress, so every status tab, list and feedback view has something in it.
  const feed = await listOpportunities(owner, opportunityListQuerySchema.parse({ group: "open" }));
  const opportunityOf = (name: string) => feed.items.find((item) => item.company.id === companyIds.get(name))?.id;

  const contactToday = await createList(owner, listSchema.parse({ name: "Contact today" }));
  const websites = await createList(owner, listSchema.parse({ name: "Website projects" }));
  for (const name of ["Medora Health", "Harbourside Legal LLP", "Ledgerline Payments"]) {
    const id = opportunityOf(name);
    if (id) await addToList(owner, contactToday.id, id);
  }
  for (const name of ["Harbourside Legal LLP", "BrightSmile Dental Group"]) {
    const id = opportunityOf(name);
    if (id) await addToList(owner, websites.id, id);
  }

  const ledgerline = opportunityOf("Ledgerline Payments");
  if (ledgerline) {
    await updateOpportunity(owner, ledgerline, {
      status: "contacted",
      notes: "Emailed Rahul about 3 senior React engineers. Follow up Thursday.",
    });
  }
  const freightly = opportunityOf("Freightly");
  if (freightly) await updateOpportunity(owner, freightly, { status: "meeting", notes: "Intro call booked with Jeroen." });

  const medora = opportunityOf("Medora Health");
  if (medora) {
    await giveFeedback(owner, medora, feedbackSchema.parse({ verdict: "good_fit", reason: "Funded, clear MVP need, CEO asked directly." }));
    await giveFeedback(teammate, medora, feedbackSchema.parse({ verdict: "good_fit", reason: null }));
  }
  const calder = opportunityOf("Calder & Co Accountants");
  if (calder) {
    await giveFeedback(teammate, calder, feedbackSchema.parse({ verdict: "not_relevant", reason: "Rebrand is a year away; check back in spring." }));
  }

  const final = await listOpportunities(owner, opportunityListQuerySchema.parse({ group: "open" }));
  console.log(`Demo workspace "${DEMO_WORKSPACE}" is ready.`);
  console.log(`  Sign in: ${DEMO_OWNER.email} / ${DEMO_OWNER.password}  (teammate: ${DEMO_TEAMMATE.email})`);
  console.log(`  ${COMPANIES.length} companies, ${final.counts.open} open and ${final.counts.inProgress} in-progress opportunities.`);
  for (const item of final.items) {
    console.log(`  ${String(item.score ?? "-").padStart(3)}  ${item.company.name}  (${item.service?.name ?? "no matching service"})`);
  }
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seeding the demo failed:", error);
    process.exit(1);
  });
