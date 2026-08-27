// Verifies Graft's native WebMCP surface end to end in a real Chrome.
//   node scripts/verify-native.mjs [url]
// Requires Chrome 149+ with WebMCP. Install one with:
//   npx puppeteer browsers install chrome
import puppeteer from "puppeteer-core";

const CHROME =
  "/Users/himanshujha/.cache/puppeteer/chrome/mac_arm-152.0.7977.54/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("https://graft-webmcp.vercel.app/", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 10000));

async function call(name, args = {}) {
  return page.evaluate(async (n, a) => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const tool = tools.find((t) => t.name === n);
    if (!tool) return `NO SUCH TOOL: ${n}`;
    // Chrome takes the arguments as a JSON string and returns the result as
    // one, which is easy to miss when the object form silently throws.
    const raw = await mc.executeTool(tool, JSON.stringify(a));
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const text = (parsed?.content ?? []).map((c) => c.text).join("\n");
    return parsed?.structuredContent
      ? `${text}\n  structuredContent: ${JSON.stringify(parsed.structuredContent).slice(0, 220)}`
      : text;
  }, name, args);
}

const step = async (label, fn) => {
  console.log(`\n=== ${label} ===`);
  console.log((await fn()).slice(0, 700));
};

const names = await page.evaluate(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  return (await mc.getTools()).map((t) => t.name);
});
console.log("=== 0. NATIVE SURFACE ===\n" + names.join(", "));

await step("1. graft_status", () => call("graft_status"));
await step("2. graft_compile_url -> python.org", () => call("graft_compile_url", { url: "https://www.python.org" }));
await new Promise((r) => setTimeout(r, 2500));
await step("3. graft_list_candidates", () => call("graft_list_candidates"));
await step("4. graft_inspect_candidate -> search_this_site", () => call("graft_inspect_candidate", { name: "search_this_site" }));
await step("5. DERIVED TOOL, native live search", () => call("search_this_site", { q: "asyncio" }));
await step("5b. DERIVED TOOL, native list", () => call("list_latest_news", { limit: 3 }));
await step("6. graft_export_adapter", () => call("graft_export_adapter"));

await browser.close();
