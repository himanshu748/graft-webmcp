// Owner-written integration. Graft generated the contracts in graft-adapter.js;
// everything below is the handler code the owner is responsible for, operating
// this page's live DOM rather than a snapshot of it.
import { graftManifest, registerGraftTools } from "./graft-adapter.js";

const status = document.getElementById("owner-tool-status");
const cartItems = [];

const products = () => [...document.querySelectorAll("article.product")];

function readProduct(article) {
  const text = (selector) => article.querySelector(selector)?.textContent?.trim() ?? "";
  return {
    id: article.getAttribute("data-product-id") ?? "",
    title: text("[itemprop='name']"),
    category: text("[itemprop='category']"),
    description: text("[itemprop='description']"),
    price: text("[itemprop='price']"),
    availability: text("[itemprop='availability']"),
  };
}

function ok(message, data) {
  return { content: [{ type: "text", text: message }], ...(data ? { structuredContent: data } : {}) };
}

/** Search genuinely filters the page, so the human watching sees it happen. */
function applyFilter(query, category) {
  const needle = (query ?? "").trim().toLowerCase();
  const wanted = (category ?? "").trim().toLowerCase();
  let shown = 0;
  const matches = [];
  for (const article of products()) {
    const product = readProduct(article);
    const haystack = `${product.title} ${product.description} ${product.category}`.toLowerCase();
    const hit =
      (!needle || haystack.includes(needle)) &&
      (!wanted || wanted === "all" || product.category.toLowerCase() === wanted);
    article.hidden = !hit;
    if (hit) {
      shown += 1;
      matches.push(product);
    }
  }
  return { shown, matches };
}

const handlers = {
  get_page_summary: async () =>
    ok(
      `${document.title}. ${products().length} products listed.`,
      {
        title: document.title,
        headings: [...document.querySelectorAll("h1,h2,h3")].slice(0, 12).map((h) => h.textContent.trim()),
        productCount: products().length,
      },
    ),

  get_page_outline: async () =>
    ok(
      "Heading outline for this page.",
      {
        headings: [...document.querySelectorAll("h1,h2,h3,h4")].map((h) => ({
          level: Number(h.tagName.slice(1)),
          text: h.textContent.trim(),
        })),
      },
    ),

  search_catalog: async (args) => {
    const { shown, matches } = applyFilter(args?.query, args?.category);
    return ok(`${shown} of ${products().length} products match.`, { total: shown, results: matches });
  },

  list_products: async (args) => {
    const offset = Number(args?.offset ?? 0);
    const limit = Math.min(Number(args?.limit ?? 10), 25);
    const all = products().filter((article) => !article.hidden).map(readProduct);
    const page = all.slice(offset, offset + limit);
    return ok(
      `Returned ${page.length} of ${all.length} products from offset ${offset}.`,
      { rows: page, total: all.length, offset, hasMore: offset + page.length < all.length },
    );
  },

  get_product: async (args) => {
    const wanted = String(args?.title ?? "").trim().toLowerCase();
    const found = products().map(readProduct).find((product) => product.title.toLowerCase() === wanted);
    if (!found) return ok(`No product titled "${args?.title}".`);
    return ok(`${found.title}, ${found.price}, ${found.availability}.`, found);
  },
};

// The manifest also carries a write candidate Graft held for review. The owner
// read it, decided it was correct, and bound a real handler. That decision is
// the whole point of the review gate: Graft proposes, a human ships.
const heldWrite = graftManifest.tools.find((tool) => tool.name === "add_to_demo_cart");

async function addToCart(args) {
  const wanted = String(args?.product_id ?? args?.title ?? "").trim().toLowerCase();
  const article = products().find(
    (node) =>
      node.getAttribute("data-product-id")?.toLowerCase() === wanted ||
      readProduct(node).title.toLowerCase() === wanted,
  );
  if (!article) return ok(`No product matching "${wanted}".`);
  const product = readProduct(article);
  const quantity = Math.max(1, Math.min(3, Number(args?.quantity ?? 1)));
  cartItems.push({ title: product.title, quantity });

  document.getElementById("owner-cart-empty")?.remove();
  const li = document.createElement("li");
  li.textContent = `${quantity} x ${product.title} (${product.price})`;
  document.getElementById("owner-cart-items").append(li);
  article.scrollIntoView({ block: "center" });

  return ok(`Added ${quantity} x ${product.title} to the cart.`, {
    cart: cartItems,
    itemCount: cartItems.length,
  });
}

async function boot() {
  const report = await registerGraftTools(handlers);
  const context = document.modelContext ?? navigator.modelContext;

  if (heldWrite && context) {
    await context.registerTool(
      {
        name: heldWrite.name,
        description:
          "Add a product to this site's cart. The owner reviewed and bound this handler; Graft held the candidate rather than registering it automatically.",
        inputSchema: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "Product id or exact title." },
            quantity: { type: "integer", description: "How many, 1 to 3.", minimum: 1, maximum: 3 },
          },
          required: ["product_id"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: addToCart,
      },
      {},
    );
    report.registered.push(heldWrite.name);
  }

  const live = context ? (await context.getTools()).length : 0;
  status.textContent =
    live > 0
      ? `${live} WebMCP tools live: ${report.registered.join(", ")}. Generated by Graft, handlers written here.`
      : "WebMCP is not available in this browser, so no tools registered.";
  if (report.missingHandlers.length > 0) {
    status.textContent += ` Missing handlers: ${report.missingHandlers.join(", ")}.`;
  }
}

// The search form is the owner's, so it stays usable for humans too.
document.querySelector("form.search-grid")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  applyFilter(String(data.get("query") ?? ""), String(data.get("category") ?? ""));
});

boot().catch((error) => {
  status.textContent = `Adapter failed to register: ${error.message}`;
});
