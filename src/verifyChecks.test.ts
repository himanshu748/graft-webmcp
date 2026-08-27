import { describe, expect, it } from "vitest";
import { inspectTool } from "../api/verify";

const exposes = { inputSchema: true, annotations: true };

function tool(overrides: Record<string, unknown> = {}) {
  return {
    name: "list_products",
    description: "List the products on this page.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many rows." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    ...overrides,
  } as Parameters<typeof inspectTool>[0];
}

describe("contract checker accepts a sound contract", () => {
  it("finds nothing wrong with a well formed tool", () => {
    expect(inspectTool(tool(), exposes).issues).toEqual([]);
  });
});

describe("contract checker catches real defects", () => {
  it("flags a name over the 30 character budget", () => {
    const issues = inspectTool(tool({ name: "a".repeat(31) }), exposes).issues;
    expect(issues.some((issue) => issue.includes("over 30"))).toBe(true);
  });

  it("flags a name that is not snake_case", () => {
    const issues = inspectTool(tool({ name: "ListProducts" }), exposes).issues;
    expect(issues.some((issue) => issue.includes("snake_case"))).toBe(true);
  });

  it("flags a description over the 500 character budget", () => {
    const issues = inspectTool(tool({ description: "x".repeat(501) }), exposes).issues;
    expect(issues.some((issue) => issue.includes("over 500"))).toBe(true);
  });

  it("flags a schema that permits additional properties", () => {
    const issues = inspectTool(
      tool({ inputSchema: { type: "object", properties: {}, additionalProperties: true } }),
      exposes,
    ).issues;
    expect(issues.some((issue) => issue.includes("additional properties"))).toBe(true);
  });

  it("flags a parameter with no description or type", () => {
    const issues = inspectTool(
      tool({
        inputSchema: { type: "object", properties: { limit: {} }, additionalProperties: false },
      }),
      exposes,
    ).issues;
    expect(issues.some((issue) => issue.includes('parameter "limit" has no description'))).toBe(true);
    expect(issues.some((issue) => issue.includes('parameter "limit" declares no type'))).toBe(true);
  });

  it("flags a missing readOnlyHint when the browser does expose annotations", () => {
    const issues = inspectTool(tool({ annotations: {} }), exposes).issues;
    expect(issues.some((issue) => issue.includes("readOnlyHint"))).toBe(true);
  });

  it("stays silent about annotations the browser never exposes", () => {
    const issues = inspectTool(tool({ annotations: null }), {
      inputSchema: true,
      annotations: false,
    }).issues;
    expect(issues.some((issue) => issue.includes("readOnlyHint"))).toBe(false);
  });

  it("never asserts a schema is missing, since a listing may omit it", () => {
    const issues = inspectTool(tool({ inputSchema: null }), exposes).issues;
    expect(issues.some((issue) => issue.toLowerCase().includes("schema"))).toBe(false);
  });
});
