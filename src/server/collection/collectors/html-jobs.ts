import "server-only";
import { decodeEntities, htmlToText } from "@/server/jobs/html-to-text";
import { isStaleJob, repostKey } from "@/server/jobs/job-signal";
import { registrableDomain } from "@/server/sources/http";
import { canonicalUrl, countriesIn } from "../normalize";
import type { CollectedItemInput } from "../types";

/**
 * Jobs from careers pages that publish no JobPosting markup, read from their HTML. Built from how
 * real careers pages list jobs: almost always a link to the job (its own page, a `?job_id=` or
 * `#job` anchor, or a job host such as YC's job board or an ATS) whose first text is the title,
 * followed by facts (place · type · pay). A link that doesn't point at a job is never read as one,
 * which keeps out team bios, testimonials, menus and product features; the title must also read as
 * a role. Pure, so it is unit-tested against the patterns seen on real pages.
 */

/** Words a job title contains: the role itself. */
const ROLE =
  /\b(engineer|developer|programmer|designer|manager|lead|head of|director|vp|vice president|chief|cto|cfo|coo|analyst|scientist|specialist|associate|representative|rep|intern|internship|architect|consultant|coordinator|administrator|marketer|writer|copywriter|editor|recruiter|officer|executive|technician|researcher|strategist|counsel|attorney|lawyer|paralegal|accountant|controller|bookkeeper|nurse|assistant|operator|agent|advocate|generalist|founding|member of technical staff|product owner|scrum master|devops|sre|tester|producer|instructor|teacher|mechanic|electrician|machinist|welder|driver|partner|owner|hacker|artist|animator|photographer|scientist|physician|therapist|pharmacist|clinician|dentist|hygienist|planner|buyer|trader|underwriter|auditor|economist|statistician|ops|bdr|sdr|account executive)\b/i;

/**
 * A title naming a group of jobs or an area of work, not one job: "Early Career and Internship
 * Opportunities", "Executive leaders", "Support Services", "Engineering roles".
 */
const GROUP_TITLE = /\b(opportunities|careers|positions|openings|jobs|roles|services|teams|areas|programs|leaders|leadership)\s*$/i;

/**
 * A link to a list of jobs rather than one: a search or a filter on a job board, or a careers page
 * about an area of work ("career-areas", "life at", departments, teams).
 */
const LIST_PATH = /\/(search|career-areas?|areas?-of-work|departments?|teams?|life-at[^/]*|job-families|categories)(\/|$)/i;
const LIST_QUERY = /[?&](jobfamily|job_family|category|department|team|location|q|keywords?|ss|search|filter)\w*=/i;

/** Link text that names no role: the title is the heading above it. */
const GENERIC_LINK = /^(view|see|open|read|learn|apply|details|more|view role|view job|see role|see details|apply now|learn more|read more|→|›|»)\b/i;

/** A whole title that is a department, a filter or a page, not a role. */
const NOT_A_TITLE = /^(careers?|jobs|open (roles|positions)|all (roles|jobs|positions)|engineering|design|sales|marketing|operations|product|research|support|customer success|general|other|apply)$/i;

/** Hosts where a company's own jobs live (job boards and ATSs); a link there is a job link. */
const JOB_HOSTS =
  /(^|\.)(ycombinator\.com|workatastartup\.com|ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com|breezy\.hr|bamboohr\.com|rippling\.com|rippling-ats\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|recruitee\.com|teamtailor\.com|personio\.(de|com)|dover\.com|gem\.com|pinpointhq\.com|applytojob\.com|jazzhr\.com|wellfound\.com|homerun\.co|join\.com)$/i;

/** Whether a host is a job board or ATS (a link there is about jobs, not the company's own website). Pure. */
export const isJobHost = (host: string) => JOB_HOSTS.test(host);

const JOB_PATH = /\/(careers?|jobs?|positions?|openings?|roles?|vacanc(y|ies)|join-us|hiring|apply)\/[^/]+/i;
const JOB_QUERY = /[?&](job|position|role|opening|gh_jid|posting|req)(_?id)?=/i;
const JOB_FRAGMENT = /^#(job|position|role|opening|vacanc)/i;

/** Class names of elements about people (team, quotes), whose roles are not open jobs. */
const PEOPLE = /\b[\w-]*(team-member|member-card|author|testimonial|quote|founder|bio|people-card|person)[\w-]*\b/i;

/** Where a link points, when that is a job; null when it isn't. Pure. */
export function jobLinkTarget(href: string, pageUrl: string, domain: string): { url: string; ownPage: boolean } | null {
  if (JOB_FRAGMENT.test(href.trim())) return { url: pageUrl, ownPage: false };
  let url: URL;
  try {
    url = new URL(decodeEntities(href.trim()), pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (LIST_PATH.test(url.pathname) || LIST_QUERY.test(url.search)) return null;
  const sameSite = registrableDomain(url.hostname) === domain;
  if (sameSite) {
    if (JOB_PATH.test(url.pathname)) return { url: url.toString(), ownPage: true };
    if (JOB_QUERY.test(url.search)) return { url: url.toString(), ownPage: false };
    return null;
  }
  if (JOB_HOSTS.test(url.hostname) && url.pathname.length > 1) return { url: url.toString(), ownPage: false };
  return null;
}

/** Text pieces of an HTML fragment in reading order: tags and comments split it, "·" and "|" too. */
function segments(html: string): string[] {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "\n"))
    .split(/\n|\s[·|•]\s/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s && !/^[→›»↗➔·|•-]+$/.test(s));
}

/** Whether text reads as a job title: a role, short, not a sentence, not a department. Pure. */
export function isJobTitle(text: string): boolean {
  const title = text.trim();
  if (title.length < 3 || title.length > 100 || NOT_A_TITLE.test(title)) return false;
  if (title.split(/\s+/).length > 12 || /[.?!]$/.test(title) || title.includes("?")) return false;
  return ROLE.test(title) && !GROUP_TITLE.test(title);
}

/**
 * A place in a fact: remote/hybrid/in office, a "City, ST" or a named country (or US state).
 * Conservative: "Engineering, Infrastructure" or a bare city name is not read as a place.
 */
function isPlace(text: string): boolean {
  if (/\$|€|£|\d+\s*(k|years?|yrs?|%)\b/i.test(text) || isSummary(text)) return false;
  return /\b(remote|hybrid|on-?site|in[- ]office)\b/i.test(text) || /\b[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2}\b/.test(text) || countriesIn(text).length > 0;
}

/** A sentence about the role (a one-line description on its card), not a short fact. */
const isSummary = (text: string) => text.length > 80 || text.split(/\s+/).length > 10 || /[.!]$/.test(text);

const EMPLOYMENT = /\b(full[- ]time|part[- ]time|contract(or)?|internship|temporary|freelance)\b/i;
const PAY = /[$€£]\s?\d/;

/**
 * Facts after a title: where, what kind of contract, what pay; a sentence among them is the role's
 * summary (kept as its text until the job's own page gives the description).
 */
export function factsOf(parts: string[]): { location: string | null; remote: boolean | null; summary: string | null; data: Record<string, unknown> } {
  const summary = parts.find(isSummary) ?? null;
  parts = parts.filter((p) => !isSummary(p));
  const places = parts.filter(isPlace);
  const employment = parts.find((p) => EMPLOYMENT.test(p));
  const pay = parts.find((p) => PAY.test(p));
  return {
    location: places.length > 0 ? places.join("; ").slice(0, 200) : null,
    remote: parts.some((p) => /\bremote\b/i.test(p)) || null,
    summary,
    data: {
      ...(employment ? { employmentType: [employment.match(EMPLOYMENT)![1].toUpperCase().replace(/[- ]/g, "_")] } : {}),
      ...(pay ? { salaryText: pay.slice(0, 80) } : {}),
      ...(parts.length > 0 ? { facts: parts.slice(0, 6).join(" · ").slice(0, 300) } : {}),
    },
  };
}

export const countryOf = (location: string | null) => {
  const named = location ? countriesIn(location) : [];
  return named.length === 1 ? named[0] : null;
};

/** The page without what never lists jobs: scripts, styles, icons, menus, header and footer. */
export function listingBody(html: string): string {
  return html.replace(/<(script|style|svg|noscript|nav|header|footer|select|form)\b[\s\S]*?<\/\1>/gi, " ");
}

/**
 * Jobs listed on a careers page as links: each link that points at a job and whose title (its own
 * first text, or the heading just above a "View role" link) reads as a role. Facts come from the
 * link's other text, else from the text right after it. Pure.
 */
export function jobCardsFrom(html: string, pageUrl: string, domain: string): CollectedItemInput[] {
  const body = listingBody(html);
  const items = new Map<string, CollectedItemInput>();
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const [whole, attributes, inner] = match;
    const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || PEOPLE.test(attributes)) continue;
    const target = jobLinkTarget(href, pageUrl, domain);
    if (!target) continue;
    const start = match.index!;
    // What sits just before the link: about people (a team card, a quote) is never a job.
    const before = body.slice(Math.max(0, start - 300), start);
    if (PEOPLE.test(before.slice(before.lastIndexOf("<div"))) || /team-member|testimonial/i.test(before.slice(-150))) continue;

    let parts = segments(inner);
    if (parts.length === 0 || GENERIC_LINK.test(parts[0])) {
      const heading = [...before.matchAll(/<(h[1-6]|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi)].at(-1)?.[2];
      parts = heading ? segments(heading) : [];
    }
    // The title is the first piece that reads as a role: a card may open with its department.
    const at = parts.slice(0, 3).findIndex(isJobTitle);
    if (at === -1 || parts.some((p) => PLACEHOLDER.test(p))) continue;
    const title = parts[at];
    const rest = parts.slice(at + 1);
    // Facts: the link's own other text, else the text right after it, up to the next job's title.
    const following = segments(body.slice(start + whole.length, start + whole.length + 500).split(/<a\b/i)[0]).slice(0, 6);
    const nextTitle = following.findIndex(isJobTitle);
    const after = rest.length > 0 ? rest : nextTitle === -1 ? following : following.slice(0, nextTitle);
    const { location, remote, summary, data } = factsOf(after);
    // A link to a place on this page (a tab, an anchor) is no separate address to apply at.
    const elsewhere = canonicalUrl(target.url) !== canonicalUrl(pageUrl);
    // The job's own address is its id, on this site or a job board; jobs only shown on this page
    // are told apart by title and place.
    const externalId = elsewhere ? canonicalUrl(target.url) : `${canonicalUrl(pageUrl)}#${repostKey({ title, location })}`;
    const seen = items.get(externalId);
    if (seen) {
      // The same job linked twice (a card and its title link): one job, with what either told.
      items.set(externalId, { ...seen, location: seen.location ?? location, country: seen.country ?? countryOf(location), remote: seen.remote ?? remote, text: seen.text ?? summary, data: { ...data, ...seen.data } });
      continue;
    }
    items.set(externalId, {
      externalId,
      kind: "job",
      url: target.url,
      extraction: "html",
      fetchedUrl: elsewhere ? pageUrl : null,
      title,
      text: summary,
      companyName: null,
      companyDomain: domain,
      location,
      country: countryOf(location),
      remote,
      postedAt: null,
      validThrough: null,
      data: { ...data, ...(!target.ownPage && elsewhere ? { applyUrl: target.url } : {}) },
    });
  }
  return [...items.values()];
}

// --- Jobs that are no longer current ---------------------------------------------------------------

/** A post marked as no longer open: "Content Manager – POSITION FILLED", "(Closed)", "Expired: …". */
const NO_LONGER_OPEN =
  /\b(position|role|job|vacancy|opening)\s+(is\s+|has\s+been\s+)?(filled|closed)\b|\bno longer (available|accepting|open)\b|[-–—:|([]\s*(filled|closed|expired)\s*[)\]]?\s*$|^\s*[([]?(filled|closed|expired)\s*[)\]:|–—-]/i;

/** A website builder's duplicate of a post: "Area Sales Manager Copy 2", "Designer (Copy)", "Designer - Copy". */
const COPY_SUFFIX = /\s+(\(copy(\s*\d+)?\)|[-–]\s*copy(\s*\d+)?|copy\s+\d+)\s*$/i;

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** "October 1, 2021", "Oct 1 2021", "1 October 2021", "2021-10-01", "10/01/2021" (US order). */
const DATE = new RegExp(
  `\\b(?:(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})\\.?,?\\s+(20\\d{2})|(20\\d{2})-(\\d{2})-(\\d{2})|(\\d{1,2})/(\\d{1,2})/(20\\d{2}))\\b`,
  "i",
);
/** Words that make a date the last day to apply, not the day the job was posted. */
const DEADLINE = /\b(deadline|apply by|closes?|closing|until|expires?|before)\b[^\d]{0,20}$/i;

/** The first date written in a text, and whether the text calls it a deadline; null when none. Pure. */
export function dateIn(text: string): { date: Date; deadline: boolean; match: string } | null {
  const found = text.match(DATE);
  if (!found) return null;
  const [, m1, d1, y1, d2, m2, y2, yi, mi, di, mu, du, yu] = found;
  const month = (name: string) => MONTHS.split("|").findIndex((m) => new RegExp(`^(${m})$`, "i").test(name.toLowerCase()));
  const [y, m, d] = m1 ? [+y1, month(m1), +d1] : m2 ? [+y2, month(m2), +d2] : yi ? [+yi, +mi - 1, +di] : [+yu, +mu - 1, +du];
  const date = new Date(Date.UTC(y, m, d));
  if (m < 0 || m > 11 || date.getUTCDate() !== d) return null;
  return { date, deadline: DEADLINE.test(text.slice(0, found.index)), match: found[0] };
}

/**
 * A careers-page job as it is still current, or null when it isn't: a post marked filled or closed,
 * a builder's "Copy N" duplicate of a post (kept once, under the post's own title), and, on a page
 * that gives no dates, a date written in its place or facts (a "posted" date more than 60 days old,
 * or a deadline that has passed). Pure.
 */
export function currentJob(item: CollectedItemInput, now: Date): CollectedItemInput | null {
  const facts = typeof item.data.facts === "string" ? item.data.facts : "";
  if ([item.title, item.location ?? "", facts].some((t) => NO_LONGER_OPEN.test(t))) return null;
  const title = item.title.replace(COPY_SUFFIX, "").trim() || item.title;
  if (item.postedAt || item.validThrough) return { ...item, title };
  const written = dateIn(item.location ?? "") ?? dateIn(facts);
  if (!written) return { ...item, title };
  if (written.deadline) return written.date < now ? null : { ...item, title, validThrough: written.date };
  if (written.date > now) return { ...item, title };
  if (isStaleJob(written.date, now)) return null;
  // The date is the post's, not its place: "USA / remote / October 1, 2021" → "USA / remote".
  const location = item.location?.replace(written.match, "").replace(/[\s/|,;·•-]+$/, "").trim() || null;
  return { ...item, title, location, postedAt: written.date };
}

/** Placeholder text of an unfinished website template: a sample job, not a real one. */
const PLACEHOLDER = /\blorem ipsum\b|\bdolor sit amet\b/i;

/** Words a job description uses and a blog post or a "life at" page doesn't, all together. */
const DESCRIPTION_CUES = [
  /responsibilit/i,
  /requirements?|qualifications?|must have|nice to have/i,
  /what you('|’)ll (do|bring|work on)|you will|in this role|the role/i,
  /about (you|the role|the team)|who you are|we('|’)re looking for/i,
  /\bapply\b|application/i,
  /experience (with|in)|\d\+? years/i,
];

/**
 * A job's own page without JobPosting markup: its main heading as the title (when it reads as a
 * role) and its main text, accepted only when the text reads as a job description (at least three
 * of `DESCRIPTION_CUES`). The location is read from a "Location:" line when there is one. Pure.
 */
export function jobPageFrom(html: string, pageUrl: string, domain: string): CollectedItemInput | null {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = heading ? segments(heading[1]).join(" ") : null;
  if (!heading || !title || !isJobTitle(title)) return null;
  // The main content; a page without <main>/<article> is read from its heading on, past the menus.
  const main = html.match(/<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i)?.[2] ?? listingBody(html.slice(heading.index));
  const text = htmlToText(main.replace(/<(script|style|svg|noscript|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, " "));
  if (PLACEHOLDER.test(text) || DESCRIPTION_CUES.filter((cue) => cue.test(text)).length < 3) return null;
  // Facts only from what the page labels or states in short lines near the top; no page chrome.
  // The location line, up to the next label on it ("… Job Type: Full-Time").
  const labelled = text.match(/\blocations?\s*:\s*([^\n]{2,80})/i)?.[1]?.split(/\b(job type|type|employment|salary|department|schedule)\s*:/i)[0].trim() || null;
  const top = text.split("\n").slice(0, 8);
  const { location, remote, data } = factsOf(labelled ? labelled.split(/\s[·|•]\s/) : top.filter(isPlace));
  const employment = top.find((l) => l.length <= 80 && EMPLOYMENT.test(l))?.match(EMPLOYMENT)?.[1];
  delete data.facts;
  if (employment) data.employmentType = [employment.toUpperCase().replace(/[- ]/g, "_")];
  return {
    externalId: canonicalUrl(pageUrl),
    kind: "job",
    url: pageUrl,
    extraction: "html",
    fetchedUrl: null,
    title,
    text,
    companyName: null,
    companyDomain: domain,
    location,
    country: countryOf(location),
    remote,
    postedAt: null,
    validThrough: null,
    data,
  };
}
