import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { compileDocument, executeTool } from "./lib";
import type { LiveSearchRequest, LiveSearchResponse } from "./lib/types";
import { sanitizeFixtureHtml } from "./sanitize";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
// A DOMParser document has no defaultView, so execution falls back to the
// global Event constructor. In a browser that is the same realm; under jsdom it
// has to be pointed at the window explicitly.
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  Event: dom.window.Event,
});

const PAGE = `<!doctype html><html><head><title>Catalog</title></head><body>
  <main>
    <form action="/find" method="GET">
      <label for="q">Search catalog</label>
      <input id="q" name="search_term" type="search">
      <button type="submit">Go</button>
    </form>
    <h2>Books</h2>
    <ul>
      <li><h3><a href="/a" title="Dune">Dune</a></h3><p class="price_color">$10</p></li>
      <li><h3><a href="/b" title="Emma">Emma</a></h3><p class="price_color">$12</p></li>
      <li><h3><a href="/c" title="Ulysses">Ulysses</a></h3><p class="price_color">$14</p></li>
    </ul>
  </main>
</body></html>`;

function compile(baseUrl?: string) {
  const sanitized = sanitizeFixtureHtml(PAGE, baseUrl);
  return { doc: sanitized.document, compilation: compileDocument(sanitized.document) };
}

describe("live search endpoint capture", () => {
  it("keeps a GET form target as inert data, resolved absolute", () => {
    const { doc } = compile("https://shop.example.com/catalog/");
    const form = doc.querySelector("form")!;
    expect(form.getAttribute("action")).toBeNull();
    expect(form.getAttribute("data-graft-inert")).toBe("true");
    expect(form.getAttribute("data-graft-action")).toBe("https://shop.example.com/find");
  });

  it("captures no endpoint when the source has no known origin", () => {
    const { compilation } = compile();
    const tool = compilation.tools.find((t) => t.binding.kind === "search")!;
    expect((tool.binding as { liveEndpoint: string | null }).liveEndpoint).toBeNull();
  });

  it("does not replay a POST form", () => {
    const sanitized = sanitizeFixtureHtml(
      PAGE.replace('method="GET"', 'method="POST"'),
      "https://shop.example.com/catalog/",
    );
    expect(sanitized.document.querySelector("form")?.getAttribute("data-graft-action")).toBeNull();
  });
});

describe("live search execution", () => {
  it("queries the live endpoint using each control's real name attribute", async () => {
    const { doc, compilation } = compile("https://shop.example.com/catalog/");
    const tool = compilation.tools.find((t) => t.binding.kind === "search")!;

    const seen: LiveSearchRequest[] = [];
    const runLiveSearch = vi.fn(async (request: LiveSearchRequest): Promise<LiveSearchResponse> => {
      seen.push(request);
      return { url: "https://shop.example.com/find?search_term=dune", rows: ["title: Dune | price: $10"], total: 1 };
    });

    const result = await executeTool(tool, { search_term: "dune" }, { root: doc, runLiveSearch });

    expect(runLiveSearch).toHaveBeenCalledOnce();
    // The parameter name must be the control's name attribute, not the
    // normalized schema key, or the query silently returns the unfiltered page.
    expect(seen[0]?.params).toEqual({ search_term: "dune" });
    expect(seen[0]?.endpoint).toBe("https://shop.example.com/find");
    expect(result.ok).toBe(true);
    expect(result.data?.source).toBe("live");
    expect(result.data?.total).toBe(1);
  });

  it("falls back to the snapshot when the live query fails", async () => {
    const { doc, compilation } = compile("https://shop.example.com/catalog/");
    const tool = compilation.tools.find((t) => t.binding.kind === "search")!;
    const runLiveSearch = vi.fn(async () => {
      throw new Error("intake refused");
    });

    const result = await executeTool(tool, { search_term: "dune" }, { root: doc, runLiveSearch });

    expect(runLiveSearch).toHaveBeenCalledOnce();
    expect(result.data?.source).not.toBe("live");
  });

  it("does not call the live endpoint when no arguments are given", async () => {
    const { doc, compilation } = compile("https://shop.example.com/catalog/");
    const tool = compilation.tools.find((t) => t.binding.kind === "search")!;
    const runLiveSearch = vi.fn();
    // An empty query is rejected before either path runs, so a bare call can
    // never turn into a request to the target site.
    await expect(executeTool(tool, {}, { root: doc, runLiveSearch })).rejects.toThrow(
      /at least one search or filter field/i,
    );
    expect(runLiveSearch).not.toHaveBeenCalled();
  });
});
