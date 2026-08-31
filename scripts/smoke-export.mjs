// Proves the export loop end to end: compile a page, export the adapter, then
// load the downloaded file on an unrelated origin and register it into Chrome's
// own tool registry. A green graft_export_adapter response only says the click
// happened, so this checks that a file lands and that the file still works
// once it is away from Graft.
//   node scripts/smoke-export.mjs [graft-url] [target-url]
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import puppeteer from "puppeteer-core";

const GRAFT_URL = process.argv[2] ?? "https://graft-webmcp.vercel.app/";
const TARGET_URL = process.argv[3] ?? "https://www.python.org";
const CHROME =
  process.env.GRAFT_CHROME_PATH ??
  "/Users/himanshujha/.cache/puppeteer/chrome/mac_arm-152.0.7977.54/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const downloadDir = mkdtempSync(join(tmpdir(), "graft-export-"));
const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

// Step 1: drive Graft's own control plane the way an agent would.
const graft = await browser.newPage();
const cdp = await graft.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
await graft.goto(GRAFT_URL, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, 8000));

const callControl = (name, args = {}) =>
  graft.evaluate(
    async (toolName, toolArgs) => {
      const mc = document.modelContext ?? navigator.modelContext;
      if (!mc) return "no modelContext in this browser";
      const tool = (await mc.getTools()).find((candidate) => candidate.name === toolName);
      if (!tool) return `no such tool: ${toolName}`;
      // Chrome takes the arguments as a JSON string and returns one too.
      const raw = await mc.executeTool(tool, JSON.stringify(toolArgs));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return (parsed?.content ?? []).map((block) => block.text).join("\n");
    },
    name,
    args,
  );

const before = new Set(readdirSync(downloadDir));
const compiled = await callControl("graft_compile_url", { url: TARGET_URL });
await new Promise((resolve) => setTimeout(resolve, 4000));
check(/^Compiled source:/.test(compiled), `graft_compile_url ${TARGET_URL}`, compiled.split("\n")[2] ?? compiled.slice(0, 90));

const exported = await callControl("graft_export_adapter");
await new Promise((resolve) => setTimeout(resolve, 3000));
check(/^Exported /.test(exported), "graft_export_adapter reports an export", exported.slice(0, 110));

// Step 2: the file has to exist, not just be announced.
const written = readdirSync(downloadDir).filter((entry) => !before.has(entry) && extname(entry) === ".js");
check(written.length === 1, "exactly one adapter file was downloaded", written.join(", ") || "nothing landed on disk");
if (written.length !== 1) {
  await browser.close();
  process.exit(1);
}

const adapterName = written[0];
const source = readFileSync(join(downloadDir, adapterName), "utf8");
const descriptorBlock = source.match(/export const graftTools = ([\s\S]*?);\n/);
let descriptors = [];
try {
  descriptors = JSON.parse(descriptorBlock?.[1] ?? "null") ?? [];
} catch {
  descriptors = [];
}
check(descriptors.length > 0, `${adapterName} declares descriptors`, `${descriptors.length} descriptors`);
if (descriptors.length === 0) {
  await browser.close();
  process.exit(1);
}

// The adapter now carries its own runtime, so every exported tool must register
// with no owner code at all. One name is overridden to prove an owner can still
// take a tool back.
const all = descriptors.map((d) => d.name);
const overridden = descriptors.find((d) => Object.keys(d.inputSchema?.properties ?? {}).length > 0)?.name ?? all[0];
const bound = all;
const unbound = [];

// Step 3: serve the untouched file from an origin that knows nothing about Graft.
writeFileSync(
  join(downloadDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Adapter host</title>
<script type="module">
import { registerGraftTools } from "./${adapterName}";
const overridden = ${JSON.stringify(overridden)};
const handlers = {
  [overridden]: async (args) => ({
    content: [{ type: "text", text: "owner handler " + overridden + " received " + JSON.stringify(args ?? {}) }],
  }),
};
try {
  window.__graftReport = await registerGraftTools({ handlers });
} catch (error) {
  window.__graftReport = { threw: error instanceof Error ? error.message : String(error) };
}
</script>`,
);

const types = { ".js": "text/javascript", ".html": "text/html" };
const server = createServer((request, response) => {
  const name = request.url === "/" ? "/index.html" : decodeURIComponent(request.url.split("?")[0]);
  try {
    const body = readFileSync(join(downloadDir, name.replace(/^\//, "")));
    response.writeHead(200, { "content-type": `${types[extname(name)] ?? "text/plain"}; charset=utf-8` });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const host = await browser.newPage();
const pageErrors = [];
host.on("pageerror", (error) => pageErrors.push(error.message));
await host.goto(`${origin}/`, { waitUntil: "networkidle2", timeout: 30000 });
await new Promise((resolve) => setTimeout(resolve, 3000));
check(pageErrors.length === 0, "the adapter loads without a page error", pageErrors.join("; "));

const report = await host.evaluate(() => window.__graftReport ?? { missing: true });
check(!report.missing && !report.threw, "registerGraftTools returned a report", report.threw ?? "");
check(
  JSON.stringify(report.registered ?? []) === JSON.stringify(all),
  "every exported tool registered with no owner handlers",
  `registered ${JSON.stringify(report.registered ?? [])}`,
);
check(
  (report.missingHandlers ?? []).length === 0,
  "the bundled runtime leaves no tool unbound",
  `missingHandlers ${JSON.stringify(report.missingHandlers ?? [])}`,
);
check((report.failures ?? []).length === 0, "no registration failed", JSON.stringify(report.failures ?? []));

// Step 4: Chrome's own registry is the only opinion that counts here.
const native = await host.evaluate(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc) return null;
  return (await mc.getTools()).map((tool) => tool.name);
});
check(
  native !== null && JSON.stringify([...native].sort()) === JSON.stringify([...bound].sort()),
  "Chrome lists exactly the registered tools",
  `getTools() -> ${(native ?? []).join(", ")}`,
);

// Step 5: execute one through the browser and make sure the owner handler is
// what answers, using an argument the exported schema actually declares.
// Prefer a tool that declares arguments, so the argument check is not vacuous.
const probe = descriptors
  .filter((descriptor) => descriptor.name === overridden)
  .sort(
    (a, b) =>
      Object.keys(b.inputSchema?.properties ?? {}).length -
      Object.keys(a.inputSchema?.properties ?? {}).length,
  )[0];
const probeArgs = {};
for (const [key, spec] of Object.entries(probe.inputSchema?.properties ?? {})) {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) probeArgs[key] = spec.enum[0];
  else if (spec.type === "integer" || spec.type === "number") probeArgs[key] = spec.default ?? spec.minimum ?? 1;
  else if (spec.type === "boolean") probeArgs[key] = spec.default ?? false;
  else if (spec.type === "string" && (probe.inputSchema?.required ?? []).includes(key)) probeArgs[key] = "smoke";
}
const executed = await host.evaluate(
  async (name, args) => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tool = (await mc.getTools()).find((candidate) => candidate.name === name);
    const raw = await mc.executeTool(tool, JSON.stringify(args));
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return (parsed?.content ?? []).map((block) => block.text).join("\n");
  },
  probe.name,
  probeArgs,
);
check(
  executed.includes(`owner handler ${probe.name} received`),
  `executeTool reaches the owner handler for ${probe.name}`,
  executed.slice(0, 120),
);
check(
  Object.entries(probeArgs).every(([key, value]) => executed.includes(`"${key}":${JSON.stringify(value)}`)),
  "the handler received the declared arguments",
  `sent ${JSON.stringify(probeArgs)}`,
);

server.close();
await browser.close();

console.log(`\nAdapter: ${adapterName} (${descriptors.length} tools, runtime-bound, 1 overridden)`);
console.log(failures.length === 0 ? "Export loop verified end to end." : `${failures.length} check(s) failed.`);
process.exit(failures.length > 0 ? 1 : 0);
