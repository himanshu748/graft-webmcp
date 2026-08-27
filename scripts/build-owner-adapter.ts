// Produces the owner-site adapter through Graft's real export path, so the
// deployed example is genuinely generated rather than hand-written.
//   npx vite-node scripts/build-owner-adapter.ts
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { DOMParser: dom.window.DOMParser, Event: dom.window.Event });

const { compileDocument } = await import("../src/lib/index.js");
const { sanitizeFixtureHtml } = await import("../src/sanitize.js");
const { buildAdapterModule } = await import("../src/export-adapter.js");

const html = readFileSync("src/data/fixtureHtml/catalog.html", "utf8");
const sanitized = sanitizeFixtureHtml(html);
const compilation = compileDocument(sanitized.document);

const manifest = {
  product: "Graft",
  version: 1,
  source: {
    id: "signal-cabinet",
    title: compilation.snapshot.title,
    kind: "fixture",
    url: "https://graft-owner-example.vercel.app/",
  },
  generatedAt: "2026-08-27T00:00:00.000Z",
  notice: "Migration starting point. Review and test in the owner site before shipping.",
  tools: compilation.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, untrustedContentHint: true },
    status: tool.status,
    recipe: tool.recipe,
    selector: tool.selector,
  })),
};

const descriptors = manifest.tools
  .filter((tool) => tool.status === "auto" || tool.status === "published")
  .map(({ status: _s, recipe: _r, selector: _sel, ...descriptor }) => descriptor);

mkdirSync("examples/owner-site", { recursive: true });
writeFileSync("examples/owner-site/graft-adapter.js", buildAdapterModule(manifest, descriptors));

console.log(`derived ${compilation.tools.length} candidates`);
for (const tool of compilation.tools) {
  console.log(`  ${tool.name.padEnd(22)} ${tool.status.padEnd(10)} ${tool.confidence}`);
}
console.log(`\nexported ${descriptors.length} descriptors to examples/owner-site/graft-adapter.js`);
