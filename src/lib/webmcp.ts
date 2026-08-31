import { deriveTools, toolSetFingerprint } from "./derive";
import { errorMessage } from "./dom-utils";
import {
  executeTool,
  type ExecuteToolOptions,
  type ToolConfirmationRequest,
  toContentResult,
} from "./execute";
import type {
  GraftLifecycleEvent,
  GraftTool,
  JsonValue,
  ModelContextLike,
  ModelContextToolDescriptor,
  ToolExecutionContext,
  ToolContentResult,
  ToolExecutionResult,
  ToolRegistrationReport,
} from "./types";

type GraftNavigator = Navigator & { modelContext?: ModelContextLike };
type GraftDocument = Document & { modelContext?: ModelContextLike };

const contextCleanupQueues = new WeakMap<ModelContextLike, Promise<void>>();

export interface WebMCPRegistryOptions {
  document?: Document;
  navigator?: Navigator;
  modelContext?: ModelContextLike;
  root?: ParentNode;
  maxOutputChars?: number;
  settleQuietMs?: number;
  settleTimeoutMs?: number;
  confirm?: (request: ToolConfirmationRequest) => boolean | Promise<boolean>;
  runLiveSearch?: ExecuteToolOptions["runLiveSearch"];
  onEvent?: (event: GraftLifecycleEvent) => void;
}

export interface WebMCPRegistrationLifecycleOptions extends WebMCPRegistryOptions {
  debounceMs?: number;
  observe?: boolean;
  derive?: (root: ParentNode) => GraftTool[];
}

function emptyReport(available: boolean): ToolRegistrationReport {
  return { available, registered: [], skipped: [], failures: [] };
}

function globalDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function globalNavigator(): Navigator | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

export function getModelContext(
  targetDocument: Document | undefined = globalDocument(),
  targetNavigator: Navigator | undefined = targetDocument?.defaultView?.navigator ?? globalNavigator(),
): ModelContextLike | null {
  const documentContext = (targetDocument as GraftDocument | undefined)?.modelContext;
  if (documentContext) return documentContext;
  return (targetNavigator as GraftNavigator | undefined)?.modelContext ?? null;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const validSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (validSignals.length === 0) return undefined;
  if (validSignals.length === 1) return validSignals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(validSignals);

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of validSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function isAbort(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name: unknown }).name === "AbortError",
  );
}

function cancelledExecution(error: unknown): ToolExecutionResult {
  return {
    ok: false,
    message: isAbort(error) ? "Cancelled: the tool call was aborted." : errorMessage(error),
  };
}

function registrationCandidates(tools: GraftTool[]): {
  candidates: GraftTool[];
  skipped: string[];
} {
  const candidates: GraftTool[] = [];
  const skipped: string[] = [];
  for (const tool of tools) {
    if (tool.status === "auto" || tool.status === "published") candidates.push(tool);
    else skipped.push(tool.name);
  }
  return { candidates, skipped };
}

function namesFromTools(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((tool) =>
      tool && typeof tool === "object" && "name" in tool
        ? String((tool as { name: unknown }).name)
        : "",
    )
    .filter(Boolean);
}

function serializableArgs(args: Record<string, unknown>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      output[key] = value as JsonValue;
      continue;
    }
    try {
      output[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      output[key] = String(value);
    }
  }
  return output;
}

function enqueueContextCleanup(
  modelContext: ModelContextLike,
  names: string[],
): Promise<void> {
  const previous = contextCleanupQueues.get(modelContext) ?? Promise.resolve();
  const cleanup = previous
    .catch(() => undefined)
    .then(async () => {
      if (!modelContext.unregisterTool || names.length === 0) return;
      await Promise.allSettled(names.map((name) => modelContext.unregisterTool?.(name)));
    });
  contextCleanupQueues.set(modelContext, cleanup);
  void cleanup.finally(() => {
    if (contextCleanupQueues.get(modelContext) === cleanup) {
      contextCleanupQueues.delete(modelContext);
    }
  });
  return cleanup;
}

export class WebMCPRegistry {
  readonly modelContext: ModelContextLike | null;

  private readonly options: WebMCPRegistryOptions;
  private registrationController: AbortController | null = null;
  private registeredNames: string[] = [];
  private activeExecutions = 0;
  private idleResolvers = new Set<() => void>();
  private listeningForToolChange = false;
  private disposed = false;
  private disposalPromise: Promise<void> | null = null;
  private reportValue: ToolRegistrationReport;

  constructor(options: WebMCPRegistryOptions = {}) {
    this.options = options;
    this.modelContext =
      options.modelContext ?? getModelContext(options.document, options.navigator);
    this.reportValue = emptyReport(Boolean(this.modelContext));
    this.listenForToolChanges();
  }

  get report(): ToolRegistrationReport {
    return {
      ...this.reportValue,
      registered: [...this.reportValue.registered],
      skipped: [...this.reportValue.skipped],
      failures: [...this.reportValue.failures],
    };
  }

  get inFlight(): number {
    return this.activeExecutions;
  }

  async register(tools: GraftTool[]): Promise<ToolRegistrationReport> {
    return this.replace(tools);
  }

  async replace(tools: GraftTool[]): Promise<ToolRegistrationReport> {
    if (this.disposed) throw new Error("Cannot register tools after the registry has been disposed.");
    if (!this.modelContext) {
      const report = emptyReport(false);
      report.skipped = tools.map((tool) => tool.name);
      this.reportValue = report;
      this.options.onEvent?.({ type: "unsupported" });
      return this.report;
    }

    await this.waitUntilIdle();
    await this.clearRegistrations();
    const registrationController = new AbortController();
    this.registrationController = registrationController;
    const { candidates, skipped } = registrationCandidates(tools);
    const report: ToolRegistrationReport = {
      available: true,
      registered: [],
      skipped,
      failures: [],
    };

    for (const tool of candidates) {
      if (registrationController.signal.aborted) break;
      const descriptor = this.descriptorFor(tool, registrationController.signal);
      try {
        await this.registerDescriptor(descriptor, registrationController.signal);
        report.registered.push(tool.name);
      } catch (error) {
        if (registrationController.signal.aborted || isAbort(error)) break;
        const message = errorMessage(error);
        report.failures.push({ name: tool.name, error: message });
        this.options.onEvent?.({ type: "registration_error", name: tool.name, error: message });
      }
    }

    this.registeredNames = [...report.registered];
    this.reportValue = report;
    this.options.onEvent?.({ type: "registered", report: this.report });
    return this.report;
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    this.disposalPromise = this.clearRegistrations().finally(() => {
      this.unlistenForToolChanges();
    });
    return this.disposalPromise;
  }

  private descriptorFor(tool: GraftTool, registrationSignal: AbortSignal): ModelContextToolDescriptor {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.readOnly,
        untrustedContentHint: true,
      },
      execute: async (
        args: Record<string, unknown>,
        context?: ToolExecutionContext,
      ): Promise<ToolContentResult> => {
        this.activeExecutions += 1;
        const eventArgs = serializableArgs(args);
        const startedAt = Date.now();
        this.options.onEvent?.({
          type: "execution_started",
          name: tool.name,
          args: eventArgs,
          startedAt,
        });
        const signal = combineSignals([registrationSignal, context?.signal]);
        let result: ToolExecutionResult;
        let status: "success" | "error" | "cancelled" = "success";
        try {
          const executeOptions: ExecuteToolOptions = {
            root: this.options.root ?? this.options.document ?? globalDocument(),
            signal,
            maxOutputChars: this.options.maxOutputChars,
            settleQuietMs: this.options.settleQuietMs,
            settleTimeoutMs: this.options.settleTimeoutMs,
            confirm: this.options.confirm,
            runLiveSearch: this.options.runLiveSearch,
          };
          result = await executeTool(tool, args, executeOptions);
          if (!result.ok) status = /cancel|confirm|blocked/i.test(result.message) ? "cancelled" : "error";
        } catch (error) {
          result = cancelledExecution(error);
          status = isAbort(error) ? "cancelled" : "error";
        } finally {
          this.activeExecutions -= 1;
          if (this.activeExecutions === 0) {
            for (const resolve of this.idleResolvers) resolve();
            this.idleResolvers.clear();
          }
        }
        this.options.onEvent?.({
          type: "execution_finished",
          name: tool.name,
          args: eventArgs,
          result,
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        return toContentResult(result);
      },
    };
  }

  private async registerDescriptor(
    descriptor: ModelContextToolDescriptor,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.modelContext) return;
    await this.modelContext.registerTool(descriptor, { signal });
  }

  private waitUntilIdle(): Promise<void> {
    if (this.activeExecutions === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  private async clearRegistrations(): Promise<void> {
    const names = [...this.registeredNames];
    this.registeredNames = [];
    this.registrationController?.abort("Tools replaced or registry disposed");
    this.registrationController = null;
    if (!this.modelContext) return;
    await enqueueContextCleanup(this.modelContext, names);
  }

  private readonly handleToolChange = async (): Promise<void> => {
    if (!this.modelContext) return;
    let names = [...this.registeredNames];
    try {
      if (this.modelContext.getTools) {
        names = namesFromTools(await this.modelContext.getTools(), names);
      }
    } catch {
      // Registration remains valid even if the optional inspector method fails.
    }
    this.options.onEvent?.({ type: "tools_changed", names });
  };

  private listenForToolChanges(): void {
    if (!this.modelContext || typeof this.modelContext.addEventListener !== "function") return;
    this.modelContext.addEventListener("toolchange", this.handleToolChange);
    this.listeningForToolChange = true;
  }

  private unlistenForToolChanges(): void {
    if (!this.listeningForToolChange || !this.modelContext) return;
    this.modelContext.removeEventListener("toolchange", this.handleToolChange);
    this.listeningForToolChange = false;
  }
}

export class WebMCPRegistrationLifecycle {
  readonly registry: WebMCPRegistry;

  private readonly options: WebMCPRegistrationLifecycleOptions;
  private readonly root: ParentNode;
  private observer: MutationObserver | null = null;
  private fingerprint = "";
  private refreshTimer = 0;
  private started = false;
  private restoreHistory: (() => void) | null = null;

  constructor(options: WebMCPRegistrationLifecycleOptions = {}) {
    const targetDocument = options.document ?? globalDocument();
    if (!options.root && !targetDocument) {
      throw new Error("A document or root is required outside a browser environment.");
    }
    this.options = options;
    this.root = options.root ?? (targetDocument as Document);
    this.registry = new WebMCPRegistry({ ...options, root: this.root });
  }

  async start(): Promise<ToolRegistrationReport> {
    if (this.started) return this.registry.report;
    this.started = true;
    const report = await this.refresh();
    if (this.options.observe !== false) this.startObservers();
    return report;
  }

  async refresh(): Promise<ToolRegistrationReport> {
    const derive = this.options.derive ?? deriveTools;
    const tools = derive(this.root);
    const nextFingerprint = toolSetFingerprint(tools);
    if (nextFingerprint === this.fingerprint) return this.registry.report;
    this.fingerprint = nextFingerprint;
    return this.registry.replace(tools);
  }

  scheduleRefresh = (): void => {
    if (!this.started) return;
    const ownerDocument =
      this.root.nodeType === 9
        ? (this.root as Document)
        : this.root.ownerDocument ?? globalDocument();
    const view = ownerDocument?.defaultView;
    view?.clearTimeout(this.refreshTimer);
    this.refreshTimer = view?.setTimeout(() => void this.refresh(), this.options.debounceMs ?? 400) ?? 0;
  };

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    this.restoreHistory?.();
    this.restoreHistory = null;
    const ownerDocument =
      this.root.nodeType === 9
        ? (this.root as Document)
        : this.root.ownerDocument ?? globalDocument();
    const view = ownerDocument?.defaultView;
    view?.clearTimeout(this.refreshTimer);
    view?.removeEventListener("popstate", this.scheduleRefresh);
    view?.removeEventListener("hashchange", this.scheduleRefresh);
    await this.registry.dispose();
  }

  private startObservers(): void {
    const ownerDocument =
      this.root.nodeType === 9
        ? (this.root as Document)
        : this.root.ownerDocument ?? globalDocument();
    const view = ownerDocument?.defaultView;
    const Observer = view?.MutationObserver;
    const observationTarget =
      this.root.nodeType === 9
        ? ownerDocument?.body ?? ownerDocument?.documentElement
        : (this.root as Node);
    if (Observer && observationTarget) {
      this.observer = new Observer((records) => {
        const relevant = records.some((record) => {
          const target =
            record.target.nodeType === 1
              ? (record.target as Element)
              : record.target.parentElement;
          return !target?.closest("[data-graft-ui]");
        });
        if (relevant) this.scheduleRefresh();
      });
      this.observer.observe(observationTarget, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["id", "class", "name", "role", "aria-label", "aria-labelledby", "title"],
      });
    }
    view?.addEventListener("popstate", this.scheduleRefresh);
    view?.addEventListener("hashchange", this.scheduleRefresh);
    this.restoreHistory = this.patchHistory(view ?? undefined);
  }

  private patchHistory(view: Window | undefined): (() => void) | null {
    if (!view) return null;
    const history = view.history;
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    const schedule = () => this.scheduleRefresh();
    const patchedPushState: History["pushState"] = function (this: History, ...args) {
      pushState.apply(this, args);
      schedule();
    };
    const patchedReplaceState: History["replaceState"] = function (this: History, ...args) {
      replaceState.apply(this, args);
      schedule();
    };
    try {
      history.pushState = patchedPushState;
      history.replaceState = patchedReplaceState;
    } catch {
      return null;
    }
    return () => {
      if (history.pushState === patchedPushState) history.pushState = pushState;
      if (history.replaceState === patchedReplaceState) history.replaceState = replaceState;
    };
  }
}

export async function registerWebMCPTools(
  tools: GraftTool[],
  options: WebMCPRegistryOptions = {},
): Promise<{ registry: WebMCPRegistry; report: ToolRegistrationReport }> {
  const registry = new WebMCPRegistry(options);
  const report = await registry.register(tools);
  return { registry, report };
}
