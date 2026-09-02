// Compile an owner's exact HTML through Graft and write the untouched adapter.
//
// Usage:
//   npx vite-node scripts/build-adapter-from-html.ts page.html https://example.com/ output.js
//   npx vite-node scripts/build-adapter-from-html.ts page.html https://example.com/ output.js --review review.json

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import type { GraftTool } from "../src/lib/types.js";

const cliArguments = process.argv.slice(2);
const [htmlArgument, sourceUrl, outputArgument] = cliArguments;
const reviewArgument = cliArguments[3] === "--review" ? cliArguments[4] : undefined;
if (
  !htmlArgument ||
  !sourceUrl ||
  !outputArgument ||
  (cliArguments.length !== 3 && (cliArguments.length !== 5 || !reviewArgument))
) {
  throw new Error(
    "Usage: build-adapter-from-html.ts <page.html> <https://owner.example/> <output.js> [--review <review.json>]",
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

function hashGeneratorSources(): string {
  const paths = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "src",
      "scripts/build-adapter-from-html.ts",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.app.json",
      "tsconfig.node.json",
      "vite.config.ts",
      "vite.runtime.config.ts",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  if (paths.length === 0) throw new Error("No tracked Graft generator sources were found.");

  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    digest.update(readFileSync(resolve(path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

interface ReviewDecision {
  name: string;
  status: "published";
}

interface ReviewOverlay {
  version: 1;
  decisions: ReviewDecision[];
  file: string;
  sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** JSON.parse keeps only the last duplicate object member, so reject that ambiguity first. */
function findDuplicateJsonMember(source: string): string | null {
  let cursor = 0;
  let duplicate: string | null = null;

  const skipWhitespace = () => {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  };
  const readString = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor)) as string;
      }
      cursor += 1;
    }
    return "";
  };
  const scanValue = (): void => {
    skipWhitespace();
    if (source[cursor] === "{") {
      scanObject();
      return;
    }
    if (source[cursor] === "[") {
      cursor += 1;
      skipWhitespace();
      while (source[cursor] !== "]") {
        scanValue();
        skipWhitespace();
        if (source[cursor] === ",") {
          cursor += 1;
          skipWhitespace();
        }
      }
      cursor += 1;
      return;
    }
    if (source[cursor] === '"') {
      readString();
      return;
    }
    while (cursor < source.length && !/[\s,\]}]/.test(source[cursor] ?? "")) cursor += 1;
  };
  const scanObject = (): void => {
    cursor += 1;
    skipWhitespace();
    const keys = new Set<string>();
    while (source[cursor] !== "}") {
      const key = readString();
      if (keys.has(key) && duplicate === null) duplicate = key;
      keys.add(key);
      skipWhitespace();
      cursor += 1;
      scanValue();
      skipWhitespace();
      if (source[cursor] === ",") {
        cursor += 1;
        skipWhitespace();
      }
    }
    cursor += 1;
  };

  scanValue();
  return duplicate;
}

function loadReviewOverlay(argument: string): ReviewOverlay {
  const reviewPath = resolve(argument);
  let source: string;
  try {
    source = readFileSync(reviewPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read review file ${reviewPath}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Review file ${reviewPath} is not valid JSON.`);
  }
  const duplicateMember = findDuplicateJsonMember(source);
  if (duplicateMember !== null) {
    throw new Error(`Review file contains duplicate JSON member "${duplicateMember}".`);
  }

  if (!isRecord(parsed) || !hasExactKeys(parsed, ["decisions", "version"])) {
    throw new Error('Review file must contain exactly "version" and "decisions".');
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.decisions) || parsed.decisions.length === 0) {
    throw new Error('Review file must use version 1 and contain at least one decision.');
  }

  const decisions: ReviewDecision[] = [];
  const names = new Set<string>();
  for (const [index, value] of parsed.decisions.entries()) {
    if (!isRecord(value) || !hasExactKeys(value, ["name", "status"])) {
      throw new Error(`Review decision ${index + 1} must contain exactly "name" and "status".`);
    }
    if (
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      value.name !== value.name.trim()
    ) {
      throw new Error(`Review decision ${index + 1} must name one candidate exactly.`);
    }
    if (value.status !== "published") {
      throw new Error(`Review decision for "${value.name}" must target status "published".`);
    }
    if (names.has(value.name)) {
      throw new Error(`Review file contains a duplicate decision for "${value.name}".`);
    }
    names.add(value.name);
    decisions.push({ name: value.name, status: "published" });
  }

  return {
    version: 1,
    decisions,
    file: basename(reviewPath),
    sha256: sha256(source),
  };
}

function applyReviewOverlay(
  candidates: readonly GraftTool[],
  review: ReviewOverlay,
): GraftTool[] {
  const candidatesByName = new Map<string, GraftTool[]>();
  for (const candidate of candidates) {
    const matches = candidatesByName.get(candidate.name) ?? [];
    matches.push(candidate);
    candidatesByName.set(candidate.name, matches);
  }

  const decisions = new Map(review.decisions.map((decision) => [decision.name, decision.status]));
  for (const decision of review.decisions) {
    const matches = candidatesByName.get(decision.name) ?? [];
    if (matches.length === 0) {
      throw new Error(`No compiled candidate is named "${decision.name}".`);
    }
    if (matches.length > 1) {
      throw new Error(`Compiled candidate name "${decision.name}" is duplicated.`);
    }
    const candidate = matches[0];
    if (candidate.status === "rejected") {
      throw new Error(`Candidate "${decision.name}" is rejected and cannot be published.`);
    }
    if (candidate.status !== "held") {
      throw new Error(
        `Candidate "${decision.name}" has status "${candidate.status}"; the review requires "held".`,
      );
    }
  }

  const reviewed = candidates.map((candidate) =>
    decisions.get(candidate.name) === "published"
      ? { ...candidate, status: "published" }
      : candidate,
  );

  const listsBySelector = new Map(
    reviewed
      .filter((candidate) => candidate.binding.kind === "collection")
      .map((candidate) => [candidate.selector, candidate]),
  );
  for (const candidate of reviewed) {
    if (
      candidate.binding.kind !== "collection_item" ||
      (candidate.status !== "auto" && candidate.status !== "published")
    ) {
      continue;
    }
    const dependency = listsBySelector.get(candidate.selector);
    if (dependency?.status === "auto" || dependency?.status === "published") continue;
    const dependencyName = dependency ? `"${dependency.name}"` : "the matching list candidate";
    throw new Error(
      `Candidate "${candidate.name}" depends on ${dependencyName}, which is not published by this review.`,
    );
  }

  return reviewed;
}

const htmlPath = resolve(htmlArgument);
const outputPath = resolve(outputArgument);
const html = readFileSync(htmlPath, "utf8");
const sanitized = sanitizeFixtureHtml(html, parsedUrl.href);
const compilation = compileDocument(sanitized.document);
const review = reviewArgument ? loadReviewOverlay(reviewArgument) : undefined;
const reviewedCompilationTools = review
  ? applyReviewOverlay(compilation.tools, review)
  : compilation.tools;
const runtimeSource = readFileSync("src/generated/graft-runtime.js", "utf8");
const exportedRuntimeSource = runtimeSource.trim();
const generatorSourcesSha256 = hashGeneratorSources();
const graftRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const graftSourceState = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { encoding: "utf8" },
).trim().length === 0 ? "clean" : "dirty";

const tools = reviewedCompilationTools.map((tool) => ({
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
  graftSourceState,
  sourceHtmlSha256: sha256(html),
  sanitizedSnapshotFingerprint: snapshotFingerprint(compilation.snapshot),
  runtimeSha256: sha256(exportedRuntimeSource),
  generatorSourcesSha256,
  reviewedToolSetFingerprint: toolSetFingerprint(reviewedCompilationTools),
  exportedToolsSha256: sha256(JSON.stringify(exported)),
  ...(review
    ? {
        humanReview: {
          version: review.version,
          file: review.file,
          sha256: review.sha256,
          decisions: review.decisions,
        },
      }
    : {}),
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
const adapterSource = buildAdapterModule(manifest, exported, runtimeSource);
const adapterSha256 = sha256(adapterSource);
const checksumPath = `${outputPath}.sha256`;
writeFileSync(outputPath, adapterSource);
writeFileSync(checksumPath, `${adapterSha256}  ${basename(outputPath)}\n`);

console.log(`compiled ${compilation.tools.length} candidates from ${htmlPath}`);
for (const tool of reviewedCompilationTools) {
  console.log(`  ${tool.name.padEnd(24)} ${tool.status.padEnd(9)} ${tool.confidence}`);
}
console.log(`exported ${exported.length} tools to ${outputPath}`);
console.log(`source sha256 ${provenance.sourceHtmlSha256}`);
console.log(`runtime sha256 ${provenance.runtimeSha256}`);
console.log(`generator sources sha256 ${provenance.generatorSourcesSha256}`);
console.log(`adapter sha256 ${adapterSha256}`);
console.log(`checksum ${checksumPath}`);
if (review) console.log(`review sha256 ${review.sha256}`);
