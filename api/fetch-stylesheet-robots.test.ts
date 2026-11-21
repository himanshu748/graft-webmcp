import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { inlineStylesheets } from "./fetch.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const html = '<html><head><link rel="stylesheet" href="https://assets.example/private.css"></head><body>Ready</body></html>';
const base = new URL("https://public.example/page");

beforeEach(() => {
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("stylesheet robots policy", () => {
  it("does not fetch a disallowed stylesheet", async () => {
    const fetchMock = vi.fn(async (target: URL) => {
      expect(String(target)).toBe("https://assets.example/robots.txt");
      return new Response("User-agent: *\nDisallow: /private.css", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await inlineStylesheets(html, base)).toEqual({ html, inlined: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rechecks robots on a stylesheet redirect destination", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (target: URL) => {
      const url = String(target);
      seen.push(url);
      if (url === "https://assets.example/robots.txt") return new Response("", { status: 404 });
      if (url === "https://assets.example/private.css") {
        return new Response(null, { status: 302, headers: { location: "https://other.example/blocked.css" } });
      }
      if (url === "https://other.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /blocked.css", { status: 200 });
      }
      throw new Error("Disallowed stylesheet was requested");
    }));
    expect(await inlineStylesheets(html, base)).toEqual({ html, inlined: 0 });
    expect(seen).toEqual([
      "https://assets.example/robots.txt",
      "https://assets.example/private.css",
      "https://other.example/robots.txt",
    ]);
  });

  it("continues to inline a stylesheet allowed by robots", async () => {
    const fetchMock = vi.fn(async (target: URL) => {
      if (String(target).endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (String(target) === "https://assets.example/private.css") {
        return new Response("body{color:green}", { status: 200 });
      }
      throw new Error("Unexpected URL");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await inlineStylesheets(html, base);
    expect(result.inlined).toBe(1);
    expect(result.html).toContain('data-graft-inlined="true"');
    expect(result.html).toContain("body{color:green}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
