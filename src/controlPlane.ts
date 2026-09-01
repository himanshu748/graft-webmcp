import type { GraftTool, ModelContextLike } from "./lib/types";

const MAX_OUTPUT = 1500;

export interface ControlPlaneSnapshot {
  sourceUrl: string;
  sourceKind: string;
  phase: string;
  tools: GraftTool[];
  registeredCount: number;
  webmcpAvailable: boolean;
}

export const CONTROL_TOOLS: Array<{ name: string; summary: string }> = [
  { name: "graft_status", summary: "What is compiled, and how many candidates at each status" },
  { name: "graft_compile_url", summary: "Compile any public URL into candidates" },
  { name: "graft_list_candidates", summary: "List candidates, filterable by status" },
  { name: "graft_inspect_candidate", summary: "Schema, annotations and scored evidence" },
  { name: "graft_set_candidate", summary: "Publish a held candidate, or hold a live one" },
  { name: "graft_export_adapter", summary: "Download the reviewed contract" },
  { name: "graft_verify_url", summary: "Check a deployed site's own WebMCP surface" },
];

export interface ControlPlaneHandlers {
  read(): ControlPlaneSnapshot;
  compileUrl(url: string): Promise<ControlPlaneSnapshot>;
  setCandidateStatus(name: string, status: "published" | "held"): Promise<ControlPlaneSnapshot>;
  exportAdapter(): { fileName: string; toolCount: number; eligible: number } | null;
  verifyUrl(url: string, expect: string[]): Promise<string>;
}

function text(value: string) {
  const clipped =
    value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT - 24)}\n...output truncated.` : value;
  return { content: [{ type: "text" as const, text: clipped }] };
}

function describe(snapshot: ControlPlaneSnapshot): string {
  const counts = snapshot.tools.reduce<Record<string, number>>((acc, tool) => {
    acc[tool.status] = (acc[tool.status] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `Compiled source: ${snapshot.sourceUrl || "none"} (${snapshot.sourceKind})`,
    `Phase: ${snapshot.phase}`,
    `Candidates: ${snapshot.tools.length} (${Object.entries(counts)
      .map(([key, value]) => `${value} ${key}`)
      .join(", ") || "none"})`,
    `Registered natively: ${snapshot.registeredCount}`,
    `WebMCP available in this browser: ${snapshot.webmcpAvailable ? "yes" : "no"}`,
  ].join("\n");
}

function candidateLine(tool: GraftTool): string {
  return `${tool.name} | ${tool.status} | confidence ${tool.confidence} | ${tool.recipe} | ${
    tool.readOnly ? "read-only" : "write"
  }`;
}

/**
 * Graft compiles other sites into tools. These are Graft's own controls, so an
 * agent can drive the product itself rather than only the page it compiled.
 * The `graft_` prefix is not decoration: compiling Graft's own interface
 * derives a `list_tool_candidates`, and two tools cannot share a name.
 */
export async function registerControlPlane(
  handlers: ControlPlaneHandlers,
  context: ModelContextLike,
  signal: AbortSignal,
): Promise<string[]> {
  const registered: string[] = [];

  const register = async (
    descriptor: Record<string, unknown> & { name: string },
  ): Promise<void> => {
    try {
      await context.registerTool({ ...descriptor, annotations: descriptor.annotations } as never, {
        signal,
      });
      registered.push(descriptor.name);
    } catch {
      try {
        const { annotations: _annotations, ...bare } = descriptor;
        await context.registerTool(bare as never, { signal });
        registered.push(descriptor.name);
      } catch {
        // A control tool that will not register is reported by omission.
      }
    }
  };

  await register({
    name: "graft_status",
    description:
      "Report what Graft currently has compiled: the source page, the compile phase, how many tool candidates exist at each status, how many are registered natively, and whether this browser exposes WebMCP. Call this first to orient before using the other graft_ tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute() {
      return text(describe(handlers.read()));
    },
  });

  await register({
    name: "graft_compile_url",
    description:
      "Compile a public web page into WebMCP tool candidates and register the confident ones. Pass an absolute http or https URL. Authentication, banking, mail and government domains are refused, robots.txt is honoured, and pages that need JavaScript are rendered before compiling. Returns the resulting candidate summary.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL of the page to compile." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: true },
    async execute(args: { url?: string }) {
      const url = String(args?.url ?? "").trim();
      if (!url) return text("Provide a url.");
      try {
        const snapshot = await handlers.compileUrl(url);
        return text(
          `${describe(snapshot)}\n\nCandidates:\n${snapshot.tools.map(candidateLine).join("\n")}`,
        );
      } catch (error) {
        return text(
          `Compile failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    },
  });

  await register({
    name: "graft_list_candidates",
    description:
      "List every tool candidate Graft derived from the current page, with its status, confidence score, recipe and whether it is read-only. Status is auto or published for registered tools, held for ones awaiting human review, and rejected for ones scored too low to offer.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional filter.",
          enum: ["auto", "published", "held", "rejected"],
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(args: { status?: string }) {
      const snapshot = handlers.read();
      const filtered = args?.status
        ? snapshot.tools.filter((tool) => tool.status === args.status)
        : snapshot.tools;
      if (filtered.length === 0) return text("No candidates match.");
      return text(filtered.map(candidateLine).join("\n"));
    },
  });

  await register({
    name: "graft_inspect_candidate",
    description:
      "Show one candidate in full: its description, JSON Schema, annotations, binding and the scored evidence behind its confidence number. Use it to decide whether a held candidate is safe to publish.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Candidate tool name." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(args: { name?: string }) {
      const snapshot = handlers.read();
      const tool = snapshot.tools.find((item) => item.name === args?.name);
      if (!tool) return text(`No candidate named ${args?.name}.`);
      return text(
        [
          `${tool.name} | ${tool.status} | confidence ${tool.confidence}`,
          tool.description,
          `Recipe ${tool.recipe} | binding ${tool.binding.kind} | ${tool.readOnly ? "read-only" : "write"}${tool.destructive ? " | destructive" : ""}`,
          `Selector: ${tool.selector}`,
          `Schema: ${JSON.stringify(tool.inputSchema)}`,
          `Why this score:\n${tool.confidenceReasons.map((reason) => `  ${reason}`).join("\n")}`,
        ].join("\n"),
      );
    },
  });

  await register({
    name: "graft_set_candidate",
    description:
      "Publish a held candidate so it registers with the browser, or hold a registered one so it stops being offered. This is the human review gate, so it asks for confirmation before it changes anything. Rejected candidates cannot be published.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Candidate tool name." },
        status: { type: "string", description: "Target status.", enum: ["published", "held"] },
      },
      required: ["name", "status"],
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: true },
    async execute(args: { name?: string; status?: string }) {
      const name = String(args?.name ?? "");
      const status = args?.status === "held" ? "held" : "published";
      try {
        const snapshot = await handlers.setCandidateStatus(name, status);
        const tool = snapshot.tools.find((item) => item.name === name);
        return text(
          tool
            ? `${tool.name} is now ${tool.status}. ${snapshot.registeredCount} tools registered natively.`
            : `No candidate named ${name}.`,
        );
      } catch (error) {
        return text(error instanceof Error ? error.message : "Could not change that candidate.");
      }
    },
  });

  await register({
    name: "graft_export_adapter",
    description:
      "Download a self-contained JavaScript adapter for the reviewed contract. Approved read tools run from its bundled DOM runtime; held writes stay in the manifest until the owner binds a handler. Returns the file name and how many candidates are eligible to register.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const result = handlers.exportAdapter();
      if (!result) return text("Nothing is compiled yet, so there is no adapter to export.");
      return text(
        `Exported ${result.fileName}. ${result.eligible} of ${result.toolCount} candidates are eligible to register; the rest are held or rejected and are included as reviewed metadata only.`,
      );
    },
  });

  await register({
    name: "graft_verify_url",
    description:
      "Verify a deployed site's own WebMCP surface. Graft opens the page in a headless browser, reads the tools it registers, and reports whether the contracts are well formed and uniquely named. Pass expect as a comma-separated list of tool names to also check for drift against a contract you shipped earlier.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL of the deployed page to verify." },
        expect: {
          type: "string",
          description: "Optional comma-separated tool names that should be live.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(args: { url?: string; expect?: string }) {
      const url = String(args?.url ?? "").trim();
      if (!url) return text("Provide a url.");
      const expect = String(args?.expect ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      try {
        return text(await handlers.verifyUrl(url, expect));
      } catch (error) {
        return text(`Verify failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    },
  });

  return registered;
}
