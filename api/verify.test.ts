import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readNativeTools } from "./_render.js";
import verify from "./verify.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("./_render.js", () => ({ readNativeTools: vi.fn() }));

const dnsLookup = lookup as unknown as ReturnType<typeof vi.fn>;
const nativeTools = vi.mocked(readNativeTools);

type FixtureTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
};

const goodTool = {
  name: "search_records",
  description: "Search public records.",
  inputSchema: {
    type: "object",
    properties: { term: { type: "string", description: "Search text." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

function report(tools: FixtureTool[] = [goodTool]) {
  return {
    modelContextPresent: true,
    surface: "navigator",
    tools,
    exposes: { inputSchema: true, annotations: true },
    userAgent: "test WebMCP browser",
  } as Awaited<ReturnType<typeof readNativeTools>>;
}

function fakeResponse() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

async function call(query: Record<string, string>) {
  const res = fakeResponse();
  await verify({ query }, res);
  return { status: res.status.mock.lastCall?.[0], body: res.json.mock.lastCall?.[0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  nativeTools.mockResolvedValue(report());
});

afterEach(() => vi.unstubAllGlobals());

describe("WebMCP verifier endpoint contracts", () => {
  it.each([
    [{}, 400, "missing"],
    [{ url: "%%%" }, 400, "invalid"],
    [{ url: "file:///etc/passwd" }, 400, "scheme"],
    [{ url: "http://169.254.169.254/latest/meta-data" }, 403, "private"],
  ] as const)("refuses invalid and private targets before rendering (%s)", async (query, status, reason) => {
    expect(await call(query)).toMatchObject({ status, body: { reason } });
    expect(nativeTools).not.toHaveBeenCalled();
  });

  it("passes a well-formed unique contract with no drift", async () => {
    const result = await call({ url: "https://example.com", expect: "search_records" });
    expect(result).toMatchObject({
      status: 200,
      body: { verdict: "pass", passed: 5, skipped: 0, findings: [],
        drift: { missing: [], added: [], exact: true } },
    });
  });

  it("rejects malformed tool schema and missing read-only annotations", async () => {
    nativeTools.mockResolvedValue(report([{
      ...goodTool,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      annotations: {},
    }]));
    const result = await call({ url: "https://example.com" });
    expect(result).toMatchObject({ status: 200, body: { verdict: "fail" } });
    expect(result.body.findings[0].issues).toEqual(expect.arrayContaining([
      expect.stringContaining("additional properties"),
      expect.stringContaining("readOnlyHint"),
    ]));
  });

  it("detects duplicate names even when each individual schema is valid", async () => {
    nativeTools.mockResolvedValue(report([goodTool, { ...goodTool, description: "Another tool." }]));
    const result = await call({ url: "https://example.com" });
    expect(result.body.verdict).toBe("fail");
    expect(result.body.checks.find((c: { id: string }) => c.id === "unique-names"))
      .toMatchObject({ pass: false, detail: "Duplicated: search_records" });
  });

  it("fails when an expected reviewed tool disappears", async () => {
    const result = await call({ url: "https://example.com", expect: "search_records,delete_all" });
    expect(result.body).toMatchObject({
      verdict: "fail",
      drift: { missing: ["delete_all"], added: [], exact: false },
    });
  });

  it("reports unreviewed new tools without claiming exact match or incorrectly failing", async () => {
    nativeTools.mockResolvedValue(report([goodTool, { ...goodTool, name: "list_records" }]));
    const result = await call({ url: "https://example.com", expect: "search_records" });
    expect(result.body).toMatchObject({
      verdict: "pass",
      drift: { missing: [], added: ["list_records"], exact: false },
    });
  });

  it("refuses to claim contract quality when the browser cannot expose schemas", async () => {
    nativeTools.mockResolvedValue({ ...report(), exposes: { inputSchema: false, annotations: false },
      tools: [{ ...goodTool, inputSchema: null, annotations: null }] } as never);
    const result = await call({ url: "https://example.com" });
    expect(result.body).toMatchObject({ verdict: "pass with gaps", skipped: 1 });
  });

  it("reports renderer unavailability without treating verification as a pass", async () => {
    nativeTools.mockResolvedValue(null);
    expect(await call({ url: "https://example.com" }))
      .toMatchObject({ status: 503, body: { reason: "renderer" } });
  });
  it("does not expose secrets from browser or network exceptions", async () => {
    const syntheticSecret = "demo-only-credential-value";
    nativeTools.mockRejectedValue(new Error(
      `Browser navigate failed for https://example.com/?token=${syntheticSecret}`,
    ));
    const result = await call({ url: "https://example.com" });
    expect(result).toMatchObject({
      status: 502,
      body: { reason: "network", detail: "The remote verification request failed." },
    });
    expect(JSON.stringify(result.body)).not.toContain(syntheticSecret);
  });

});
