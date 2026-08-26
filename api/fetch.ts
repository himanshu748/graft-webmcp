import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_STYLESHEETS = 4;
const UA = "GraftBot/0.1 (+https://github.com/himanshu748/graft-webmcp) snapshot-compiler";

const STRIPPED_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "set-cookie",
];

/** Categories we refuse on principle, not because they are hard. */
const DENY_PATTERNS = [
  /(^|\.)(bank|banking|chase|wellsfargo|hsbc|barclays|citi)\./i,
  /(^|\.)(paypal|stripe|venmo|wise)\.com$/i,
  /(^|\.)(login|signin|auth|account|accounts|id)\./i,
  /(^|\.)(gov|nhs)\.[a-z.]+$/i,
  /(^|\.)(mail|inbox|webmail)\./i,
];

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true;
    if (v6.startsWith("fe80")) return true;
    if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * A single-page app serves a shell and builds the page in the browser. Graft
 * reads server HTML, so there is genuinely nothing to compile. Saying that
 * plainly beats showing an empty tool list and letting the user guess.
 */
function clientRenderedReport(html: string): { shell: boolean; textLength: number } {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const stripped = body
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  const textLength = stripped.replace(/\s+/g, " ").trim().length;
  const hasStructure = /<(form|table|article|section)\b/i.test(body);
  const listCount = (body.match(/<li\b/gi) ?? []).length;
  return { shell: textLength < 400 && !hasStructure && listCount < 5, textLength };
}

class IntakeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/**
 * Server-side fetch is an SSRF surface, so every hop is validated rather than
 * only the URL the caller typed.
 */
async function assertPublicHost(target: URL): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new IntakeError(400, "scheme", "Only http and https URLs can be compiled.");
  }
  const host = target.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new IntakeError(403, "private", "That host is not reachable from Graft.");
  }
  if (DENY_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new IntakeError(
      403,
      "denylisted",
      "Graft does not compile authentication, banking, mail or government pages.",
      "This is a policy choice, not a technical limit.",
    );
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new IntakeError(403, "private", "That address is inside a private network.");
    }
    return;
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new IntakeError(400, "dns", `Could not resolve ${host}.`);
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new IntakeError(403, "private", "That host resolves to a private address.");
  }
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

/** Minimal robots.txt evaluation for the wildcard and GraftBot agents. */
async function robotsAllows(target: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/robots.txt", target.origin), {
      headers: { "user-agent": UA },
      signal: timeoutSignal(4000),
    });
    if (!response.ok) return true;
    const body = (await response.text()).slice(0, 100_000);
    const path = target.pathname || "/";
    let applies = false;
    let allowed = true;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.split("#")[0].trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        applies = value === "*" || value.toLowerCase() === "graftbot";
        continue;
      }
      if (!applies || !value) continue;
      if (key === "disallow" && path.startsWith(value)) allowed = false;
      if (key === "allow" && path.startsWith(value)) allowed = true;
    }
    return allowed;
  } catch {
    return true;
  }
}

async function fetchFollowing(start: URL): Promise<{ response: Response; finalUrl: URL }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en",
      },
      signal: timeoutSignal(TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new IntakeError(400, "redirects", "That URL redirected too many times.");
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    throw new IntakeError(413, "too-large", "That page is larger than Graft's 3 MB snapshot limit.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    throw new IntakeError(413, "too-large", "That page is larger than Graft's 3 MB snapshot limit.");
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * The sanitizer drops <link>, so external CSS is inlined before it runs.
 * Without this every live snapshot renders as unstyled text.
 */
async function inlineStylesheets(html: string, base: URL): Promise<{ html: string; inlined: number }> {
  const linkPattern = /<link\b[^>]*>/gi;
  const links = html.match(linkPattern) ?? [];
  const hrefs: string[] = [];
  for (const tag of links) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, base);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") hrefs.push(resolved.href);
    } catch {
      continue;
    }
    if (hrefs.length >= MAX_STYLESHEETS) break;
  }
  if (hrefs.length === 0) return { html, inlined: 0 };

  const sheets = await Promise.all(
    hrefs.map(async (href) => {
      try {
        const response = await fetch(href, {
          headers: { "user-agent": UA },
          signal: timeoutSignal(6000),
        });
        if (!response.ok) return "";
        const text = await response.text();
        return text.length > 400_000 ? "" : text;
      } catch {
        return "";
      }
    }),
  );

  const css = sheets.filter(Boolean).join("\n");
  if (!css) return { html, inlined: 0 };
  const styleTag = `<style data-graft-inlined="true">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
  const headClose = html.search(/<\/head>/i);
  const next =
    headClose === -1
      ? `${styleTag}${html}`
      : `${html.slice(0, headClose)}${styleTag}${html.slice(headClose)}`;
  return { html: next, inlined: sheets.filter(Boolean).length };
}

export default async function handler(req: any, res: any) {
  res.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=600");

  const raw = typeof req.query?.url === "string" ? req.query.url : "";
  if (!raw) {
    res.status(400).json({ ok: false, reason: "missing", message: "Pass a ?url= parameter." });
    return;
  }

  let target: URL;
  try {
    target = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    res.status(400).json({ ok: false, reason: "invalid", message: "That does not look like a URL." });
    return;
  }

  try {
    await assertPublicHost(target);

    if (!(await robotsAllows(target))) {
      throw new IntakeError(
        403,
        "robots",
        "That site's robots.txt disallows this path.",
        "Graft honours robots.txt even though a snapshot is a single read.",
      );
    }

    const { response, finalUrl } = await fetchFollowing(target);
    if (!response.ok) {
      throw new IntakeError(
        502,
        "status",
        `The site answered ${response.status}.`,
        response.status === 403
          ? "That usually means a bot challenge sits in front of the page."
          : undefined,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      throw new IntakeError(
        415,
        "content-type",
        "That URL is not an HTML page.",
        `The server returned ${contentType || "an unknown content type"}.`,
      );
    }

    const body = await readCapped(response);

    const rendered = clientRenderedReport(body);
    if (rendered.shell) {
      throw new IntakeError(
        422,
        "client-rendered",
        "That page builds itself with JavaScript, so there is nothing to compile.",
        `Graft reads the HTML the server sends and never executes target scripts. This one returned ${rendered.textLength} characters of text. Server-rendered pages work best.`,
      );
    }

    const stripped = STRIPPED_HEADERS.filter((header) => response.headers.has(header));
    const { html, inlined } = await inlineStylesheets(body, finalUrl);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim().slice(0, 200);

    res.status(200).json({
      ok: true,
      html,
      finalUrl: finalUrl.href,
      title: title || finalUrl.hostname,
      bytes: body.length,
      strippedHeaders: stripped,
      inlinedStylesheets: inlined,
    });
  } catch (error) {
    if (error instanceof IntakeError) {
      res
        .status(error.status)
        .json({ ok: false, reason: error.reason, message: error.message, detail: error.detail });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({
      ok: false,
      reason: "network",
      message: "Graft could not reach that page.",
      detail: message.includes("aborted") ? "The request timed out after 12 seconds." : message,
    });
  }
}
