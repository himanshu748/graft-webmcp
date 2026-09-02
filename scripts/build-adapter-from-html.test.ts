import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(repositoryRoot, "scripts/build-adapter-from-html.ts");
const viteNodePath = join(repositoryRoot, "node_modules/vite-node/vite-node.mjs");
const fixturePath = join(repositoryRoot, "public/fixtures/catalog.html");
const temporaryDirectories: string[] = [];
const CLI_TEST_TIMEOUT_MS = 20_000;
let importSequence = 0;

interface CliRun {
  directory: string;
  outputPath: string;
  reviewPath?: string;
  reviewSource?: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "graft-html-export-review-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(review?: unknown, rawReviewSource?: string, htmlSource?: string): CliRun {
  const directory = createDirectory();
  const outputPath = join(directory, "adapter.mjs");
  const sourcePath = htmlSource === undefined ? fixturePath : join(directory, "page.html");
  if (htmlSource !== undefined) writeFileSync(sourcePath, htmlSource);
  const reviewPath = review === undefined && rawReviewSource === undefined
    ? undefined
    : join(directory, "review.json");
  const reviewSource = reviewPath
    ? rawReviewSource ?? JSON.stringify(review, null, 2)
    : undefined;
  if (reviewPath && reviewSource !== undefined) writeFileSync(reviewPath, reviewSource);

  const result = spawnSync(
    process.execPath,
    [
      viteNodePath,
      cliPath,
      sourcePath,
      "https://owner.example/catalog",
      outputPath,
      ...(reviewPath ? ["--review", reviewPath] : []),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  return {
    directory,
    outputPath,
    reviewPath,
    reviewSource,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function readAdapter(outputPath: string) {
  importSequence += 1;
  return import(`${pathToFileURL(outputPath).href}?test=${importSequence}`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("HTML adapter review overlay", { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it("publishes an exactly named held candidate and records the review provenance", async () => {
    const run = runCli({
      version: 1,
      decisions: [{ name: "add_to_demo_cart", status: "published" }],
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("add_to_demo_cart         published");
    const adapter = await readAdapter(run.outputPath);
    const reviewedCandidate = adapter.graftManifest.tools.find(
      (tool: { name: string }) => tool.name === "add_to_demo_cart",
    );
    expect(reviewedCandidate.status).toBe("published");
    expect(adapter.graftTools.map((tool: { name: string }) => tool.name)).toContain(
      "add_to_demo_cart",
    );
    expect(adapter.graftManifest.provenance.humanReview).toEqual({
      version: 1,
      file: basename(run.reviewPath as string),
      sha256: createHash("sha256").update(run.reviewSource as string).digest("hex"),
      decisions: [{ name: "add_to_demo_cart", status: "published" }],
    });
    expect(adapter.graftManifest.provenance.generatorSourcesSha256).toMatch(/^[a-f0-9]{64}$/);
    const adapterSource = readFileSync(run.outputPath, "utf8");
    const checksumSource = readFileSync(`${run.outputPath}.sha256`, "utf8");
    expect(checksumSource).toBe(
      `${createHash("sha256").update(adapterSource).digest("hex")}  ${basename(run.outputPath)}\n`,
    );
  });

  it("leaves held candidates and provenance unchanged without a review file", async () => {
    const run = runCli();

    expect(run.status, run.stderr).toBe(0);
    const adapter = await readAdapter(run.outputPath);
    const heldCandidate = adapter.graftManifest.tools.find(
      (tool: { name: string }) => tool.name === "add_to_demo_cart",
    );
    expect(heldCandidate.status).toBe("held");
    expect(adapter.graftTools.map((tool: { name: string }) => tool.name)).not.toContain(
      "add_to_demo_cart",
    );
    expect(adapter.graftManifest.provenance).not.toHaveProperty("humanReview");
    expect(adapter.graftManifest.tools.map((tool: { name: string; status: string }) => [
      tool.name,
      tool.status,
    ])).toEqual([
      ["get_page_summary", "auto"],
      ["get_page_outline", "auto"],
      ["search_catalog", "auto"],
      ["list_products", "auto"],
      ["get_product", "auto"],
      ["list_device_controls", "rejected"],
      ["add_to_demo_cart", "held"],
    ]);
    expect(adapter.graftManifest.provenance.reviewedToolSetFingerprint).toBe("g_j4nbks");
    expect(adapter.graftManifest.provenance.exportedToolsSha256).toBe(
      "d77e6cb06373b80d37955b4f5dffa032a527be38525bf8676e3692bbc387eb56",
    );
    expect(createHash("sha256").update(JSON.stringify(adapter.graftTools)).digest("hex")).toBe(
      "d77e6cb06373b80d37955b4f5dffa032a527be38525bf8676e3692bbc387eb56",
    );
  });

  it("requires a held list dependency to be published with its detail tool", () => {
    const source = `<!doctype html><html><head><title>Ambiguous records</title></head><body>
      <main><div id="machine-records">
        <div class="machine-record" data-machine-id="one"></div>
        <div class="machine-record" data-machine-id="two"></div>
        <div class="machine-record" data-machine-id="three"></div>
      </div></main>
    </body></html>`;
    const run = runCli(
      { version: 1, decisions: [{ name: "get_machine", status: "published" }] },
      undefined,
      source,
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      'Candidate "get_machine" depends on "list_machines", which is not published by this review.',
    );
    expect(existsSync(run.outputPath)).toBe(false);
  });

  it("publishes a dependency-gated pair when both exact decisions are present", async () => {
    const source = `<!doctype html><html><head><title>Ambiguous records</title></head><body>
      <main><div id="machine-records">
        <div class="machine-record" data-machine-id="one"></div>
        <div class="machine-record" data-machine-id="two"></div>
        <div class="machine-record" data-machine-id="three"></div>
      </div></main>
    </body></html>`;
    const run = runCli(
      {
        version: 1,
        decisions: [
          { name: "list_machines", status: "published" },
          { name: "get_machine", status: "published" },
        ],
      },
      undefined,
      source,
    );

    expect(run.status, run.stderr).toBe(0);
    const adapter = await readAdapter(run.outputPath);
    expect(adapter.graftTools.map((tool: { name: string }) => tool.name)).toEqual([
      "get_page_summary",
      "list_machines",
      "get_machine",
    ]);
  });

  it.each([
    {
      label: "an absent compiled name",
      review: { version: 1, decisions: [{ name: "missing_tool", status: "published" }] },
      error: 'No compiled candidate is named "missing_tool".',
    },
    {
      label: "a rejected candidate",
      review: {
        version: 1,
        decisions: [{ name: "list_device_controls", status: "published" }],
      },
      error: 'Candidate "list_device_controls" is rejected and cannot be published.',
    },
    {
      label: "a candidate whose compiled status is not held",
      review: {
        version: 1,
        decisions: [{ name: "get_page_summary", status: "published" }],
      },
      error: 'Candidate "get_page_summary" has status "auto"; the review requires "held".',
    },
    {
      label: "duplicate decisions",
      review: {
        version: 1,
        decisions: [
          { name: "add_to_demo_cart", status: "published" },
          { name: "add_to_demo_cart", status: "published" },
        ],
      },
      error: 'Review file contains a duplicate decision for "add_to_demo_cart".',
    },
  ])("fails closed for $label", ({ review, error }) => {
    const run = runCli(review);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(error);
    expect(existsSync(run.outputPath)).toBe(false);
  });

  it.each([
    {
      label: "invalid JSON",
      raw: "{not-json",
      error: "is not valid JSON",
    },
    {
      label: "a duplicate top-level member",
      raw: '{"version":2,"version":1,"decisions":[{"name":"add_to_demo_cart","status":"published"}]}',
      error: 'duplicate JSON member "version"',
    },
    {
      label: "a duplicate decision name",
      raw: '{"version":1,"decisions":[{"name":"missing_tool","name":"add_to_demo_cart","status":"published"}]}',
      error: 'duplicate JSON member "name"',
    },
    {
      label: "an escaped duplicate decision name",
      raw: '{"version":1,"decisions":[{"n\\u0061me":"missing_tool","name":"add_to_demo_cart","status":"published"}]}',
      error: 'duplicate JSON member "name"',
    },
    {
      label: "a duplicate decision status",
      raw: '{"version":1,"decisions":[{"name":"add_to_demo_cart","status":"held","status":"published"}]}',
      error: 'duplicate JSON member "status"',
    },
    {
      label: "an empty decision list",
      review: { version: 1, decisions: [] },
      error: "contain at least one decision",
    },
    {
      label: "a missing candidate name",
      review: { version: 1, decisions: [{ status: "published" }] },
      error: 'must contain exactly "name" and "status"',
    },
    {
      label: "an unsupported target status",
      review: { version: 1, decisions: [{ name: "add_to_demo_cart", status: "held" }] },
      error: 'must target status "published"',
    },
    {
      label: "a descriptor override",
      review: {
        version: 1,
        decisions: [
          {
            name: "add_to_demo_cart",
            status: "published",
            description: "Replace the generated contract",
          },
        ],
      },
      error: 'must contain exactly "name" and "status"',
    },
  ])("rejects malformed review input: $label", ({ review, raw, error }) => {
    const run = runCli(review, raw);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(error);
    expect(existsSync(run.outputPath)).toBe(false);
  });
});
