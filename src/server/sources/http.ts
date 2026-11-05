import "server-only";
import { lookup, resolveMx } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Polite HTTP for every source adapter (Spec App. B: "respect robots/rate limits"):
 * - company websites: robots.txt is honoured, one request per second per site, redirects are
 *   followed by hand and only within the same site;
 * - every request: public addresses only (no SSRF into private networks), a timeout and a size cap.
 */

export const USER_AGENT = "LeadGenAIBot/1.0 (+business research; respects robots.txt)";
const TIMEOUT_MS = 10_000;
/** robots.txt is small; a site that is slow to serve it is slow to read anyway. */
const ROBOTS_TIMEOUT_MS = 5_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const SITE_INTERVAL_MS = 1_000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;

export class FetchBlockedError extends Error {}

/** `body` is the text; `bytes` the raw download, for files (e.g. a zip). */
export type FetchedPage = { url: string; status: number; contentType: string; body: string; bytes: Buffer };

const lastRequestAt = new Map<string, number>();
const robotsCache = new Map<string, { rules: RobotsRules | null; at: number }>();

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7));
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Rejects hosts that resolve to private, loopback or link-local addresses. */
async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new FetchBlockedError(`Refusing to fetch ${hostname}`);
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FetchBlockedError(`Refusing to fetch ${hostname}: not a public address`);
  }
}

/**
 * True when the domain has mail servers (MX records). This only shows the domain receives email,
 * not that any particular mailbox exists.
 */
export async function domainReceivesEmail(domain: string): Promise<boolean> {
  try {
    return (await resolveMx(domain)).some((record) => record.exchange && record.exchange !== ".");
  } catch {
    return false;
  }
}

/** True when the host name exists in DNS: a cheap first check before fetching a guessed domain. */
export async function hostResolves(hostname: string): Promise<boolean> {
  try {
    return (await lookup(hostname, { all: true })).length > 0;
  } catch {
    return false;
  }
}

/** The site a host belongs to for throttling and robots: "www.example.co.uk" → "example.co.uk". */
export const siteOf = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");

const TWO_PART_SUFFIX = /\.(co|com|org|net|ac|gov|ltd|plc|nhs)\.[a-z]{2}$/;

/** The registered domain a host belongs to: "careers.toasttab.com" -> "toasttab.com"; "jobs.acme.co.uk" -> "acme.co.uk". */
export function registrableDomain(hostname: string): string {
  const parts = siteOf(hostname).split(".");
  return parts.slice(TWO_PART_SUFFIX.test(`.${parts.slice(-2).join(".")}`) ? -3 : -2).join(".");
}

async function throttle(site: string): Promise<void> {
  const wait = (lastRequestAt.get(site) ?? 0) + SITE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt.set(site, Date.now());
}

async function readCapped(response: Response, maxBytes = MAX_BYTES): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function decode(response: Response, maxBytes: number): Promise<{ body: string; bytes: Buffer }> {
  const bytes = await readCapped(response, maxBytes);
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(bytes), bytes };
}

/**
 * GETs a URL politely. `sameSite` (company websites) also checks robots.txt and keeps redirects
 * on the same site; API adapters pass `sameSite: false` and fixed hosts.
 */
export async function politeGet(
  url: string,
  {
    sameSite = true,
    headers = {},
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BYTES,
  }: {
    sameSite?: boolean;
    headers?: Record<string, string>;
    timeoutMs?: number;
    /** For a known large file (e.g. a register's weekly download); pages stay at the default cap. */
    maxBytes?: number;
  } = {},
): Promise<FetchedPage> {
  let current = new URL(url);
  // Redirects may move between the company's own hosts (toasttab.com → pos.toasttab.com), never off it.
  const site = registrableDomain(current.hostname);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(current.protocol)) throw new FetchBlockedError(`Unsupported protocol ${current.protocol}`);
    if (sameSite && registrableDomain(current.hostname) !== site) throw new FetchBlockedError(`Redirected off-site to ${current.hostname}`);
    await assertPublicHost(current.hostname);
    if (sameSite && !(await robotsAllow(current))) throw new FetchBlockedError(`robots.txt disallows ${current.pathname}`);
    await throttle(siteOf(current.hostname));

    const response = await fetch(current, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.5", ...headers },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      current = new URL(response.headers.get("location")!, current);
      continue;
    }
    return {
      url: current.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      ...(await decode(response, maxBytes)),
    };
  }
  throw new FetchBlockedError("Too many redirects");
}

/** robots.txt for the URL's origin, cached; a missing or unreadable file allows everything. */
async function robotsAllow(url: URL): Promise<boolean> {
  const key = url.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL_MS) {
    let rules: RobotsRules | null = null;
    try {
      await throttle(siteOf(url.hostname));
      const response = await fetch(new URL("/robots.txt", url.origin), {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      });
      if (response.ok) rules = parseRobots((await readCapped(response)).subarray(0, 200_000).toString("utf8"), "LeadGenAIBot");
      else await response.body?.cancel();
    } catch {
      rules = null;
    }
    entry = { rules, at: Date.now() };
    robotsCache.set(key, entry);
  }
  return entry.rules ? isAllowed(entry.rules, url.pathname + url.search) : true;
}

// --- robots.txt ------------------------------------------------------------------------------

/**
 * Minimal robots.txt support (RFC 9309): the group for our user agent, else `*`; the longest
 * matching Allow/Disallow rule wins, Allow on a tie; `*` and `$` wildcards. Pure, so it is unit-tested.
 */

export type RobotsRules = { allow: string[]; disallow: string[] };

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" && value) current.allow.push(value);
    if (field === "disallow" && value) current.disallow.push(value);
  }

  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
  };
}

function ruleLength(rule: string, path: string): number {
  const pattern = rule
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
    .replace(/\\\$$/, "$");
  return new RegExp(`^${pattern}`).test(path) ? rule.length : -1;
}

/** Whether `path` (with its query string) may be fetched under `rules`. */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const allow = Math.max(-1, ...rules.allow.map((r) => ruleLength(r, path)));
  const disallow = Math.max(-1, ...rules.disallow.map((r) => ruleLength(r, path)));
  return disallow === -1 || allow >= disallow;
}
