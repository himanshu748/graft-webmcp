import { describe, expect, it, vi } from "vitest";
import {
  buildAdapterModule,
  registerExportedTools,
  type GraftExportDescriptor,
  type GraftExportModelContext,
} from "./export-adapter";

const descriptors: GraftExportDescriptor[] = [
  {
    name: "list_products",
    description: "Return the structured product collection for the owner site.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_product",
    description: "Return one structured product from the owner site by ID.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const handler = async () => ({ ok: true, message: "ok" });

describe("exported adapter registration", () => {
  it("awaits delayed registrations before reporting success", async () => {
    let releaseFirst: (() => void) | undefined;
    const registerTool = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const pending = registerExportedTools(
      { registerTool },
      descriptors.slice(0, 1),
      { list_products: handler },
    );

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFirst?.();
    const report = await pending;
    expect(report.registered).toEqual(["list_products"]);
    expect(report.failures).toEqual([]);
  });

  it("rolls back earlier registrations when a later registration rejects", async () => {
    const unregisterTool = vi.fn(async () => undefined);
    const seenSignals: AbortSignal[] = [];
    const modelContext: GraftExportModelContext = {
      registerTool: vi.fn(async (descriptor, options) => {
        if (options?.signal) seenSignals.push(options.signal);
        if (descriptor.name === "get_product") throw new Error("native rejection");
      }),
      unregisterTool,
    };

    const report = await registerExportedTools(modelContext, descriptors, {
      list_products: handler,
      get_product: handler,
    });

    expect(report).toMatchObject({
      registered: [],
      failures: [{ name: "get_product", error: "native rejection" }],
      rolledBack: ["list_products"],
    });
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
    expect(unregisterTool).toHaveBeenCalledWith("list_products");
  });

  it("emits an async owner adapter with cleanup and rollback reporting", () => {
    const source = buildAdapterModule({ product: "Graft" }, descriptors, "var GraftRuntime = {};");
    expect(source).toContain("export async function registerGraftTools");
    expect(source).toContain("await modelContext.registerTool");
    expect(source).toContain("await cleanup()");
    expect(source).toContain("rolledBack");
  });

  it("inlines the runtime and wires handlers without owner code", () => {
    const source = buildAdapterModule({ product: "Graft" }, descriptors, "var GraftRuntime = {};");
    expect(source).toContain("var GraftRuntime = {};");
    expect(source).toContain("GraftRuntime.createGraftHandlers(graftTools, runtimeOptions)");
    // Owner overrides must win over the generated handler for the same name.
    expect(source).toContain("const handlers = { ...generated, ...overrides };");
    expect(source).not.toContain("Pass owner-implemented handlers");
  });
});
