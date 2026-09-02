import { describe, expect, it, vi } from "vitest";
import {
  buildAdapterModule,
  registerExportedTools,
  type GraftExportDescriptor,
  type GraftExportHandler,
  type GraftExportModelContext,
  type GraftExportTool,
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

interface GeneratedAdapterModule {
  registerGraftTools(options?: {
    handlers?: Readonly<Record<string, GraftExportHandler | undefined>>;
    confirm?: (request: {
      tool: GraftExportTool;
      args: Record<string, unknown>;
      target: Element | null;
      signal?: AbortSignal;
    }) => boolean | Promise<boolean>;
  }): Promise<{ registered: string[]; cleanup: () => Promise<void> }>;
}

async function importGeneratedAdapter(tools: readonly GraftExportDescriptor[]) {
  const runtime = [
    "var GraftRuntime = {",
    "  createGraftHandlers() { return {}; },",
    "};",
  ].join("\n");
  const source = buildAdapterModule({ product: "Graft" }, tools, runtime);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${crypto.randomUUID()}`;
  return import(/* @vite-ignore */ url) as Promise<GeneratedAdapterModule>;
}

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

  it("rejects invalid arguments before a directly registered owner handler runs", async () => {
    let execute: GraftExportHandler | undefined;
    let calls = 0;
    const descriptor: GraftExportDescriptor = {
      name: "get_product",
      description: "Return one product by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    };
    const report = await registerExportedTools(
      {
        registerTool: (registered) => {
          execute = registered.execute;
        },
      },
      [descriptor],
      {
        get_product: async () => {
          calls += 1;
          return { ok: true, message: "owner handler ran" };
        },
      },
    );

    expect(report.registered).toEqual(["get_product"]);
    await expect(execute?.({ id: "palm-relay", invented: true }, {})).rejects.toThrow(
      "$.invented is not allowed",
    );
    expect(calls).toBe(0);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "rejects the undeclared prototype-shaped key %s before a directly registered handler runs",
    async (key) => {
      let execute: GraftExportHandler | undefined;
      let calls = 0;
      const descriptor: GraftExportDescriptor = {
        name: "get_product",
        description: "Return one product by ID.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      };
      await registerExportedTools(
        { registerTool: (registered) => { execute = registered.execute; } },
        [descriptor],
        {
          get_product: async () => {
            calls += 1;
            return { ok: true, message: "owner handler ran" };
          },
        },
      );
      const args = JSON.parse(`{"id":"palm-relay","${key}":"smuggled"}`) as Record<string, unknown>;

      await expect(execute?.(args, {})).rejects.toThrow(`$.${key} is not allowed`);
      expect(calls).toBe(0);
    },
  );

  it("validates generated-adapter overrides before calling owner code", async () => {
    const tool: GraftExportDescriptor = {
      name: "get_product",
      description: "Return one product by ID.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    };
    let registered: (GraftExportDescriptor & { execute: GraftExportHandler }) | undefined;
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        modelContext: {
          registerTool(descriptor: GraftExportDescriptor & { execute: GraftExportHandler }) {
            registered = descriptor;
          },
        },
      },
    });

    try {
      const adapter = await importGeneratedAdapter([tool]);
      const report = await adapter.registerGraftTools({
        handlers: {
          get_product: async (_args, context) => {
            calls += 1;
            receivedSignal = context.signal;
            return { ok: true, message: "owner handler ran" };
          },
        },
      });
      expect(report.registered).toEqual(["get_product"]);

      await expect(registered?.execute({ id: 42 }, {})).rejects.toMatchObject({
        name: "ToolArgumentValidationError",
        message: expect.stringContaining("$.id must be string"),
        issues: [
          expect.objectContaining({
            path: "$.id",
            code: "wrong_type",
          }),
        ],
      });
      await expect(
        registered?.execute({ id: "palm-relay", invented: true }, {}),
      ).rejects.toThrow("$.invented is not allowed");
      for (const key of ["constructor", "toString", "__proto__"]) {
        const args = JSON.parse(`{"id":"palm-relay","${key}":"smuggled"}`) as Record<string, unknown>;
        await expect(registered?.execute(args, {})).rejects.toThrow(`$.${key} is not allowed`);
      }
      expect(calls).toBe(0);

      const controller = new AbortController();
      await expect(
        registered?.execute({ id: "palm-relay" }, { signal: controller.signal }),
      ).resolves.toEqual({ ok: true, message: "owner handler ran" });
      expect(calls).toBe(1);
      expect(receivedSignal).toBe(controller.signal);
      await report.cleanup();
    } finally {
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("fails closed, respects rejection and requires approval before a destructive override", async () => {
    const tool: GraftExportTool = {
      name: "apply_patch",
      description: "Apply one reviewed patch after an explicit human decision.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      destructive: true,
    };
    let registered: (GraftExportDescriptor & { execute: GraftExportHandler }) | undefined;
    let handlerCalls = 0;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        modelContext: {
          registerTool(descriptor: GraftExportDescriptor & { execute: GraftExportHandler }) {
            registered = descriptor;
          },
          unregisterTool() {},
        },
      },
    });

    try {
      const adapter = await importGeneratedAdapter([tool]);
      const ownerHandler: GraftExportHandler = async () => {
        handlerCalls += 1;
        return { ok: true, message: "owner mutation ran" };
      };

      const blockedReport = await adapter.registerGraftTools({
        handlers: { apply_patch: ownerHandler },
      });
      await expect(registered?.execute({ target: "PATCH-104" }, {})).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          message: "Blocked: this tool requires explicit in-page confirmation.",
        },
      });
      expect(handlerCalls).toBe(0);
      await blockedReport.cleanup();

      const reject = vi.fn(async () => false);
      const rejectedReport = await adapter.registerGraftTools({
        handlers: { apply_patch: ownerHandler },
        confirm: reject,
      });
      await expect(registered?.execute({ target: "PATCH-104" }, {})).resolves.toMatchObject({
        isError: true,
        structuredContent: { ok: false, message: "Cancelled: the user did not confirm." },
      });
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({
        tool: expect.objectContaining({ name: "apply_patch", destructive: true }),
        args: { target: "PATCH-104" },
        target: null,
      }));
      expect(handlerCalls).toBe(0);
      await rejectedReport.cleanup();

      const approve = vi.fn(async () => true);
      const approvedReport = await adapter.registerGraftTools({
        handlers: { apply_patch: ownerHandler },
        confirm: approve,
      });
      await expect(registered?.execute({ target: "PATCH-104" }, {})).resolves.toEqual({
        ok: true,
        message: "owner mutation ran",
      });
      expect(approve).toHaveBeenCalledOnce();
      expect(handlerCalls).toBe(1);
      await approvedReport.cleanup();
    } finally {
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
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

  it("describes generated viewport effects without calling them held writes", () => {
    const source = buildAdapterModule(
      { product: "Graft" },
      [
        {
          name: "show_capability",
          description: "Move the current page to one compiled section.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          action: "local_navigation",
          destructive: false,
        },
      ],
      "var GraftRuntime = {};",
    );

    expect(source).toContain("Local page effects: show_capability");
    expect(source).toContain("No exported tool performs a consequential mutation");
    expect(source).not.toContain("Held until you opt in");
  });
});
