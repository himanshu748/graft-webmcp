import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import catalogHtml from "../data/fixtureHtml/catalog.html?raw";
import dataTableHtml from "../data/fixtureHtml/data-table.html?raw";
import fieldGuideHtml from "../data/fixtureHtml/field-guide.html?raw";
import { compileDocument, deriveTools, toolSetFingerprint } from "./derive";
import { coerceToolArguments } from "./arguments";
import { executeTool } from "./execute";
import type {
  GraftLifecycleEvent,
  GraftTool,
  ModelContextLike,
  ModelContextToolDescriptor,
} from "./types";
import { WebMCPRegistry } from "./webmcp";

function fixtureDocument(html: string, path: string): Document {
  return new JSDOM(html, { url: `https://graft.test${path}` }).window.document;
}

class FakeModelContext extends EventTarget implements ModelContextLike {
  descriptors = new Map<string, ModelContextToolDescriptor>();
  registrationSignals: AbortSignal[] = [];

  registerTool = vi.fn(
    async (descriptor: ModelContextToolDescriptor, options?: { signal?: AbortSignal }) => {
      this.descriptors.set(descriptor.name, descriptor);
      if (options?.signal) {
        this.registrationSignals.push(options.signal);
        options.signal.addEventListener(
          "abort",
          () => this.descriptors.delete(descriptor.name),
          { once: true },
        );
      }
    },
  );

  unregisterTool = vi.fn(async (name: string) => {
    this.descriptors.delete(name);
  });

  getTools = vi.fn(async () => [...this.descriptors.values()]);
}

class DelayedUnregisterModelContext extends EventTarget implements ModelContextLike {
  descriptors = new Map<string, ModelContextToolDescriptor>();
  events: string[] = [];
  private releaseCleanup: (() => void) | null = null;
  private readonly cleanupGate = new Promise<void>((resolve) => {
    this.releaseCleanup = resolve;
  });

  async registerTool(descriptor: ModelContextToolDescriptor): Promise<void> {
    this.events.push(`register:${descriptor.name}`);
    this.descriptors.set(descriptor.name, descriptor);
  }

  async unregisterTool(name: string): Promise<void> {
    this.events.push(`unregister:start:${name}`);
    await this.cleanupGate;
    this.events.push(`unregister:finish:${name}`);
    this.descriptors.delete(name);
  }

  release(): void {
    this.releaseCleanup?.();
  }
}

describe("Graft compiler", () => {
  it("derives deterministic fixture contracts with stable record tools", () => {
    const catalog = compileDocument(fixtureDocument(catalogHtml, "/fixtures/catalog.html"));
    const guide = compileDocument(fixtureDocument(fieldGuideHtml, "/fixtures/field-guide.html"));
    const ledger = compileDocument(fixtureDocument(dataTableHtml, "/fixtures/data-table.html"));

    expect(catalog.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "search_catalog",
        "list_products",
        "get_product",
        "add_to_demo_cart",
      ]),
    );
    expect(guide.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["search_field_guide", "list_entries", "read_entry"]),
    );
    expect(ledger.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["filter_batches", "list_batches", "get_batch"]),
    );

    const mutation = catalog.tools.find((tool) => tool.name === "add_to_demo_cart");
    expect(mutation).toMatchObject({ status: "held", readOnly: false, destructive: true });
    expect(toolSetFingerprint(catalog.tools)).toBe(
      toolSetFingerprint(deriveTools(fixtureDocument(catalogHtml, "/fixtures/catalog.html"))),
    );
  });

  it("executes collection reads as bounded JSON", async () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const tool = deriveTools(document).find((candidate) => candidate.name === "list_products");
    expect(tool).toBeDefined();

    const result = await executeTool(tool as GraftTool, { offset: 0, limit: 2 }, { root: document });
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeLessThanOrEqual(1_500);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_500);
    expect(result.data?.total).toBe(6);
    expect(result.data?.hasMore).toBe(true);
  });

  it("preserves the complete six-record demo proof within an explicit bound", async () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const tool = deriveTools(document).find((candidate) => candidate.name === "list_products");

    const result = await executeTool(
      tool as GraftTool,
      { offset: 0, limit: 10 },
      { root: document, maxOutputChars: 8_000 },
    );
    const rows = result.data?.rows;

    expect(Array.isArray(rows) ? rows : []).toHaveLength(6);
    expect(JSON.stringify(rows)).toContain("cable-dock-8");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(8_000);
  });

  it("filters inert fixture rows locally and returns only matching structured rows", async () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const tools = deriveTools(document);
    const tool = tools.find((candidate) => candidate.name === "search_catalog");
    const listTool = tools.find((candidate) => candidate.name === "list_products");
    expect(tool).toBeDefined();

    const result = await executeTool(
      tool as GraftTool,
      { query: "Palm", category: "all", in_stock: true },
      { root: document, settleQuietMs: 0 },
    );
    expect(result).toMatchObject({ ok: true, data: { matched: 1, total: 6 } });
    expect(document.querySelectorAll("[role='listitem'][hidden]")).toHaveLength(5);
    expect(JSON.stringify(result.data?.rows)).toContain("Palm Relay");
    const listed = await executeTool(listTool as GraftTool, {}, { root: document });
    expect(listed.data?.total).toBe(1);

    const ledgerDocument = fixtureDocument(dataTableHtml, "/fixtures/data-table.html");
    const filterTool = deriveTools(ledgerDocument).find(
      (candidate) => candidate.name === "filter_batches",
    );
    const filtered = await executeTool(
      filterTool as GraftTool,
      { status: "ready" },
      { root: ledgerDocument, settleQuietMs: 0 },
    );
    expect(filtered).toMatchObject({ ok: true, data: { matched: 5, total: 8 } });
  });

  it("fails closed then applies the allowlisted local cart mutation after confirmation", async () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const tool = deriveTools(document).find((candidate) => candidate.name === "add_to_demo_cart");
    expect(tool).toBeDefined();

    const blocked = await executeTool(
      tool as GraftTool,
      { product_id: "palm-relay", quantity: 2 },
      { root: document },
    );
    expect(blocked).toMatchObject({ ok: false });
    expect(document.querySelector("output")?.textContent).toContain("Cart is empty");

    const confirmed = await executeTool(
      tool as GraftTool,
      { product_id: "palm-relay", quantity: 2 },
      { root: document, confirm: async () => true },
    );
    expect(confirmed).toMatchObject({ ok: true });
    expect(document.querySelector("output")?.textContent).toContain("2 × Palm Relay");

    await expect(
      executeTool(
        tool as GraftTool,
        { product_id: "not-allowlisted", quantity: 1 },
        { root: document, confirm: async () => true },
      ),
    ).rejects.toThrow("$.product_id must be one of");

    const controller = new AbortController();
    const pending = executeTool(
      tool as GraftTool,
      { product_id: "palm-relay", quantity: 1 },
      {
        root: document,
        signal: controller.signal,
        confirm: () => new Promise<boolean>(() => undefined),
      },
    );
    controller.abort(new DOMException("User cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("tool argument validation", () => {
  const setup = () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const tools = deriveTools(document);
    return {
      document,
      list: tools.find((tool) => tool.name === "list_products") as GraftTool,
      mutation: tools.find((tool) => tool.name === "add_to_demo_cart") as GraftTool,
      summary: tools.find((tool) => tool.name === "get_page_summary") as GraftTool,
    };
  };

  it("rejects missing required values before confirmation", async () => {
    const { document, mutation } = setup();
    const confirm = vi.fn(async () => true);
    await expect(
      executeTool(mutation, { product_id: "palm-relay" }, { root: document, confirm }),
    ).rejects.toThrow("$.quantity is required");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects partial and malformed numeric text before confirmation", async () => {
    const { document, mutation } = setup();
    const confirm = vi.fn(async () => true);

    for (const quantity of ["1junk", "-", "1.5"]) {
      const args = coerceToolArguments(mutation, {
        product_id: "palm-relay",
        quantity,
      });
      expect(Number.isNaN(args.quantity)).toBe(true);
      await expect(executeTool(mutation, args, { root: document, confirm })).rejects.toThrow(
        "$.quantity must be integer",
      );
    }

    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects wrong JSON Schema types instead of coercing them", async () => {
    const { document, list } = setup();
    await expect(executeTool(list, { limit: "2" }, { root: document })).rejects.toThrow(
      "$.limit must be integer",
    );
  });

  it("rejects values outside an enum", async () => {
    const { document, mutation } = setup();
    await expect(
      executeTool(
        mutation,
        { product_id: "not-allowlisted", quantity: 1 },
        { root: document, confirm: async () => true },
      ),
    ).rejects.toThrow("$.product_id must be one of");
  });

  it("rejects numeric values outside minimum and maximum bounds", async () => {
    const { document, list, mutation } = setup();
    await expect(executeTool(list, { limit: 0 }, { root: document })).rejects.toThrow(
      "$.limit must be at least 1",
    );
    await expect(
      executeTool(
        mutation,
        { product_id: "palm-relay", quantity: 4 },
        { root: document, confirm: async () => true },
      ),
    ).rejects.toThrow("$.quantity must be at most 3");
  });

  it("rejects extra properties when additionalProperties is false", async () => {
    const { document, summary } = setup();
    await expect(
      executeTool(summary, { invented: true }, { root: document }),
    ).rejects.toThrow("$.invented is not allowed");
  });
});

describe("WebMCP registry", () => {
  it("registers approved tools with safety annotations and aborts replaced registrations", async () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const tools = deriveTools(document);
    const context = new FakeModelContext();
    const events: GraftLifecycleEvent[] = [];
    const registry = new WebMCPRegistry({
      modelContext: context,
      root: document,
      onEvent: (event) => events.push(event),
    });

    const first = await registry.register(tools);
    expect(first.registered).toContain("list_products");
    expect(first.skipped).toContain("add_to_demo_cart");
    expect(context.descriptors.get("list_products")?.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    const firstSignal = context.registrationSignals[0];

    await registry.replace(tools);
    expect(firstSignal?.aborted).toBe(true);
    const descriptor = context.descriptors.get("list_products");
    const execution = await descriptor?.execute({ offset: 0, limit: 1 });
    expect(execution?.ok).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "execution_finished",
          name: "list_products",
          args: { offset: 0, limit: 1 },
          status: "success",
          result: expect.objectContaining({ ok: true }),
        }),
      ]),
    );
    await registry.dispose();
  });

  it("waits for delayed cleanup from an older registry before reusing tool names", async () => {
    const document = fixtureDocument(catalogHtml, "/fixtures/catalog.html");
    const summary = deriveTools(document).find(
      (candidate) => candidate.name === "get_page_summary",
    ) as GraftTool;
    const context = new DelayedUnregisterModelContext();
    const firstRegistry = new WebMCPRegistry({ modelContext: context, root: document });
    await firstRegistry.register([summary]);

    const disposal = firstRegistry.dispose();
    expect(firstRegistry.dispose()).toBe(disposal);
    const secondRegistry = new WebMCPRegistry({ modelContext: context, root: document });
    const secondRegistration = secondRegistry.register([summary]);
    await Promise.resolve();
    await Promise.resolve();

    expect(context.events).toEqual([
      "register:get_page_summary",
      "unregister:start:get_page_summary",
    ]);
    expect(context.descriptors.get("get_page_summary")).toBeDefined();

    context.release();
    await Promise.all([disposal, secondRegistration]);
    expect(context.events).toEqual([
      "register:get_page_summary",
      "unregister:start:get_page_summary",
      "unregister:finish:get_page_summary",
      "register:get_page_summary",
    ]);
    expect(context.descriptors.get("get_page_summary")).toBeDefined();
    await secondRegistry.dispose();
  });
});
