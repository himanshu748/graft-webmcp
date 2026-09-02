// Compile an owner's exact HTML through Graft and write the untouched adapter.
//
// Usage:
//   npx vite-node scripts/build-adapter-from-html.ts page.html https://example.com/ output.js

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const [htmlArgument, sourceUrl, outputArgument] = process.argv.slice(2);
if (!htmlArgument || !sourceUrl || !outputArgument) {
  throw new Error(
    "Usage: build-adapter-from-html.ts <page.html> <https://owner.example/> <output.js>",
  );
}

const parsedUrl = new URL(sourceUrl);
if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
  throw new Error("The owner URL must use http or https.");
}

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  Event: dom.window.Event,
});

const { compileDocument, snapshotFingerprint, toolSetFingerprint } = await import(
  "../src/lib/index.js"
);
const { sanitizeFixtureHtml } = await import("../src/sanitize.js");
const { buildAdapterModule } = await import("../src/export-adapter.js");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const htmlPath = resolve(htmlArgument);
const outputPath = resolve(outputArgument);
const html = readFileSync(htmlPath, "utf8");
const sanitized = sanitizeFixtureHtml(html, parsedUrl.href);
const compilation = compileDocument(sanitized.document);
const runtimeSource = readFileSync("src/generated/graft-runtime.js", "utf8");
const exportedRuntimeSource = runtimeSource.trim();
const graftRevision = execFileSync("git", ["describe", "--always", "--dirty"], {
  encoding: "utf8",
}).trim();

const tools = compilation.tools.map((tool) => ({
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
}));
const exported = tools
  .filter((tool) => tool.status === "auto" || tool.status === "published")
  .map(({ status: _status, ...tool }) => tool);
const provenance = {
  graftRevision,
  sourceHtmlSha256: sha256(html),
  sanitizedSnapshotFingerprint: snapshotFingerprint(compilation.snapshot),
  runtimeSha256: sha256(exportedRuntimeSource),
  reviewedToolSetFingerprint: toolSetFingerprint(compilation.tools),
  exportedToolsSha256: sha256(JSON.stringify(exported)),
};
const manifest = {
  product: "Graft",
  version: 1,
  source: {
    id: parsedUrl.hostname,
    title: compilation.snapshot.title,
    kind: "owner-html",
    url: parsedUrl.href,
    file: basename(htmlPath),
  },
  generatedAt: new Date().toISOString(),
  notice: "Generated from exact owner HTML. Review and test before shipping.",
  provenance,
  tools,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, buildAdapterModule(manifest, exported, runtimeSource));

console.log(`compiled ${compilation.tools.length} candidates from ${htmlPath}`);
for (const tool of compilation.tools) {
  console.log(`  ${tool.name.padEnd(24)} ${tool.status.padEnd(9)} ${tool.confidence}`);
}
console.log(`exported ${exported.length} tools to ${outputPath}`);
console.log(`source sha256 ${provenance.sourceHtmlSha256}`);
console.log(`runtime sha256 ${provenance.runtimeSha256}`);
