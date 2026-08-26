import {
  assertPublicHost,
  IntakeError,
  readCapped,
  TIMEOUT_MS,
  timeoutSignal,
  UA,
} from "./_net.js";
import { renderWithBrowser } from "./_render.js";

const MAX_REDIRECTS = 3;
const MAX_STYLESHEETS = 4;

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
      const line = (rawLine.split("#")[0] ?? "").trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = (rawKey ?? "").trim().toLowerCase();
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


/**
 * The sanitizer drops <link>, so external CSS is inlined before it runs.
 * Without this every live snapshot renders as unstyled text.
 */
export async function inlineStylesheets(html: string, base: URL): Promise<{ html: string; inlined: number }> {
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
        // A stylesheet href is attacker-controlled just like the page URL, and
        // an unvalidated fetch here would reopen the SSRF the main path closes.
        let current = new URL(href);
        for (let hop = 0; hop <= 2; hop += 1) {
          await assertPublicHost(current);
          const response = await fetch(current, {
            redirect: "manual",
            headers: { "user-agent": UA },
            signal: timeoutSignal(6000),
          });
          const location = response.headers.get("location");
          if (response.status >= 300 && response.status < 400 && location) {
            current = new URL(location, current);
            continue;
          }
          if (!response.ok) return "";
          return await readCapped(response, 400_000);
        }
        return "";
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

function renderEnabled(): boolean {
  return process.env.GRAFT_RENDER !== "0";
}

export default async function handler(req: any, res: any) {
  // Target content is never cached. The trust claim depends on this line.
  res.setHeader("cache-control", "no-store");

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

    let markup = body;
    let source: "html" | "browser" = "html";
    const rendered = clientRenderedReport(body);

    if (rendered.shell) {
      // The server sent a shell. Executing the page is the only way to see it,
      // so it is attempted here rather than at the top: a page that renders on
      // the server never pays this cost.
      const painted = renderEnabled()
        ? await renderWithBrowser(finalUrl)
        : null;
      const paintedReport = painted ? clientRenderedReport(painted) : null;

      if (!painted || paintedReport?.shell) {
        throw new IntakeError(
          422,
          "client-rendered",
          "That page builds itself with JavaScript, and rendering it produced nothing to compile.",
          renderEnabled()
            ? `Graft loaded the page in a headless browser and still read only ${paintedReport?.textLength ?? 0} characters of text. It may require sign-in, or block automated browsers.`
            : `Graft read the HTML the server sends and got ${rendered.textLength} characters of text. Browser rendering is disabled on this deployment.`,
        );
      }

      markup = painted;
      source = "browser";
    }

    const stripped = STRIPPED_HEADERS.filter((header) => response.headers.has(header));
    const { html, inlined } =
      source === "browser" ? { html: markup, inlined: 0 } : await inlineStylesheets(markup, finalUrl);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(markup)?.[1]?.trim().slice(0, 200);

    res.status(200).json({
      ok: true,
      html,
      finalUrl: finalUrl.href,
      title: title || finalUrl.hostname,
      bytes: markup.length,
      strippedHeaders: stripped,
      inlinedStylesheets: inlined,
      source,
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
