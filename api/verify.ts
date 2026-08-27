import { assertPublicHost, IntakeError } from "./_net.js";
import { readNativeTools } from "./_render.js";

interface Check {
  id: string;
  label: string;
  pass: boolean;
  /** A check the browser cannot answer is not a failure. */
  inconclusive?: boolean;
  detail: string;
}

interface ToolFinding {
  name: string;
  issues: string[];
}

const NAME_LIMIT = 30;
const DESCRIPTION_LIMIT = 500;

/**
 * Contract checks mirror the budgets Chrome's own WebMCP guidance publishes,
 * so a pass here means the same thing an agent client would conclude.
 */
function inspectTool(
  tool: {
    name: string;
    description: string;
    inputSchema: unknown;
    annotations: Record<string, unknown> | null;
  },
  exposes: { inputSchema: boolean; annotations: boolean },
): ToolFinding {
  const issues: string[] = [];
  if (!tool.name) issues.push("has no name");
  if (tool.name.length > NAME_LIMIT) issues.push(`name is ${tool.name.length} chars, over ${NAME_LIMIT}`);
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) issues.push("name is not lowercase snake_case");
  if (!tool.description) issues.push("has no description");
  if (tool.description.length > DESCRIPTION_LIMIT) {
    issues.push(`description is ${tool.description.length} chars, over ${DESCRIPTION_LIMIT}`);
  }

  const schema = tool.inputSchema as Record<string, unknown> | null;
  // A listing that may omit a schema can never prove one is missing, so an
  // absent schema is reported as unseen rather than asserted as a defect. Only
  // a schema we can actually read gets judged.
  if (!schema || typeof schema !== "object") {
    // nothing assertable
  } else {
    if (schema.type !== "object") issues.push("input schema is not an object type");
    if (schema.properties === undefined) issues.push("input schema declares no properties");
    if (schema.additionalProperties !== false) {
      issues.push("input schema allows additional properties, so unexpected arguments pass silently");
    }
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, value] of Object.entries(properties)) {
      if (!value || typeof value !== "object") continue;
      if (!value.description) issues.push(`parameter "${key}" has no description`);
      if (!value.type && !value.enum) issues.push(`parameter "${key}" declares no type`);
    }
  }

  if (exposes.annotations && (!tool.annotations || tool.annotations.readOnlyHint === undefined)) {
    issues.push("does not declare readOnlyHint, so a client cannot tell whether it mutates");
  }
  return { name: tool.name || "(unnamed)", issues };
}

export default async function handler(req: any, res: any) {
  res.setHeader("cache-control", "no-store");

  const raw = typeof req.query?.url === "string" ? req.query.url : "";
  const expectedRaw = typeof req.query?.expect === "string" ? req.query.expect : "";
  if (!raw) {
    res.status(400).json({ ok: false, reason: "missing", message: "Pass a ?url= parameter." });
    return;
  }

  let target: URL;
  try {
    target = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    res.status(400).json({ ok: false, reason: "invalid", message: "That does not look like a URL." });
    return;
  }

  try {
    await assertPublicHost(target);

    const report = await readNativeTools(target);
    if (!report) {
      throw new IntakeError(
        503,
        "renderer",
        "Graft could not open a browser to verify that page.",
        "Browser rendering is unavailable on this deployment.",
      );
    }

    const checks: Check[] = [];
    // Whether the API exists is a fact about the browser, not about the site.
    // Only what the page registers says anything about the page.
    checks.push({
      id: "model-context",
      label: "Verifier's browser supports WebMCP",
      pass: report.modelContextPresent,
      detail: report.modelContextPresent
        ? `Reading ${report.surface}.modelContext`
        : "This browser build exposes no modelContext, so nothing about the site can be concluded.",
    });

    checks.push({
      id: "tools-registered",
      label: "The site registers at least one tool",
      pass: report.tools.length > 0,
      inconclusive: !report.modelContextPresent,
      detail: !report.modelContextPresent
        ? "Not assessable without a WebMCP-capable browser."
        : report.tools.length > 0
          ? `${report.tools.length} tool${report.tools.length === 1 ? "" : "s"} registered.`
          : "The page registered no tools. If you just integrated an adapter, check that it runs and that registration is awaited.",
    });

    const findings = report.tools.map((tool) => inspectTool(tool, report.exposes));
    const withSchema = report.tools.filter((tool) => tool.inputSchema != null).length;
    const inspectable = withSchema > 0 || report.exposes.annotations;
    const flawed = findings.filter((finding) => finding.issues.length > 0);
    checks.push({
      id: "contract-quality",
      label: "Every contract is well formed",
      pass: report.tools.length > 0 && flawed.length === 0,
      inconclusive: report.tools.length === 0 || !inspectable,
      detail:
        report.tools.length === 0
          ? "No contracts to check."
          : !inspectable
            ? `This browser lists tools without their schemas or annotations, so contract quality cannot be judged here. Names and descriptions were checked and ${flawed.length === 0 ? "passed" : "did not"}. Re-run in Chrome 152 or later for the full check.`
            : flawed.length === 0
              ? `${withSchema} of ${report.tools.length} contracts exposed a schema to this browser, and everything readable is well formed.`
              : `${flawed.length} of ${report.tools.length} contracts have issues.`,
    });

    const names = report.tools.map((tool) => tool.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    checks.push({
      id: "unique-names",
      label: "Tool names are unique",
      pass: duplicates.length === 0,
      inconclusive: report.tools.length === 0,
      detail: duplicates.length === 0 ? "No collisions." : `Duplicated: ${[...new Set(duplicates)].join(", ")}`,
    });

    // Drift: what the owner shipped against what Graft last reviewed.
    let drift: { missing: string[]; added: string[] } | null = null;
    if (expectedRaw) {
      const expected: string[] = expectedRaw
        .split(",")
        .map((name: string) => name.trim())
        .filter(Boolean);
      const missing = expected.filter((name: string) => !names.includes(name));
      const added = names.filter((name) => !expected.includes(name));
      drift = { missing, added };
      checks.push({
        id: "no-drift",
        label: "Shipped surface matches the reviewed contract",
        pass: missing.length === 0,
        detail:
          missing.length === 0
            ? added.length === 0
              ? "Exactly the reviewed tools are live."
              : `All reviewed tools are live. ${added.length} additional tool(s) present: ${added.join(", ")}`
            : `Missing from the live site: ${missing.join(", ")}`,
      });
    }

    const decisive = checks.filter((check) => !check.inconclusive);
    const passed = decisive.filter((check) => check.pass).length;
    const skipped = checks.length - decisive.length;
    res.status(200).json({
      ok: true,
      url: target.href,
      verdict: decisive.every((check) => check.pass)
        ? skipped > 0
          ? "pass with gaps"
          : "pass"
        : "fail",
      skipped,
      passed,
      total: decisive.length,
      checks,
      tools: report.tools.map((tool) => tool.name),
      schemasVisible: withSchema,
      findings: flawed,
      drift,
      userAgent: report.userAgent,
    });
  } catch (error) {
    if (error instanceof IntakeError) {
      res
        .status(error.status)
        .json({ ok: false, reason: error.reason, message: error.message, detail: error.detail });
      return;
    }
    res.status(502).json({
      ok: false,
      reason: "network",
      message: "Graft could not verify that page.",
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}
