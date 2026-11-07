/**
 * robots.txt evaluation following RFC 9309 for the GraftBot product token.
 *
 * - Consecutive `user-agent` lines open one group; the rules that follow belong
 *   to every agent named in it.
 * - The groups naming `graftbot` (case-insensitive) are combined and used on
 *   their own. Only when none names it do the `*` groups apply, combined.
 * - The rule with the longest pattern wins, `allow` on a tie. `*` matches any
 *   run of characters and a trailing `$` anchors the end of the path.
 * - Rules match the path and query (`/a?b=1`), not the path alone.
 */

export const ROBOTS_AGENT = "graftbot";

/** RFC 9309 §2.5 asks crawlers to parse at least 500 KiB. */
export const MAX_ROBOTS_CHARS = 512_000;

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
}

export type RobotsVerdict =
  | { allowed: true; reason: "rules" | "no-robots" }
  | { allowed: false; reason: "rules" | "unavailable" };

/** Uppercases percent-escapes and escapes non-ASCII, so `%2f`, `%2F` and `ü` compare as in a URL. */
function normalizeEncoding(value: string): string {
  return value
    .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
    .replace(/[^\x21-\x7e]/g, (char) => encodeURIComponent(char));
}

function parseGroups(body: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.slice(0, MAX_ROBOTS_CHARS).split(/\r\n|\r|\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      // An empty `disallow` allows everything; it is not a rule that can match.
      if (current && value) current.rules.push({ allow: key === "allow", pattern: value });
    }
    // Other records (sitemap, crawl-delay, ...) belong to no group and are ignored.
  }
  return groups;
}

/** The combined rules of the groups that apply to `agent`, or `null` when none does. */
export function rulesFor(body: string, agent = ROBOTS_AGENT): RobotsRule[] | null {
  const groups = parseGroups(body);
  const named = groups.filter((group) => group.agents.includes(agent));
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"));
  return chosen.length > 0 ? chosen.flatMap((group) => group.rules) : null;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = normalizeEncoding(anchored ? pattern.slice(0, -1) : pattern);
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/** Whether `pathAndQuery` may be fetched under the robots.txt `body`. */
export function isAllowedByRobots(body: string, pathAndQuery: string, agent = ROBOTS_AGENT): boolean {
  const rules = rulesFor(body, agent);
  if (!rules) return true;
  const path = normalizeEncoding(pathAndQuery || "/");
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * Applies RFC 9309 §2.3.1 to a robots.txt response: 2xx is parsed, 4xx means
 * there are no restrictions, and 5xx means the site is treated as fully
 * disallowed until the file can be read. A network error is handled by the
 * caller as `unavailable`, like a 5xx.
 */
export function robotsVerdict(status: number, body: string, pathAndQuery: string): RobotsVerdict {
  if (status >= 500) return { allowed: false, reason: "unavailable" };
  if (status >= 400) return { allowed: true, reason: "no-robots" };
  return isAllowedByRobots(body, pathAndQuery)
    ? { allowed: true, reason: "rules" }
    : { allowed: false, reason: "rules" };
}
