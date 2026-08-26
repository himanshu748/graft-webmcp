import type { GraftTool } from "./types";

const INTEGER_INPUT = /^-?\d+$/;
const NUMBER_INPUT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function strictNumber(value: string, integer: boolean): number {
  const normalized = value.trim();
  const isValid = (integer ? INTEGER_INPUT : NUMBER_INPUT).test(normalized);
  if (!isValid) return Number.NaN;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

export function coerceToolArguments(
  tool: GraftTool,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const required = new Set(tool.inputSchema.required ?? []);

  for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
    const value = values[name] ?? "";
    if (value.trim() === "" && !required.has(name)) continue;

    if (schema.type === "integer") args[name] = strictNumber(value, true);
    else if (schema.type === "number") args[name] = strictNumber(value, false);
    else if (schema.type === "boolean") args[name] = value === "true";
    else args[name] = value;
  }

  return args;
}
