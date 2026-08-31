/**
 * The browser runtime that ships inside every exported adapter.
 *
 * Graft already resolved which recipe and selector each tool needs, so an owner
 * should not have to reimplement DOM traversal the compiler solved. These
 * handlers drive the live page through the same executor the inspector uses.
 */
import { executeTool, toContentResult, type ExecuteToolOptions } from "./lib/execute";
import type { GraftTool, ToolContentResult, ToolExecutionResult } from "./lib/types";

export type GraftRuntimeOptions = Pick<
  ExecuteToolOptions,
  "root" | "confirm" | "maxOutputChars" | "runLiveSearch" | "settleQuietMs" | "settleTimeoutMs"
>;

export type GraftRuntimeHandler = (
  args?: Record<string, unknown>,
  context?: { signal?: AbortSignal },
) => Promise<ToolContentResult>;

/**
 * One handler per tool. Destructive tools still fail closed unless the owner
 * passes `confirm`, so wiring the runtime never widens what an agent can do.
 */
export function createGraftHandlers(
  tools: readonly GraftTool[],
  options: GraftRuntimeOptions = {},
): Record<string, GraftRuntimeHandler> {
  const handlers: Record<string, GraftRuntimeHandler> = {};
  for (const tool of tools) {
    handlers[tool.name] = async (args = {}, context = {}) =>
      toContentResult(await executeTool(tool, args, { ...options, signal: context.signal }));
  }
  return handlers;
}

export { executeTool, toContentResult };
export type { GraftTool, ToolContentResult, ToolExecutionResult };
