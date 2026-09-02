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

  it("compiles an explicit semantic section group into list and viewport tools", async () => {
    const document = fixtureDocument(
      `<!doctype html><html><head><title>Owner product</title></head><body>
        <main id="product-surface">
          <h1>Owner product</h1>
          <section id="file-search" data-graft-section="capability">
            <h2>Search local files</h2>
            <p data-graft-ignore data-field="summary">ignored-summary-secret</p>
            <p data-field="summary">Find notes <span hidden>hidden-child-secret</span><span aria-hidden="true">aria-child-secret</span><span style="display:none">css-child-secret</span> and screenshots without uploading them.</p>
            <span hidden data-field="token">signed-secret-url</span>
            <ul><li>PDF</li><li>Image</li><li>Code</li></ul>
          </section>
          <section id="local-mcp" data-graft-section="capability">
            <h2>Connect local MCP</h2>
            <p data-field="summary">Offer local tools to compatible desktop clients.</p>
            <ul><li>Search</li><li>Read</li><li>Ask</li></ul>
          </section>
          <section id="agent-mode" data-graft-section="capability">
            <h2>Run guarded tasks</h2>
            <p data-field="summary">Edit code and run tests behind explicit safety checks.</p>
            <ul><li>Read</li><li>Edit</li><li>Test</li></ul>
          </section>
        </main>
        <aside data-graft-ignore>
          <h2>Internal controls</h2>
          <ul><li>One</li><li>Two</li><li>Three</li></ul>
          <button>Delete internal state</button>
        </aside>
      </body></html>`,
      "/semantic-owner.html",
    );

    const compilation = compileDocument(document);
    expect(compilation.tools.map((tool) => tool.name)).toEqual([
      "get_page_summary",
      "get_page_outline",
      "list_capabilities",
      "show_capability",
    ]);

    const list = compilation.tools.find((tool) => tool.name === "list_capabilities") as GraftTool;
    const show = compilation.tools.find((tool) => tool.name === "show_capability") as GraftTool;
    expect(list).toMatchObject({ recipe: "R8", status: "auto", readOnly: true });
    expect(show).toMatchObject({
      recipe: "R8",
      status: "auto",
      readOnly: false,
      destructive: false,
      inputSchema: {
        properties: {
          id: { enum: ["file-search", "local-mcp", "agent-mode"] },
        },
      },
    });

    const listed = await executeTool(list, { limit: 10 }, { root: document });
    expect(listed.data).toMatchObject({ total: 3, hasMore: false });
    expect(listed.data?.rows).toEqual([
      expect.objectContaining({
        id: "file-search",
        title: "Search local files",
        summary: "Find notes and screenshots without uploading them.",
      }),
      expect.objectContaining({ id: "local-mcp", title: "Connect local MCP" }),
      expect.objectContaining({ id: "agent-mode", title: "Run guarded tasks" }),
    ]);
    expect(JSON.stringify(listed.data?.rows)).not.toContain("signed-secret-url");
    expect(JSON.stringify(listed.data?.rows)).not.toContain("ignored-summary-secret");
    expect(JSON.stringify(listed.data?.rows)).not.toContain("hidden-child-secret");
    expect(JSON.stringify(listed.data?.rows)).not.toContain("aria-child-secret");
    expect(JSON.stringify(listed.data?.rows)).not.toContain("css-child-secret");

    const target = document.getElementById("local-mcp") as HTMLElement;
    const scrollIntoView = vi.fn();
    Object.defineProperty(document.defaultView?.Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const urlBefore = document.location.href;
    const shown = await executeTool(show, { id: "local-mcp" }, { root: document });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(shown).toMatchObject({
      ok: true,
      data: { section: { id: "local-mcp", title: "Connect local MCP" } },
    });
    expect(document.location.href).toBe(urlBefore);

    await expect(executeTool(show, { id: "unknown" }, { root: document })).rejects.toThrow();

    const injected = document.createElement("section");
    injected.id = "injected";
    injected.setAttribute("data-graft-section", "capability");
    injected.innerHTML = "<h2>Injected</h2><p>Not in the compiled allowlist.</p>";
    document.getElementById("product-surface")?.append(injected);
    const afterInjection = await executeTool(list, { limit: 10 }, { root: document });
    expect(afterInjection.data?.total).toBe(3);
    expect(JSON.stringify(afterInjection.data?.rows)).not.toContain("injected");
    injected.remove();

    target.removeAttribute("data-graft-section");
    await expect(executeTool(show, { id: "local-mcp" }, { root: document })).rejects.toThrow(
      "no longer matches its contract",
    );

    target.setAttribute("data-graft-section", "capability");
    scrollIntoView.mockClear();
    const duplicate = document.createElement("div");
    duplicate.id = "local-mcp";
    document.body.append(duplicate);
    await expect(executeTool(show, { id: "local-mcp" }, { root: document })).rejects.toThrow(
      "no longer matches its contract",
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    duplicate.remove();
    target.querySelector("h2")?.remove();
    await expect(executeTool(list, { limit: 10 }, { root: document })).rejects.toThrow(
      "lost its heading or summary",
    );
  });

  it("keeps separate semantic groups and unrelated repeated collections", () => {
    const document = fixtureDocument(
      `<!doctype html><html><head><title>Mixed owner page</title></head><body>
        <main id="mixed-surface">
          <section id="cap-one" data-graft-section="capability"><h2>Capability one</h2><p>First capability.</p></section>
          <section id="cap-two" data-graft-section="capability"><h2>Capability two</h2><p>Second capability.</p></section>
          <article class="product" data-product-id="p1"><h2>Product one</h2></article>
          <article class="product" data-product-id="p2"><h2>Product two</h2></article>
          <article class="product" data-product-id="p3"><h2>Product three</h2></article>
        </main>
        <aside id="secondary-surface">
          <section id="cap-three" data-graft-section="capability"><h2>Capability three</h2><p>Third capability.</p></section>
          <section id="cap-four" data-graft-section="capability"><h2>Capability four</h2><p>Fourth capability.</p></section>
        </aside>
      </body></html>`,
      "/mixed-owner.html",
    );

    const tools = deriveTools(document);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_capabilities",
        "show_capability",
        "list_capabilities_2",
        "show_capability_2",
        "list_products",
        "get_product",
      ]),
    );
    expect(tools.find((tool) => tool.name === "show_capability")?.status).toBe("auto");
    expect(tools.find((tool) => tool.name === "show_capability_2")?.status).toBe("auto");
  });

  it("bounds explicit section-group discovery on adversarial markup", () => {
    const groups = Array.from({ length: 100 }, (_, index) => `
      <div id="group-${index}">
        <section id="section-${index}-a" data-graft-section="capability"><h2>First ${index}</h2><p>First summary.</p></section>
        <section id="section-${index}-b" data-graft-section="capability"><h2>Second ${index}</h2><p>Second summary.</p></section>
      </div>`).join("");
    const document = fixtureDocument(
      `<!doctype html><html><head><title>Bounded groups</title></head><body><main>${groups}</main></body></html>`,
      "/bounded-groups.html",
    );

    const compilation = compileDocument(document);
    expect(compilation.snapshot.sectionGroups).toHaveLength(6);
    expect(compilation.tools.filter((tool) => tool.recipe === "R8")).toHaveLength(12);
  });

  it("bounds semantic text traversal on deeply nested owner markup", async () => {
    const deepSummary = `Bounded summary. ${"<span>".repeat(1_200)}tail-over-budget${"</span>".repeat(1_200)}`;
    const document = fixtureDocument(
      `<!doctype html><html><head><title>Deep owner page</title></head><body>
        <main id="deep-surface">
          <section id="deep-one" data-graft-section="capability">
            <h2>Deep capability</h2>
            <p data-field="summary">${deepSummary}</p>
          </section>
          <section id="deep-two" data-graft-section="capability">
            <h2>Second capability</h2>
            <p data-field="summary">A normal summary.</p>
          </section>
        </main>
      </body></html>`,
      "/deep-owner.html",
    );
    const getComputedStyle = vi
      .spyOn(document.defaultView as Window, "getComputedStyle")
      .mockReturnValue({ display: "block", visibility: "visible" } as CSSStyleDeclaration);

    const compilation = compileDocument(document);
    expect(compilation.snapshot.sectionGroups).toHaveLength(1);
    expect(getComputedStyle.mock.calls.length).toBeLessThan(900);

    const list = compilation.tools.find((tool) => tool.name === "list_capabilities") as GraftTool;
    getComputedStyle.mockClear();
    const listed = await executeTool(list, { limit: 10 }, { root: document });
    expect(getComputedStyle.mock.calls.length).toBeLessThan(900);
    expect(listed.data?.rows).toEqual([
      expect.objectContaining({
        id: "deep-one",
        title: "Deep capability",
        summary: "Bounded summary.",
      }),
      expect.objectContaining({ id: "deep-two", summary: "A normal summary." }),
    ]);
    expect(JSON.stringify(listed.data?.rows)).not.toContain("tail-over-budget");
  });

  it("bounds semantic field discovery across deep candidate amplification", async () => {
    const document = fixtureDocument(
      `<!doctype html><html><head><title>Deep wrappers</title></head><body>
        <main id="wrapper-surface">
          <section id="wrapped-one" data-graft-section="capability">
            <h2>Wrapped capability</h2><p>Wrapped summary.</p>
          </section>
          <section id="wrapped-two" data-graft-section="capability">
            <h2>Second capability</h2><p>Second summary.</p>
          </section>
        </main>
      </body></html>`,
      "/deep-wrappers.html",
    );
    const initial = compileDocument(document);
    const list = initial.tools.find((tool) => tool.name === "list_capabilities") as GraftTool;
    expect(list).toBeDefined();

    const section = document.getElementById("wrapped-one") as HTMLElement;
    const wrapperRoot = document.createElement("div");
    let deepest = wrapperRoot;
    for (let depth = 0; depth < 150; depth += 1) {
      const wrapper = document.createElement("div");
      deepest.append(wrapper);
      deepest = wrapper;
    }
    for (let candidate = 0; candidate < 300; candidate += 1) {
      const heading = document.createElement("h2");
      heading.textContent = `Invalid heading ${candidate}`;
      const summary = document.createElement("p");
      summary.setAttribute("data-field", "summary");
      summary.textContent = `Invalid summary ${candidate}`;
      deepest.append(heading, summary);
    }
    [...section.children].forEach((child) => deepest.append(child));
    section.append(wrapperRoot);

    const getComputedStyle = vi
      .spyOn(document.defaultView as Window, "getComputedStyle")
      .mockReturnValue({ display: "block", visibility: "visible" } as CSSStyleDeclaration);
    const bounded = compileDocument(document);
    expect(bounded.snapshot.sectionGroups).toHaveLength(0);
    expect(getComputedStyle.mock.calls.length).toBeLessThan(700);

    getComputedStyle.mockClear();
    await expect(executeTool(list, { limit: 10 }, { root: document })).rejects.toThrow(
      "lost its heading or summary",
    );
    expect(getComputedStyle.mock.calls.length).toBeLessThan(250);
  });

  it("holds a detail contract when its required list contract is not eligible", () => {
    const document = fixtureDocument(
      `<!doctype html><html><head><title>Ambiguous records</title></head><body>
        <main><div id="machine-records">
          <div class="machine-record" data-machine-id="one"></div>
          <div class="machine-record" data-machine-id="two"></div>
          <div class="machine-record" data-machine-id="three"></div>
        </div></main>
      </body></html>`,
      "/ambiguous-records.html",
    );

    const tools = deriveTools(document);
    const list = tools.find((tool) => tool.name === "list_machines");
    const detail = tools.find((tool) => tool.name === "get_machine");
    expect(list?.status).toBe("held");
    expect(detail?.status).toBe("held");
    expect(detail?.confidenceReasons).toContain(
      "Dependency gate: the matching list contract is held",
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
    // The agent receives spec-shaped content blocks, with the structured
    // payload alongside rather than instead of them.
    expect(execution?.isError).toBeUndefined();
    expect(execution?.content?.[0]?.type).toBe("text");
    expect(execution?.content?.[0]?.text).toMatch(/list_products/);
    expect(execution?.structuredContent?.rows).toBeDefined();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "execution_finished",
          name: "list_products",
          args: { offset: 0, limit: 1 },
          status: "success",
          result: execution,
        }),
      ]),
    );

    const failedExecution = await descriptor?.execute({ offset: 0, limit: 0 });
    expect(failedExecution?.isError).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "execution_finished",
          name: "list_products",
          args: { offset: 0, limit: 0 },
          status: "error",
          result: failedExecution,
        }),
      ]),
    );

    const cancellation = new AbortController();
    cancellation.abort();
    const cancelledExecution = await descriptor?.execute(
      { offset: 0, limit: 1 },
      { signal: cancellation.signal },
    );
    expect(cancelledExecution?.isError).toBe(true);
    expect(cancelledExecution?.content?.[0]?.text).toMatch(/cancelled/i);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "execution_finished",
          name: "list_products",
          args: { offset: 0, limit: 1 },
          status: "cancelled",
          result: cancelledExecution,
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
