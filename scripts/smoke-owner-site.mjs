// Executes every tool the owner site registers, using arguments built from each
// tool's own declared schema. Hand-picked arguments are how a handler and its
// contract drift apart without anyone noticing.
//   node scripts/smoke-owner-site.mjs [url]
import puppeteer from "puppeteer-core";

const URL_UNDER_TEST = process.argv[2] ?? "https://graft-owner-example.vercel.app/";
const CHROME =
  process.env.GRAFT_CHROME_PATH ??
  "/Users/himanshujha/.cache/puppeteer/chrome/mac_arm-152.0.7977.54/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto(URL_UNDER_TEST, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, 4000));

const results = await page.evaluate(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc) return { error: "no modelContext in this browser" };
  const tools = await mc.getTools();

  /** Build a schema-valid argument object, preferring declared constraints. */
  const sample = (schema) => {
    const out = {};
    const properties = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);
    for (const [key, spec] of Object.entries(properties)) {
      const isRequired = required.has(key);
      if (Array.isArray(spec.enum) && spec.enum.length > 0) {
        out[key] = spec.enum[0];
      } else if (spec.type === "integer" || spec.type === "number") {
        out[key] = spec.default ?? spec.minimum ?? 1;
      } else if (spec.type === "boolean") {
        out[key] = spec.default ?? false;
      } else if (spec.type === "string") {
        if (!isRequired) continue;
        out[key] = spec.default ?? "";
      }
    }
    return out;
  };

  // Chrome hands these back as JSON strings.
  const parse = (value) => {
    if (value == null) return null;
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
  };

  const report = [];
  for (const tool of tools) {
    const schema = parse(tool.inputSchema) ?? { type: "object", properties: {} };
    const args = sample(schema);
    const declared = new Set(Object.keys(schema.properties ?? {}));
    const undeclared = Object.keys(args).filter((key) => !declared.has(key));
    try {
      const raw = await mc.executeTool(tool, JSON.stringify(args));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const text = (parsed?.content ?? []).map((c) => c.text).join(" ");
      const missingRequired = (schema.required ?? []).filter((key) => args[key] === undefined);
      report.push({
        name: tool.name,
        args,
        undeclared,
        missingRequired,
        // A tool that answers "no such thing" for a value drawn from its own
        // enum has not really run, so that counts as a failure here.
        ok:
          !parsed?.isError &&
          Boolean(text) &&
          missingRequired.length === 0 &&
          !/^No product with id "undefined"/.test(text) &&
          !/undefined/.test(text),
        text: String(text).slice(0, 90),
      });
    } catch (error) {
      report.push({
        name: tool.name,
        args,
        undeclared,
        missingRequired: [],
        ok: false,
        text: `THREW: ${error.message}`,
      });
    }
  }
  return { tools: tools.length, report };
});

await browser.close();

if (results.error) {
  console.error(results.error);
  process.exit(1);
}

let failed = 0;
console.log(`${URL_UNDER_TEST}\n${results.tools} tools registered\n`);
for (const row of results.report) {
  const bad = !row.ok || row.undeclared.length > 0 || row.missingRequired.length > 0;
  if (bad) failed += 1;
  console.log(`${bad ? "FAIL" : "PASS"} ${row.name}`);
  console.log(`     args: ${JSON.stringify(row.args)}`);
  if (row.undeclared.length > 0) console.log(`     UNDECLARED ARGS: ${row.undeclared.join(", ")}`);
  if (row.missingRequired.length > 0) {
    console.log(`     SCHEMA GAVE NO SAMPLE FOR REQUIRED: ${row.missingRequired.join(", ")}`);
  }
  console.log(`     -> ${row.text}`);
}
console.log(`\n${results.report.length - failed}/${results.report.length} tools executed with schema-valid arguments.`);
process.exit(failed > 0 ? 1 : 0);
