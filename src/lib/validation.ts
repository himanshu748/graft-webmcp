import type { GraftTool, JsonPrimitive, JsonSchema } from "./types";

export type ToolArgumentValidationCode =
  | "additional_property"
  | "invalid_enum"
  | "invalid_pattern"
  | "maximum"
  | "max_length"
  | "minimum"
  | "min_length"
  | "missing_required"
  | "wrong_type";

export interface ToolArgumentValidationIssue {
  path: string;
  code: ToolArgumentValidationCode;
  message: string;
}

export class ToolArgumentValidationError extends Error {
  readonly issues: ToolArgumentValidationIssue[];

  constructor(toolName: string, issues: ToolArgumentValidationIssue[]) {
    super(
      `Invalid arguments for “${toolName}”: ${issues.map((issue) => issue.message).join("; ")}`,
    );
    this.name = "ToolArgumentValidationError";
    this.issues = issues;
  }
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(schema: JsonSchema, value: unknown): boolean {
  switch (schema.type) {
    case undefined:
      return true;
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === schema.type;
  }
}

function enumIncludes(values: JsonPrimitive[], value: unknown): boolean {
  return values.some((candidate) => Object.is(candidate, value));
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: ToolArgumentValidationIssue[],
): void {
  if (!matchesType(schema, value)) {
    issues.push({
      path,
      code: "wrong_type",
      message: `${path} must be ${schema.type ?? "a valid value"}, received ${valueType(value)}`,
    });
    return;
  }

  if (schema.enum && !enumIncludes(schema.enum, value)) {
    issues.push({
      path,
      code: "invalid_enum",
      message: `${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({
        path,
        code: "min_length",
        message: `${path} must contain at least ${schema.minLength} characters`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        code: "max_length",
        message: `${path} must contain at most ${schema.maxLength} characters`,
      });
    }
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          issues.push({
            path,
            code: "invalid_pattern",
            message: `${path} must match pattern ${JSON.stringify(schema.pattern)}`,
          });
        }
      } catch {
        issues.push({
          path,
          code: "invalid_pattern",
          message: `${path} cannot be checked because its schema pattern is invalid`,
        });
      }
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({
        path,
        code: "minimum",
        message: `${path} must be at least ${schema.minimum}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({
        path,
        code: "maximum",
        message: `${path} must be at most ${schema.maximum}`,
      });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(schema.items as JsonSchema, item, `${path}[${index}]`, issues));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    validateObject(schema, value as Record<string, unknown>, path, issues);
  }
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  issues: ToolArgumentValidationIssue[],
): void {
  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (!own(value, required) || value[required] === undefined) {
      issues.push({
        path: `${path}.${required}`,
        code: "missing_required",
        message: `${path}.${required} is required`,
      });
    }
  }

  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const propertySchema = properties[key];
    if (propertySchema) {
      validateValue(propertySchema, item, childPath, issues);
      continue;
    }
    if (schema.additionalProperties === false) {
      issues.push({
        path: childPath,
        code: "additional_property",
        message: `${childPath} is not allowed`,
      });
      continue;
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      validateValue(schema.additionalProperties, item, childPath, issues);
    }
  }
}

export function validateToolArguments(
  tool: Pick<GraftTool, "name" | "inputSchema">,
  args: Record<string, unknown>,
): void {
  const issues: ToolArgumentValidationIssue[] = [];
  validateValue(tool.inputSchema, args, "$", issues);
  if (issues.length > 0) throw new ToolArgumentValidationError(tool.name, issues);
}
