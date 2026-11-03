import type { SeniorityLevel } from "@/lib/domain/people";
import type { FoundPerson } from "./index";

/** Name and title clean-up for data from registers and websites. Pure, so it is unit-tested. */

const KEEP_UPPER = new Set(["LTD", "LLP", "PLC", "UK", "CIC", "LP", "IT", "HR", "NHS", "AI", "UKI", "GB"]);
const LOWER_WORDS = new Set(["and", "of", "the", "for", "in", "on", "at", "to", "by"]);
const COMPANY_SUFFIX: Record<string, string> = { LTD: "Ltd", LIMITED: "Limited", PLC: "plc" };

const capitalise = (word: string) =>
  word
    .toLowerCase()
    .replace(/(^|[-'’(])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase());

/** "BRIGHTSMILE DENTAL GROUP LTD" → "Brightsmile Dental Group Ltd"; mixed-case names are kept. */
export function titleCaseCompanyName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .split(" ")
    .map((word, index) => {
      const bare = word.replace(/[^A-Z0-9&]/g, "");
      if (COMPANY_SUFFIX[bare]) return word.replace(bare, COMPANY_SUFFIX[bare]);
      if (KEEP_UPPER.has(bare) || /^[A-Z]&[A-Z]$/.test(bare)) return word;
      if (index > 0 && LOWER_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      return capitalise(word);
    })
    .join(" ");
}

/** "SMITH, Sarah Jane" (register order) → "Sarah Jane Smith". */
export function personNameFromRegister(name: string): string {
  const [surname, given] = name.split(",").map((part) => part.trim());
  const full = given ? `${given} ${surname}` : surname;
  return full
    .split(/\s+/)
    .filter((word) => !/^(mr|mrs|ms|miss|dr|sir)\.?$/i.test(word))
    .map((word) => (word === word.toUpperCase() || word === word.toLowerCase() ? capitalise(word) : word))
    .join(" ");
}

/** A title's seniority, from common words ("Managing Director" → owner, "Head of" → director). */
export function seniorityFromTitle(title: string | null): SeniorityLevel {
  const t = (title ?? "").toLowerCase();
  if (!t) return "unknown";
  if (/\b(founder|owner|managing director|proprietor|principal|managing partner|senior partner)\b/.test(t)) return "owner";
  if (/\b(ceo|cto|cfo|coo|cmo|cio|chief|president)\b/.test(t)) return "c_level";
  if (/\b(vp|vice president)\b/.test(t)) return "vp";
  if (/\b(director|head of|partner)\b/.test(t)) return "director";
  if (/\b(manager|lead)\b/.test(t)) return "manager";
  if (/\b(senior|sr\.?)\b/.test(t)) return "senior";
  return "entry";
}

/** The job function slug a title points to, if any (matches the seeded job_functions). */
export function jobFunctionFromTitle(title: string | null): string | null {
  const t = (title ?? "").toLowerCase();
  if (/\b(founder|owner|ceo|managing director|chief executive|principal|proprietor)\b/.test(t)) return "founder_executive";
  if (/\b(cto|engineer|developer|technology|technical)\b/.test(t)) return "engineering";
  if (/\b(it|systems|infrastructure)\b/.test(t)) return "it";
  if (/\b(product)\b/.test(t)) return "product";
  if (/\b(marketing|brand|digital|communications)\b/.test(t)) return "marketing";
  if (/\b(sales|business development|commercial)\b/.test(t)) return "sales";
  if (/\b(operations|practice manager|office manager|coo)\b/.test(t)) return "operations";
  if (/\b(finance|cfo|accounts|finance director)\b/.test(t)) return "finance";
  if (/\b(hr|people|talent|recruit)\b/.test(t)) return "human_resources";
  return null;
}

const OFFICER_ROLES: Record<string, { title: string; relationship: FoundPerson["relationship"] }> = {
  director: { title: "Director", relationship: "board_member" },
  "llp-designated-member": { title: "Designated member", relationship: "founder" },
  "llp-member": { title: "Member", relationship: "founder" },
  secretary: { title: "Company secretary", relationship: "employee" },
};

/** A register officer as a person; corporate officers and unknown roles are skipped. */
export function officerToPerson(officer: { name: string; officer_role: string; occupation?: string | null }): FoundPerson | null {
  const role = OFFICER_ROLES[officer.officer_role];
  if (!role) return null;
  const occupation = officer.occupation?.trim();
  // The occupation is often more telling than "Director" ("Dentist", "Managing Director").
  const title = occupation && !/^(director|company director|none)$/i.test(occupation) ? `${role.title} (${capitalise(occupation)})` : role.title;
  return {
    name: personNameFromRegister(officer.name),
    title,
    seniority: officer.officer_role === "secretary" ? "manager" : "owner",
    jobFunction: officer.officer_role === "secretary" ? "operations" : "founder_executive",
    relationship: role.relationship,
    // The register is authoritative that they hold this office.
    confidence: 90,
  };
}
