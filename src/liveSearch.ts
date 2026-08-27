import { compileDocument } from "./lib";
import type { LiveSearchRequest, LiveSearchResponse } from "./lib/types";
import { fetchLiveSource } from "./data/sources";
import { sanitizeFixtureHtml } from "./sanitize";

const MAX_LIVE_ROWS = 25;

/**
 * Replays a derived search against the site it came from. The query goes
 * through the same intake endpoint as any other page, so it inherits the host
 * checks, the denylist, robots and the size caps rather than opening a second
 * door.
 */
export async function runLiveSearch(request: LiveSearchRequest): Promise<LiveSearchResponse> {
  const target = new URL(request.endpoint);
  for (const [name, value] of Object.entries(request.params)) {
    target.searchParams.set(name, value);
  }

  const source = await fetchLiveSource(target.href);
  const sanitized = sanitizeFixtureHtml(source.html, source.sourceUrl);
  const compilation = compileDocument(sanitized.document);

  // The result set is whichever repeated region the results page actually
  // populated, which is not necessarily the one the original page had.
  const collections = compilation.snapshot.collections
    .filter((collection) => !collection.chrome)
    .sort((a, b) => b.rows.length - a.rows.length);
  const best = collections[0];

  const rows = (best?.rows ?? []).map((row) => {
    const fields = Object.entries(row.fields)
      .filter(([, value]) => value?.trim())
      .map(([key, value]) => `${key}: ${value.trim()}`);
    return fields.join(" | ") || row.text;
  });

  return {
    url: source.sourceUrl,
    rows: rows.slice(0, MAX_LIVE_ROWS),
    total: best?.count ?? rows.length,
  };
}
