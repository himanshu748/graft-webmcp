import { fixtureDefinitions, type FixtureId } from "./fixtures";

export type SourceKind = "fixture" | "live" | "paste";

export interface SourceMeta {
  bytes: number;
  strippedHeaders: string[];
  inlinedStylesheets: number;
}

export interface ActiveSource {
  kind: SourceKind;
  id: string;
  label: string;
  sourceUrl: string;
  html: string;
  meta?: SourceMeta;
}

export interface LivePreset {
  url: string;
  label: string;
  note: string;
  /** Why this target is fair game to read, stated rather than assumed. */
  posture: string;
}

/**
 * Every preset was probed before it was listed. Each one is either a sandbox
 * published for automation, an open-content project or a sponsor's own demo.
 */
export const livePresets: LivePreset[] = [
  {
    url: "https://books.toscrape.com",
    label: "Books to Scrape",
    note: "Product grid, 20 repeated units",
    posture: "Automation sandbox",
  },
  {
    url: "https://demo.vercel.store",
    label: "Vercel Store demo",
    note: "Commerce search and catalog",
    posture: "MIT public demo",
  },
  {
    url: "https://quotes.toscrape.com",
    label: "Quotes to Scrape",
    note: "Repeated quotes and tag lists",
    posture: "Automation sandbox",
  },
  {
    url: "https://en.wikipedia.org/wiki/Coffee",
    label: "Wikipedia: Coffee",
    note: "Long article, data tables",
    posture: "CC BY-SA",
  },
  {
    url: "https://openlibrary.org",
    label: "Open Library",
    note: "Search-led catalog",
    posture: "Open data",
  },
  {
    url: "https://news.ycombinator.com",
    label: "Hacker News",
    note: "Search form, ranked rows",
    posture: "Public markup",
  },
];

export function fixtureSource(id: FixtureId): ActiveSource {
  const fixture = fixtureDefinitions.find((item) => item.id === id) ?? fixtureDefinitions[0];
  return {
    kind: "fixture",
    id: fixture.id,
    label: fixture.title,
    sourceUrl: fixture.sourceUrl,
    html: fixture.html,
  };
}

export interface IntakeFailure {
  reason: string;
  message: string;
  detail?: string;
}

export class IntakeRequestError extends Error {
  constructor(readonly failure: IntakeFailure) {
    super(failure.message);
  }
}

export async function fetchLiveSource(rawUrl: string, signal?: AbortSignal): Promise<ActiveSource> {
  const response = await fetch(`/api/fetch?url=${encodeURIComponent(rawUrl)}`, { signal });
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new IntakeRequestError({
      reason: "network",
      message: "Graft could not read that response.",
      detail: `The intake service answered ${response.status}.`,
    });
  }

  if (!response.ok || !payload?.ok) {
    throw new IntakeRequestError({
      reason: payload?.reason ?? "network",
      message: payload?.message ?? "Graft could not reach that page.",
      detail: payload?.detail,
    });
  }

  return {
    kind: "live",
    id: payload.finalUrl,
    label: payload.title ?? payload.finalUrl,
    sourceUrl: payload.finalUrl,
    html: payload.html,
    meta: {
      bytes: payload.bytes ?? 0,
      strippedHeaders: payload.strippedHeaders ?? [],
      inlinedStylesheets: payload.inlinedStylesheets ?? 0,
    },
  };
}

export function pasteSource(html: string): ActiveSource {
  return {
    kind: "paste",
    id: "pasted-html",
    label: "Pasted HTML",
    sourceUrl: "pasted markup",
    html,
    meta: { bytes: html.length, strippedHeaders: [], inlinedStylesheets: 0 },
  };
}
