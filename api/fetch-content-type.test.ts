import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import handler from "./fetch.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("./_render.js", () => ({ renderWithBrowser: vi.fn() }));

function fakeResponse() {
  let status = 200;
  let data: Record<string, unknown> = {};
  return {
    response: {
      setHeader(_name: string, _value: string) {},
      status(code: number) { status = code; return this; },
      json(body: Record<string, unknown>) { data = body; },
    },
    result() { return { status, data }; },
  };
}

const html = "<html><body><article>" + "Ordinary page content. ".repeat(100) +
  "</article></body></html>";

beforeEach(() => {
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as never);
});
afterEach(() => vi.unstubAllGlobals());

async function requestContentType(contentType: string) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("", { status: 404 })) // no robots policy
    .mockResolvedValueOnce(new Response(html, {
      status: 200, headers: { "content-type": contentType },
    }));
  vi.stubGlobal("fetch", fetchMock);
  const reply = fakeResponse();
  await handler({ query: { url: "https://public.example/page" } }, reply.response);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  return reply.result();
}

describe("HTML response MIME validation", () => {
  it("accepts exact HTML MIME types, including case and parameters", async () => {
    for (const type of [
      "text/html", "TEXT/HTML; charset=UTF-8", "application/xhtml+xml",
    ]) {
      expect((await requestContentType(type)).status).toBe(200);
    }
  });

  it("rejects lookalike types and HTML substrings hidden in parameters", async () => {
    for (const type of [
      "text/html-unsafe",
      "application/xhtml-malformed",
      "text/plain; note=text/html",
      "application/json; name=application/xhtml+xml",
    ]) {
      const result = await requestContentType(type);
      expect(result).toMatchObject({ status: 415, data: { reason: "content-type" } });
    }
  });
});
