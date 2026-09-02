import { describe, expect, it, vi } from "vitest";

import { registerControlPlane, type ControlPlaneSnapshot } from "./controlPlane";
import type { GraftTool, ModelContextLike } from "./lib/types";

function tool(name: string, status: GraftTool["status"], confidence: number): GraftTool {
  return {
    id: name,
    name,
    description: `does ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    recipe: "R3",
    selector: "ul",
    fallbackSelectors: [],
    action: "read",
    readOnly: status !== "held",
    destructive: status === "held",
    confidence,
    confidenceReasons: ["+20: named"],
    status,
    origin: "derived",
    binding: { kind: "collection", itemSelector: "li" },
  };
}

function fakeContext() {
  const descriptors = new Map<string, any>();
  const context = {
    registerTool: vi.fn(async (descriptor: any) => {
      descriptors.set(descriptor.name, descriptor);
    }),
    getTools: vi.fn(async () => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as ModelContextLike;
  return { context, descriptors };
}

const snapshot: ControlPlaneSnapshot = {
  sourceUrl: "https://books.toscrape.com/",
  sourceKind: "live",
  phase: "complete",
  tools: [tool("list_products", "auto", 75), tool("add_to_basket", "held", 55)],
  registeredCount: 1,
  webmcpAvailable: true,
};

function handlers(overrides: Partial<Parameters<typeof registerControlPlane>[0]> = {}) {
  return {
    read: () => snapshot,
    compileUrl: vi.fn(async () => snapshot),
    setCandidateStatus: vi.fn(async () => snapshot),
    exportAdapter: vi.fn(() => ({ fileName: "graft.js", toolCount: 2, eligible: 1 })),
    verifyUrl: vi.fn(async () => "Verdict: pass (4/4 decisive checks, 0 inconclusive)"),
    ...overrides,
  } as Parameters<typeof registerControlPlane>[0];
}

async function setup(overrides = {}) {
  const { context, descriptors } = fakeContext();
  const names = await registerControlPlane(handlers(overrides), context, new AbortController().signal);
  return { descriptors, names };
}

describe("control plane registration", () => {
  it("registers the full control surface under a graft_ prefix", async () => {
    const { names } = await setup();
    expect(names).toEqual([
      "graft_status",
      "graft_compile_url",
      "graft_list_candidates",
      "graft_inspect_candidate",
      "graft_set_candidate",
      "graft_export_adapter",
      "graft_verify_url",
    ]);
  });

  it("keeps every name and description inside the documented budgets", async () => {
    const { descriptors } = await setup();
    for (const descriptor of descriptors.values()) {
      expect(descriptor.name.length, descriptor.name).toBeLessThanOrEqual(30);
      expect(descriptor.description.length, descriptor.name).toBeLessThanOrEqual(500);
    }
  });

  it("marks only the non-mutating controls read-only", async () => {
    const { descriptors } = await setup();
    expect(descriptors.get("graft_status").annotations.readOnlyHint).toBe(true);
    expect(descriptors.get("graft_list_candidates").annotations.readOnlyHint).toBe(true);
    expect(descriptors.get("graft_inspect_candidate").annotations.readOnlyHint).toBe(true);
    expect(descriptors.get("graft_set_candidate").annotations?.readOnlyHint).toBeUndefined();
    expect(descriptors.get("graft_compile_url").annotations?.readOnlyHint).toBeUndefined();
    expect(descriptors.get("graft_verify_url").annotations.readOnlyHint).toBe(true);
  });

  it("passes an expect list through to the verifier as names", async () => {
    const verifyUrl = vi.fn(
      async () => "Verdict: pass (5/5 decisive checks, 0 inconclusive)\nExact match: yes",
    );
    const { descriptors } = await setup({ verifyUrl });
    const result = await descriptors.get("graft_verify_url").execute({
      url: "https://shop.example.com",
      expect: "list_products, get_product ,",
    });
    // Whitespace and a trailing separator must not become phantom tool names.
    expect(verifyUrl).toHaveBeenCalledWith("https://shop.example.com", [
      "list_products",
      "get_product",
    ]);
    expect(result.content[0].text).toContain("Verdict: pass (5/5 decisive checks");
    expect(result.content[0].text).toContain("Exact match: yes");
  });
});

describe("control plane behaviour", () => {
  it("reports the compiled source rather than the app's own page", async () => {
    const { descriptors } = await setup();
    const result = await descriptors.get("graft_status").execute({});
    expect(result.content[0].text).toContain("books.toscrape.com");
    expect(result.content[0].text).toContain("Registered natively: 1");
  });

  it("compiles the requested URL and returns the resulting candidates", async () => {
    const compiled: ControlPlaneSnapshot = {
      ...snapshot,
      sourceUrl: "https://www.python.org/",
      tools: [tool("search_this_site", "auto", 86)],
      registeredCount: 1,
    };
    const compileUrl = vi.fn(async () => compiled);
    const { descriptors } = await setup({ compileUrl });

    const result = await descriptors.get("graft_compile_url").execute({
      url: "  https://www.python.org/  ",
    });

    expect(compileUrl).toHaveBeenCalledWith("https://www.python.org/");
    expect(result.content[0].text).toContain("Compiled source: https://www.python.org/");
    expect(result.content[0].text).toContain(
      "search_this_site | auto | confidence 86 | R3 | read-only",
    );
  });

  it("filters candidates by status", async () => {
    const { descriptors } = await setup();
    const held = await descriptors.get("graft_list_candidates").execute({ status: "held" });
    expect(held.content[0].text).toContain("add_to_basket");
    expect(held.content[0].text).not.toContain("list_products");
  });

  it("returns the scored evidence when inspecting a candidate", async () => {
    const { descriptors } = await setup();
    const result = await descriptors.get("graft_inspect_candidate").execute({ name: "add_to_basket" });
    expect(result.content[0].text).toContain("confidence 55");
    expect(result.content[0].text).toContain("+20: named");
  });

  it("reports a refused status change instead of throwing at the agent", async () => {
    const setCandidateStatus = vi.fn(async () => {
      throw new Error("add_to_basket was rejected by the confidence gate and cannot be published.");
    });
    const { descriptors } = await setup({ setCandidateStatus });
    const result = await descriptors.get("graft_set_candidate").execute({
      name: "add_to_basket",
      status: "published",
    });
    expect(result.content[0].text).toContain("cannot be published");
  });

  it("changes a candidate status and reports the live registration count", async () => {
    const published: ControlPlaneSnapshot = {
      ...snapshot,
      tools: [tool("list_products", "auto", 75), tool("add_to_basket", "published", 55)],
      registeredCount: 2,
    };
    const setCandidateStatus = vi.fn(async () => published);
    const { descriptors } = await setup({ setCandidateStatus });

    const result = await descriptors.get("graft_set_candidate").execute({
      name: "add_to_basket",
      status: "published",
    });

    expect(setCandidateStatus).toHaveBeenCalledWith("add_to_basket", "published");
    expect(result.content[0].text).toBe(
      "add_to_basket is now published. 2 tools registered natively.",
    );
  });

  it("exports the reviewed adapter and reports its eligibility totals", async () => {
    const { descriptors } = await setup({
      exportAdapter: () => ({
        fileName: "graft-books.adapter.js",
        toolCount: 5,
        eligible: 3,
      }),
    });

    const result = await descriptors.get("graft_export_adapter").execute({});

    expect(result.content[0].text).toBe(
      "Exported graft-books.adapter.js. 3 of 5 candidates are eligible to register; the rest are held or rejected and are included as reviewed metadata only.",
    );
  });

  it("never exceeds the tool output budget", async () => {
    const many = { ...snapshot, tools: Array.from({ length: 200 }, (_, i) => tool(`list_thing_${i}`, "auto", 90)) };
    const { descriptors } = await setup({ read: () => many });
    const result = await descriptors.get("graft_list_candidates").execute({});
    expect(result.content[0].text.length).toBeLessThanOrEqual(1500);
    expect(result.content[0].text).toContain("truncated");
  });
});
