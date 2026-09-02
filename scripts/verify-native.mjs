// Verifies Graft's native WebMCP surface end to end in a real Chrome.
//   CHROME_PATH=/path/to/chrome node scripts/verify-native.mjs [url]
// Requires Chrome 149+ with WebMCP. Install one with:
//   npx puppeteer browsers install chrome
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const systemCandidates = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

const chromePath = [
  process.env.CHROME_PATH,
  process.env.GOOGLE_CHROME_BIN,
  ...(systemCandidates[platform()] ?? []),
].find((candidate) => candidate && existsSync(candidate));

if (!chromePath) {
  console.error(
    "Chrome 149+ was not found. Set CHROME_PATH to a Chrome or Chrome for Testing executable.",
  );
  process.exit(1);
}

const targetUrl = process.argv[2] ?? "https://graft-webmcp.vercel.app/";
const ownerUrl = process.env.GRAFT_OWNER_URL ?? "https://graft-owner-example.vercel.app/";
const controlTools = [
  "graft_status",
  "graft_compile_url",
  "graft_list_candidates",
  "graft_inspect_candidate",
  "graft_set_candidate",
  "graft_export_adapter",
  "graft_verify_url",
];
const ownerTools = [
  "get_page_summary",
  "get_page_outline",
  "search_catalog",
  "list_products",
  "get_product",
  "add_to_demo_cart",
];

let browser;
let downloadDir;

async function closeBrowser(instance) {
  if (!instance) return;
  let forced = false;
  let timeout;
  try {
    await Promise.race([
      instance.close(),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          forced = true;
          instance.process()?.kill();
          instance.disconnect();
          resolve();
        }, 5000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forced) console.warn("Chrome did not close cleanly and was terminated.");
  }
}

try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  downloadDir = mkdtempSync(join(tmpdir(), "graft-native-"));
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });
  await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 10000));

  async function call(name, args = {}) {
    return page.evaluate(async (toolName, toolArgs) => {
      const modelContext = document.modelContext ?? navigator.modelContext;
      if (!modelContext) throw new Error("This browser does not expose modelContext.");

      const tools = await modelContext.getTools();
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`No native tool named ${toolName}.`);

      // Chrome takes the arguments as a JSON string and returns the result as
      // one, which is easy to miss when the object form silently throws.
      const raw = await modelContext.executeTool(tool, JSON.stringify(toolArgs));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const output = (parsed?.content ?? [])
        .map((content) => content?.text)
        .filter(Boolean)
        .join("\n");
      if (parsed?.isError) {
        throw new Error(`${toolName} returned an error${output ? `: ${output}` : "."}`);
      }
      if (!output && parsed?.structuredContent === undefined) {
        throw new Error(`${toolName} returned no content.`);
      }
      return parsed?.structuredContent
        ? `${output}\n  structuredContent: ${JSON.stringify(parsed.structuredContent).slice(0, 220)}`
        : output;
    }, name, args);
  }

  const step = async (label, fn, accepts = (output) => Boolean(output)) => {
    console.log(`\n=== ${label} ===`);
    const output = await fn();
    console.log(output.slice(0, 700));
    if (!accepts(output)) throw new Error(`${label} returned an unexpected result.`);
    return output;
  };

  const nativeToolNames = () => page.evaluate(async () => {
    const modelContext = document.modelContext ?? navigator.modelContext;
    if (!modelContext) throw new Error("This browser does not expose modelContext.");
    return (await modelContext.getTools()).map((tool) => tool.name);
  });
  const assertNativePresence = async (name, expected) => {
    const current = await nativeToolNames();
    const present = current.includes(name);
    if (present !== expected) {
      throw new Error(
        `${name} was ${present ? "still" : "not"} registered after it should have been ${
          expected ? "published" : "held"
        }.`,
      );
    }
    console.log(`Native registry ${expected ? "contains" : "does not contain"} ${name}.`);
  };

  const names = await nativeToolNames();
  console.log("=== 0. NATIVE SURFACE ===\n" + names.join(", "));
  const missingControls = controlTools.filter((name) => !names.includes(name));
  if (missingControls.length > 0) {
    throw new Error(`Missing native control tools: ${missingControls.join(", ")}`);
  }

  await step(
    "1. graft_status",
    () => call("graft_status"),
    (output) => output.includes("WebMCP available in this browser: yes"),
  );
  await step(
    "2. graft_compile_url -> python.org",
    () => call("graft_compile_url", { url: "https://www.python.org" }),
    (output) => output.includes("Compiled source: https://www.python.org"),
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await step(
    "3. graft_list_candidates",
    () => call("graft_list_candidates"),
    (output) => output.includes("search_this_site"),
  );
  await step(
    "4. graft_inspect_candidate -> search_this_site",
    () => call("graft_inspect_candidate", { name: "search_this_site" }),
    (output) => output.includes("search_this_site |") && output.includes("Schema:"),
  );
  await step("5. DERIVED TOOL, native live search", () =>
    call("search_this_site", { q: "asyncio" }),
  );
  await step("5b. DERIVED TOOL, native list", () => call("list_latest_news", { limit: 3 }));
  await step(
    "6. graft_set_candidate -> hold search_this_site",
    () => call("graft_set_candidate", { name: "search_this_site", status: "held" }),
    (output) => output.includes("search_this_site is now held."),
  );
  await assertNativePresence("search_this_site", false);
  await step(
    "6b. graft_set_candidate -> publish search_this_site",
    () => call("graft_set_candidate", { name: "search_this_site", status: "published" }),
    (output) => output.includes("search_this_site is now published."),
  );
  await assertNativePresence("search_this_site", true);
  await step("6c. republished search_this_site executes", () =>
    call("search_this_site", { q: "asyncio" }),
  );
  await step(
    "7. graft_export_adapter",
    () => call("graft_export_adapter"),
    (output) => output.startsWith("Exported "),
  );
  await step(
    "8. graft_verify_url -> owner contract",
    () => call("graft_verify_url", { url: ownerUrl, expect: ownerTools.join(",") }),
    (output) =>
      output.includes("Verdict: pass (5/5 decisive checks") &&
      ownerTools.every((name) => output.includes(name)) &&
      !output.includes("Drift:"),
  );
} catch (error) {
  console.error(`\nVERIFY FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
  if (downloadDir) rmSync(downloadDir, { recursive: true, force: true });
}
