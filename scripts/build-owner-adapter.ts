// Produces the owner-site adapter through Graft's real export path, so the
// deployed example is genuinely generated rather than hand-written.
//   npm run build:owner-adapter
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (...segments: string[]) => resolve(repositoryRoot, ...segments);

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { DOMParser: dom.window.DOMParser, Event: dom.window.Event });

const { compileDocument } = await import("../src/lib/index.js");
const { sanitizeFixtureHtml } = await import("../src/sanitize.js");
const { buildAdapterModule } = await import("../src/export-adapter.js");

const html = readFileSync(fromRoot("src/data/fixtureHtml/catalog.html"), "utf8");
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
    fallbackSelectors: tool.fallbackSelectors,
    action: tool.action,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    binding: tool.binding,
  })),
};

const exported = manifest.tools
  .filter((tool) => tool.status === "auto" || tool.status === "published")
  .map(({ status: _s, ...tool }) => tool);

const runtimeSource = readFileSync(fromRoot("src/generated/graft-runtime.js"), "utf8");

mkdirSync(fromRoot("examples/owner-site"), { recursive: true });
writeFileSync(
  fromRoot("examples/owner-site/graft-adapter.js"),
  buildAdapterModule(manifest, exported, runtimeSource),
);

console.log(`derived ${compilation.tools.length} candidates`);
for (const tool of compilation.tools) {
  console.log(`  ${tool.name.padEnd(22)} ${tool.status.padEnd(10)} ${tool.confidence}`);
}
console.log(`\nexported ${exported.length} tools to examples/owner-site/graft-adapter.js`);
