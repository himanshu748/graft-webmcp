import {
  ArrowRight,
  Check,
  DownloadSimple,
  Lightning,
  LockKey,
  Play,
  ShieldCheck,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fixtureDefinitions,
  getFixture,
  type FixtureId,
} from "./data/fixtures";
import {
  fetchLiveSource,
  fixtureSource,
  IntakeRequestError,
  livePresets,
  pasteSource,
  shouldCompileFixtureOnModeSelection,
  type ActiveSource,
  type IntakeFailure,
} from "./data/sources";
import {
  compileDocument,
  coerceToolArguments,
  executeTool,
  toContentResult,
  WebMCPRegistry,
  type GraftLifecycleEvent,
  type GraftTool,
  type JsonSchema,
  type PageSnapshot,
  type ToolRegistrationReport,
} from "./lib";
import {
  sanitizeFixtureHtml,
  serializeSanitizedDocument,
} from "./sanitize";
import { buildAdapterModule } from "./export-adapter";
import graftRuntimeSource from "./generated/graft-runtime.js?raw";
import { runLiveSearch } from "./liveSearch";
import {
  CONTROL_TOOLS,
  registerControlPlane,
  type ControlPlaneSnapshot,
} from "./controlPlane";
import { getModelContext } from "./lib/webmcp";

type CompilePhase = "ready" | "compiling" | "complete" | "error";
type IntakeMode = "live" | "paste" | "fixture";
type IntakeStatus = "idle" | "loading";


/** Reasons where a second attempt could plausibly succeed. */
const RETRYABLE_REASONS = new Set(["network", "status", "boot", "dns", "redirects"]);

const INTAKE_MODES: Array<{ id: IntakeMode; label: string }> = [
  { id: "live", label: "Live URL" },
  { id: "paste", label: "Paste HTML" },
  { id: "fixture", label: "Owned fixture" },
];
type MobileBenchView = "preview" | "tools";
type RunState = "success" | "error" | "cancelled";

interface TimelineEntry {
  id: string;
  time: string;
  name: string;
  arguments: unknown;
  result: unknown;
  duration: number;
  state: RunState;
}

interface ExportFeedback {
  kind: "copied" | "prepared";
  fileName: string;
  eligible: number;
}

interface VerificationCheck {
  id: string;
  label: string;
  pass: boolean;
  inconclusive?: boolean;
  detail: string;
}

interface VerificationFinding {
  name: string;
  issues: string[];
}

interface VerificationDrift {
  missing: string[];
  added: string[];
  exact: boolean;
}

interface VerificationReport {
  ok: true;
  url: string;
  verdict: "pass" | "pass with gaps" | "fail";
  skipped: number;
  passed: number;
  total: number;
  checks: VerificationCheck[];
  tools: string[];
  schemasVisible: number;
  findings: VerificationFinding[];
  drift: VerificationDrift | null;
  userAgent: string;
}

interface VerificationFailure {
  message: string;
  detail?: string;
}

const AGENT_REVIEW_ROOM_PRESET = {
  url: "https://omnidev-flame.vercel.app/agent-lab/",
  tools: [
    "get_page_summary",
    "get_page_outline",
    "list_files",
    "get_file",
    "list_patches",
    "get_patch",
    "list_test_results",
    "apply_patch",
  ],
} as const;

type VerificationStatus = "idle" | "loading" | "complete" | "error";

interface PendingConfirmation {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (approved: boolean) => void;
}

interface StoredToolReview {
  status: "auto" | "held" | "published";
  name?: string;
  description?: string;
}

interface StoredReviewEnvelope {
  version: 1;
  tools: Record<string, StoredToolReview>;
}

interface SanitizationReadout {
  removedNodes: number;
  removedAttributes: number;
  neutralizedCssReferences: number;
}

const EMPTY_REGISTRATION: ToolRegistrationReport = {
  available: false,
  registered: [],
  skipped: [],
  failures: [],
};

const WAIT = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
const DEMO_OUTPUT_BUDGET = 8_000;

function adapterFileName(sourceKey: string | null): string {
  const slug = (sourceKey ?? "adapter")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "adapter";
  return `graft-${slug}.js`;
}

function serializeJson(value: unknown, spacing?: number): string {
  try {
    return JSON.stringify(value, null, spacing) ?? "null";
  } catch {
    return JSON.stringify({ value: String(value), serializationError: true }, null, spacing);
  }
}

function compactJson(value: unknown, maxLength = 160): string {
  const serialized = serializeJson(value);
  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength - 1)}…`
    : serialized;
}

function isCancellation(value: unknown): boolean {
  if (value && typeof value === "object" && "name" in value) {
    if (String((value as { name: unknown }).name) === "AbortError") return true;
  }
  const message =
    value && typeof value === "object" && "message" in value
      ? String((value as { message: unknown }).message)
      : String(value ?? "");
  return /abort|cancel|confirm|blocked/i.test(message);
}

function missingExpectedTools(
  expected: readonly { name: string }[],
  compiledTools: readonly GraftTool[],
): string[] {
  const compiledNames = new Set(compiledTools.map((tool) => tool.name));
  return expected
    .map((tool) => tool.name)
    .filter((name) => !compiledNames.has(name));
}

function defaultArguments(tool: GraftTool | null): Record<string, string> {
  if (!tool) return {};
  const values: Record<string, string> = {};
  for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
    const defaultValue = schema.default ?? schema.enum?.[0];
    if (defaultValue !== undefined && defaultValue !== null) {
      values[name] = String(defaultValue);
      continue;
    }
    if (schema.type === "integer" || schema.type === "number") {
      values[name] = String(schema.minimum ?? "");
      continue;
    }
    values[name] = "";
  }
  return values;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

function isStoredToolReview(value: unknown): value is StoredToolReview {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!["auto", "held", "published"].includes(String(candidate.status))) return false;
  if (
    candidate.name !== undefined &&
    (typeof candidate.name !== "string" || !TOOL_NAME_PATTERN.test(candidate.name))
  ) {
    return false;
  }
  if (
    candidate.description !== undefined &&
    (typeof candidate.description !== "string" ||
      candidate.description.length < 20 ||
      candidate.description.length > 500)
  ) {
    return false;
  }
  return true;
}

function storedReviews(sourceKey: string): Record<string, StoredToolReview> {
  try {
    const stored = window.localStorage.getItem(`graft:review:${sourceKey}`);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const envelope = parsed as Partial<StoredReviewEnvelope>;
    if (envelope.version !== 1 || !envelope.tools || typeof envelope.tools !== "object") {
      return {};
    }
    const valid = Object.entries(envelope.tools).filter(([, review]) =>
      isStoredToolReview(review),
    );
    if (valid.length !== Object.keys(envelope.tools).length) return {};
    return Object.fromEntries(valid) as Record<string, StoredToolReview>;
  } catch {
    return {};
  }
}

function persistReviews(sourceKey: string, tools: GraftTool[]): void {
  const reviews = Object.fromEntries(
    tools
      .filter((tool) => tool.origin === "human")
      .map((tool) => [
        tool.id,
        {
          status:
            tool.status === "rejected" ? "held" : tool.status,
          name: tool.name,
          description: tool.description,
        } satisfies StoredToolReview,
      ]),
  );
  const envelope: StoredReviewEnvelope = { version: 1, tools: reviews };
  window.localStorage.setItem(
    `graft:review:${sourceKey}`,
    JSON.stringify(envelope),
  );
}

function controlRegistrationLabel(
  report: ToolRegistrationReport,
  controlCount: number,
): string {
  if (controlCount > 0) return `${controlCount} WebMCP tools live`;
  if (!report.available) return "WebMCP not detected";
  return "Graft tools pending";
}

function statusLabel(status: GraftTool["status"]): string {
  if (status === "auto") return "Auto";
  if (status === "published") return "Published";
  if (status === "held") return "Held";
  return "Rejected";
}

interface SchemaFieldProps {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: string;
  onChange: (name: string, value: string) => void;
}

function SchemaField({
  name,
  schema,
  required,
  value,
  onChange,
}: SchemaFieldProps) {
  const inputId = `argument-${name}`;
  const hintId = `${inputId}-hint`;
  const label = `${name}${required ? " *" : ""}`;
  const describedBy = schema.description ? hintId : undefined;
  if (schema.enum?.length) {
    return (
      <div className="argument-field">
        <label htmlFor={inputId}>{label}</label>
        <select
          id={inputId}
          value={value}
          aria-describedby={describedBy}
          onChange={(event) => onChange(name, event.target.value)}
          required={required}
        >
          {!required && <option value="">Any</option>}
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
        {schema.description && <span id={hintId} className="field-hint">{schema.description}</span>}
      </div>
    );
  }

  if (schema.type === "boolean") {
    return (
      <div className="argument-field">
        <label htmlFor={inputId}>{label}</label>
        <select
          id={inputId}
          value={value}
          aria-describedby={describedBy}
          onChange={(event) => onChange(name, event.target.value)}
          required={required}
        >
          {!required && <option value="">Any</option>}
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
        {schema.description && <span id={hintId} className="field-hint">{schema.description}</span>}
      </div>
    );
  }

  const numeric = schema.type === "integer" || schema.type === "number";
  return (
    <div className="argument-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="text"
        aria-describedby={describedBy}
        inputMode={numeric ? (schema.type === "integer" ? "numeric" : "decimal") : undefined}
        pattern={
          schema.type === "integer"
            ? "-?[0-9]+"
            : schema.type === "number"
              ? "-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?"
              : undefined
        }
        value={value}
        minLength={!numeric ? schema.minLength : undefined}
        maxLength={!numeric ? schema.maxLength : undefined}
        placeholder={numeric ? String(schema.default ?? schema.minimum ?? "0") : undefined}
        spellCheck={false}
        onChange={(event) => onChange(name, event.target.value)}
        required={required}
      />
      {schema.description && <span id={hintId} className="field-hint">{schema.description}</span>}
    </div>
  );
}

interface ConfirmDialogProps {
  pending: PendingConfirmation | null;
  onSettle: (approved: boolean) => void;
}

function ConfirmDialog({ pending, onSettle }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onSettle(false);
      }}
    >
      <div className="dialog-signal" aria-hidden="true" />
      <div className="dialog-body">
        <span className="panel-kicker">Local mutation gate</span>
        <h2 id="confirm-title">Confirm this demo action.</h2>
        <p>
          <code>{pending?.toolName}</code> will update only the inert fixture held in
          this browser tab. No request, purchase or third-party state change can occur.
        </p>
        <pre className="schema-code">{compactJson(pending?.args ?? {}, 500)}</pre>
        <div className="dialog-actions">
          <button type="button" onClick={() => onSettle(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="confirm-button"
            onClick={() => onSettle(true)}
          >
            Confirm local action
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function App() {
  const initialFixture = fixtureDefinitions[0]?.id ?? "catalog";
  const [selectedFixtureId, setSelectedFixtureId] =
    useState<FixtureId>(initialFixture);
  const [compiledSourceKey, setCompiledSourceKey] = useState<string | null>(null);
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("live");
  const [urlInput, setUrlInput] = useState(livePresets[0]?.url ?? "");
  const [pasteInput, setPasteInput] = useState("");
  const [intakeStatus, setIntakeStatus] = useState<IntakeStatus>("idle");
  const [intakeFailure, setIntakeFailure] = useState<IntakeFailure | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveSource | null>(null);
  const [phase, setPhase] = useState<CompilePhase>("ready");
  const [compileStage, setCompileStage] = useState(0);
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [tools, setTools] = useState<GraftTool[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [registration, setRegistration] =
    useState<ToolRegistrationReport>(EMPTY_REGISTRATION);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [argumentValues, setArgumentValues] = useState<Record<string, string>>({});
  const [mobileView, setMobileView] = useState<MobileBenchView>("tools");
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  const [sanitization, setSanitization] = useState<SanitizationReadout>({
    removedNodes: 0,
    removedAttributes: 0,
    neutralizedCssReferences: 0,
  });
  const [controlToolNames, setControlToolNames] = useState<string[]>([]);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [draftToolName, setDraftToolName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [verificationUrl, setVerificationUrl] = useState("");
  const [verificationExpected, setVerificationExpected] = useState("");
  const [verificationStatus, setVerificationStatus] =
    useState<VerificationStatus>("idle");
  const [verificationReport, setVerificationReport] =
    useState<VerificationReport | null>(null);
  const [verificationFailure, setVerificationFailure] =
    useState<VerificationFailure | null>(null);

  const controlStateRef = useRef<ControlPlaneSnapshot>({
    sourceUrl: "",
    sourceKind: "none",
    phase: "ready",
    tools: [],
    registeredCount: 0,
    webmcpAvailable: false,
  });
  const controlActionsRef = useRef<{
    compile: (url: string) => Promise<void>;
    setStatus: (name: string, status: "published" | "held") => Promise<void>;
    exportAdapter: () => { fileName: string; toolCount: number; eligible: number } | null;
  } | null>(null);
  const sourceDocumentRef = useRef<Document | null>(null);
  const registryRef = useRef<WebMCPRegistry | null>(null);
  const compileTokenRef = useRef(0);
  const externalStartRef = useRef(new Map<string, number>());
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);
  const verificationRequestRef = useRef<AbortController | null>(null);

  const selectedFixture = getFixture(selectedFixtureId);
  const selectedTool =
    tools.find((candidate) => candidate.id === selectedToolId) ?? tools[0] ?? null;

  const eligibleCount = tools.filter(
    (tool) => tool.status === "auto" || tool.status === "published",
  ).length;
  const heldCount = tools.filter((tool) => tool.status === "held").length;

  const requestConfirmation = useCallback(
    (request: { tool: GraftTool; args: Record<string, unknown> }) =>
      new Promise<boolean>((resolve) => {
        setPendingConfirmation((current) => {
          current?.resolve(false);
          return {
            toolName: request.tool.name,
            args: request.args,
            resolve,
          };
        });
      }),
    [],
  );

  const settleConfirmation = useCallback(
    (approved: boolean) => {
      if (!pendingConfirmation) return;
      pendingConfirmation.resolve(approved);
      setPendingConfirmation(null);
    },
    [pendingConfirmation],
  );

  const addTimelineEntry = useCallback(
    (entry: Omit<TimelineEntry, "id" | "time">) => {
      setTimeline((current) => [
        {
          ...entry,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          time: new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(new Date()),
        },
        ...current,
      ].slice(0, 20));
    },
    [],
  );

  const handleLifecycleEvent = useCallback(
    (event: GraftLifecycleEvent) => {
      if (event.type === "registered") setRegistration(event.report);
      if (event.type === "unsupported") setRegistration(EMPTY_REGISTRATION);
      if (event.type === "execution_started") {
        externalStartRef.current.set(event.name, performance.now());
      }
      if (event.type === "execution_finished") {
        externalStartRef.current.delete(event.name);
        addTimelineEntry({
          name: event.name,
          arguments: event.args,
          result: event.result,
          duration: event.durationMs,
          state: event.status,
        });
        const sourceDocument = sourceDocumentRef.current;
        if (sourceDocument) setPreviewHtml(serializeSanitizedDocument(sourceDocument));
      }
      if (event.type === "registration_error") {
        setError(`${event.name}: ${event.error}`);
      }
    },
    [addTimelineEntry],
  );

  const compileSource = useCallback(async (source: ActiveSource) => {
    const token = compileTokenRef.current + 1;
    compileTokenRef.current = token;
    setPhase("compiling");
    setCompileStage(0);
    setError(null);
    setMobileView("tools");
    setActiveSource(source);
    setTimeline([]);
    setExportFeedback(null);
    externalStartRef.current.clear();
    const sourceKey = source.kind === "fixture" ? source.id : source.sourceUrl;

    try {
      await WAIT(100);
      if (compileTokenRef.current !== token) return;
      const sanitized = sanitizeFixtureHtml(source.html, source.kind === "live" ? source.sourceUrl : undefined);
      const sourceDocument = sanitized.document;
      setCompileStage(1);

      await WAIT(140);
      if (compileTokenRef.current !== token) return;
      const compilation = compileDocument(sourceDocument);

      const missingTools =
        source.kind === "fixture"
          ? missingExpectedTools(getFixture(source.id as FixtureId).expectedTools, compilation.tools)
          : [];
      if (missingTools.length > 0) {
        const previousRegistry = registryRef.current;
        registryRef.current = null;
        await previousRegistry?.dispose();
        setRegistration(EMPTY_REGISTRATION);
        setSnapshot(null);
        setTools([]);
        setSelectedToolId(null);
        setPreviewHtml("");
        throw new Error(
          `Fixture contract mismatch: missing ${missingTools.join(", ")}. Registration blocked.`,
        );
      }
      const reviews = storedReviews(sourceKey);
      const reviewedTools: GraftTool[] = compilation.tools.map((tool) => {
        const review = reviews[tool.id];
        if (!review) return tool;
        return {
          ...tool,
          status: review.status,
          name: review.name ?? tool.name,
          description: review.description ?? tool.description,
          origin: "human",
        };
      });

      sourceDocumentRef.current = sourceDocument;
      setSnapshot(compilation.snapshot);
      setTools(reviewedTools);
      setSelectedToolId(
        reviewedTools.find((tool) => tool.name === "search_catalog")?.id ??
          reviewedTools.find(
            (tool) =>
              tool.status === "auto" && !tool.name.startsWith("get_page_"),
          )?.id ??
          reviewedTools[0]?.id ??
          null,
      );
      setPreviewHtml(serializeSanitizedDocument(sourceDocument));
      setSanitization({
        removedNodes: sanitized.removedNodes,
        removedAttributes: sanitized.removedAttributes,
        neutralizedCssReferences: sanitized.neutralizedCssReferences,
      });
      setCompiledSourceKey(sourceKey);
      setCompileStage(2);

      const previousRegistry = registryRef.current;
      registryRef.current = null;
      await previousRegistry?.dispose();
      if (compileTokenRef.current !== token) return;
      const registry = new WebMCPRegistry({
        root: sourceDocument,
        maxOutputChars: DEMO_OUTPUT_BUDGET,
        confirm: requestConfirmation,
        runLiveSearch: source.kind === "live" ? runLiveSearch : undefined,
        onEvent: handleLifecycleEvent,
      });
      registryRef.current = registry;
      await registry.register(reviewedTools);
      if (compileTokenRef.current !== token) {
        await registry.dispose();
        return;
      }
      setRegistration(registry.report);
      setPhase("complete");
    } catch (caught) {
      if (compileTokenRef.current !== token) return;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "Compilation failed.");
    }
  }, [handleLifecycleEvent, requestConfirmation]);

  const runLiveIntake = useCallback(
    async (rawUrl: string) => {
      const target = rawUrl.trim();
      if (!target) return;
      setIntakeStatus("loading");
      setIntakeFailure(null);
      setPhase("compiling");
      setCompileStage(0);
      try {
        const source = await fetchLiveSource(target);
        setUrlInput(source.sourceUrl);
        await compileSource(source);
      } catch (caught) {
        const failure: IntakeFailure =
          caught instanceof IntakeRequestError
            ? caught.failure
            : {
                reason: "network",
                message: "Graft could not reach that page.",
                detail: caught instanceof Error ? caught.message : undefined,
              };
        setIntakeFailure(failure);
        setPhase("ready");
      } finally {
        setIntakeStatus("idle");
      }
    },
    [compileSource],
  );

  const compileActiveIntake = useCallback(() => {
    setIntakeFailure(null);
    if (intakeMode === "live") return void runLiveIntake(urlInput);
    if (intakeMode === "paste") {
      if (!pasteInput.trim()) {
        setIntakeFailure({
          reason: "empty",
          message: "Paste some HTML first.",
          detail: "Anything with a form, list or table will produce tools.",
        });
        return;
      }
      return void compileSource(pasteSource(pasteInput));
    }
    return void compileSource(fixtureSource(selectedFixtureId));
  }, [compileSource, intakeMode, pasteInput, runLiveIntake, selectedFixtureId, urlInput]);

  // First paint compiles a real page, not a fixture. The fixture is the
  // fallback so the bench is never empty if the network is unavailable.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const boot = async () => {
      const preset = livePresets[0];
      if (!preset) return void compileSource(fixtureSource(selectedFixtureId));
      try {
        const source = await fetchLiveSource(preset.url);
        setUrlInput(source.sourceUrl);
        await compileSource(source);
      } catch {
        setIntakeMode("fixture");
        setIntakeFailure({
          reason: "boot",
          message: "Live intake is unavailable right now.",
          detail: "Graft loaded an owned fixture instead. The compiler is identical.",
        });
        await compileSource(fixtureSource(selectedFixtureId));
      }
    };
    void boot();
  }, [compileSource, selectedFixtureId]);

  const settleControlState = useCallback(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await WAIT(100);
      if (controlStateRef.current.phase !== "compiling") return;
    }
  }, []);

  // Graft compiles other sites into tools. This exposes Graft's own controls,
  // so an agent can drive the product rather than only the page it compiled.
  useEffect(() => {
    const context = getModelContext();
    if (!context) return;
    const controller = new AbortController();
    void registerControlPlane(
      {
        read: () => controlStateRef.current,
        compileUrl: async (url: string) => {
          await controlActionsRef.current?.compile(url);
          // The compile resolves before React has re-rendered and registration
          // has settled, so reporting immediately would hand the agent stale
          // counts and a phase of "compiling".
          await settleControlState();
          return controlStateRef.current;
        },
        setCandidateStatus: async (name, status) => {
          await controlActionsRef.current?.setStatus(name, status);
          await settleControlState();
          return controlStateRef.current;
        },
        exportAdapter: () => controlActionsRef.current?.exportAdapter() ?? null,
        verifyUrl: async (url: string, expect: string[]) => {
          const query = new URLSearchParams({ url });
          if (expect.length > 0) query.set("expect", expect.join(","));
          const response = await fetch(`/api/verify?${query.toString()}`);
          const payload = await response.json();
          if (!payload?.ok) {
            return `Could not verify ${url}: ${payload?.message ?? "unknown error"}`;
          }
          const lines = [
            `${payload.url}`,
            `Verdict: ${payload.verdict} (${payload.passed}/${payload.total} decisive checks, ${payload.skipped} inconclusive)`,
            `Tools registered: ${payload.tools.length}${payload.tools.length ? ` (${payload.tools.join(", ")})` : ""}`,
            ...payload.checks.map(
              (check: { pass: boolean; inconclusive?: boolean; label: string; detail: string }) =>
                `${check.inconclusive ? "SKIP" : check.pass ? "PASS" : "FAIL"} ${check.label}: ${check.detail}`,
            ),
          ];
          if (payload.drift) {
            if (payload.drift.missing.length > 0) {
              lines.push(`Drift: missing ${payload.drift.missing.join(", ")}`);
            }
            if (payload.drift.added.length > 0) {
              lines.push(`Drift: added ${payload.drift.added.join(", ")}`);
            }
          }
          for (const finding of payload.findings ?? []) {
            lines.push(`Issue in ${finding.name}: ${finding.issues.join("; ")}`);
          }
          return lines.join("\n");
        },
      },
      context,
      controller.signal,
    ).then(setControlToolNames);
    return () => {
      controller.abort();
      setControlToolNames([]);
    };
  }, []);

  useEffect(() => {
    pendingConfirmationRef.current = pendingConfirmation;
  }, [pendingConfirmation]);

  useEffect(() => {
    return () => {
      compileTokenRef.current += 1;
      void registryRef.current?.dispose();
      pendingConfirmationRef.current?.resolve(false);
      verificationRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setArgumentValues(defaultArguments(selectedTool));
    setEditingToolId(null);
  }, [selectedTool?.id]);

  const publishSelectedTool = useCallback(async () => {
    if (!selectedTool || selectedTool.status === "rejected") return;
    const nextStatus: GraftTool["status"] =
      selectedTool.status === "held" ? "published" : "held";
    const nextTools: GraftTool[] = tools.map((tool) =>
      tool.id === selectedTool.id
        ? { ...tool, status: nextStatus, origin: "human" as const }
        : tool,
    );
    setTools(nextTools);

    try {
      persistReviews(compiledSourceKey ?? selectedFixtureId, nextTools);
    } catch {
      setError("The browser blocked local review persistence.");
    }

    const registry = registryRef.current;
    if (registry) {
      await registry.replace(nextTools);
      setRegistration(registry.report);
    }
  }, [selectedFixtureId, selectedTool, tools]);

  const setToolStatusByName = useCallback(
    async (name: string, nextStatus: "published" | "held") => {
      const target = tools.find((tool) => tool.name === name);
      if (!target) throw new Error(`No candidate named ${name}.`);
      if (target.status === "rejected") {
        throw new Error(`${name} was rejected by the confidence gate and cannot be published.`);
      }
      const nextTools: GraftTool[] = tools.map((tool) =>
        tool.id === target.id
          ? { ...tool, status: nextStatus, origin: "human" as const }
          : tool,
      );
      setTools(nextTools);
      try {
        persistReviews(compiledSourceKey ?? selectedFixtureId, nextTools);
      } catch {
        setError("The browser blocked local review persistence.");
      }
      const registry = registryRef.current;
      if (registry) {
        await registry.replace(nextTools);
        setRegistration(registry.report);
      }
    },
    [compiledSourceKey, selectedFixtureId, tools],
  );

  const beginToolEdit = useCallback(() => {
    if (!selectedTool) return;
    setDraftToolName(selectedTool.name);
    setDraftDescription(selectedTool.description);
    setEditingToolId(selectedTool.id);
  }, [selectedTool]);

  const saveToolEdit = useCallback(async () => {
    if (!selectedTool || editingToolId !== selectedTool.id) return;
    const name = draftToolName.trim();
    const description = draftDescription.trim();
    if (!TOOL_NAME_PATTERN.test(name)) {
      setError("Tool names must start with a letter and use up to 30 lowercase letters, numbers or underscores.");
      return;
    }
    if (description.length < 20 || description.length > 500) {
      setError("Tool descriptions must contain 20 to 500 characters.");
      return;
    }
    if (tools.some((tool) => tool.id !== selectedTool.id && tool.name === name)) {
      setError(`Another candidate already uses ${name}.`);
      return;
    }

    const nextTools: GraftTool[] = tools.map((tool) =>
      tool.id === selectedTool.id
        ? {
            ...tool,
            name,
            description,
            status: tool.status === "held" ? "published" : tool.status,
            origin: "human",
          }
        : tool,
    );
    setTools(nextTools);
    setEditingToolId(null);
    setError(null);
    try {
      persistReviews(compiledSourceKey ?? selectedFixtureId, nextTools);
    } catch {
      setError("The browser blocked local review persistence.");
    }
    const registry = registryRef.current;
    if (registry) {
      await registry.replace(nextTools);
      setRegistration(registry.report);
    }
  }, [
    draftDescription,
    draftToolName,
    editingToolId,
    selectedFixtureId,
    selectedTool,
    tools,
  ]);

  const runSelectedTool = useCallback(async () => {
    const tool = selectedTool;
    const sourceDocument = sourceDocumentRef.current;
    if (!tool || !sourceDocument) return;
    const args = coerceToolArguments(tool, argumentValues);
    const missing = (tool.inputSchema.required ?? []).find(
      (name) => args[name] === "" || args[name] === undefined,
    );
    if (missing) {
      setError(`Add a value for ${missing} before running this tool.`);
      return;
    }
    if (tool.status === "held" || tool.status === "rejected") {
      setError("Publish this held tool before running it.");
      return;
    }

    setError(null);
    setRunningTool(tool.id);
    const started = performance.now();
    try {
      const result = await executeTool(tool, args, {
        root: sourceDocument,
        maxOutputChars: DEMO_OUTPUT_BUDGET,
        confirm: requestConfirmation,
        runLiveSearch,
      });
      const duration = Math.max(0, Math.round(performance.now() - started));
      addTimelineEntry({
        name: tool.name,
        arguments: args,
        result: toContentResult(result),
        duration,
        state: result.ok ? "success" : isCancellation(result) ? "cancelled" : "error",
      });
      setPreviewHtml(serializeSanitizedDocument(sourceDocument));
      if (!result.ok) setError(result.message);
    } catch (caught) {
      const failure = {
        ok: false as const,
        message: caught instanceof Error ? caught.message : "Execution failed",
      };
      addTimelineEntry({
        name: tool.name,
        arguments: args,
        result: toContentResult(failure),
        duration: Math.max(0, Math.round(performance.now() - started)),
        state: isCancellation(caught) ? "cancelled" : "error",
      });
      setError(caught instanceof Error ? caught.message : "Execution failed.");
    } finally {
      setRunningTool(null);
    }
  }, [addTimelineEntry, argumentValues, requestConfirmation, selectedTool]);

  const buildExport = useCallback(() => {
    if (!snapshot || tools.length === 0) return null;
    const manifest = {
      product: "Graft",
      version: 1,
      source: {
        id: compiledSourceKey,
        title: snapshot.title,
        kind: activeSource?.kind ?? "fixture",
        url: activeSource?.sourceUrl ?? "",
      },
      generatedAt: new Date().toISOString(),
      notice: "Migration starting point. Review and test in the owner site before shipping.",
      // The binding fields travel with the contract so the inlined runtime can
      // resolve the same element the compiler scored.
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          untrustedContentHint: true,
        },
        status: tool.status,
        recipe: tool.recipe,
        selector: tool.selector,
        fallbackSelectors: tool.fallbackSelectors,
        action: tool.action,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        binding: tool.binding,
      })),
    };

    const exported = manifest.tools
      .filter((tool) => tool.status === "auto" || tool.status === "published")
      .map(({ status: _status, ...tool }) => tool);
    const source = buildAdapterModule(manifest, exported, graftRuntimeSource);
    const fileName = adapterFileName(compiledSourceKey);
    return { source, fileName, toolCount: manifest.tools.length, eligible: exported.length };
  }, [activeSource, compiledSourceKey, snapshot, tools]);

  const exportAdapter = useCallback(() => {
    const built = buildExport();
    if (!built) return null;
    const blob = new Blob([built.source], { type: "text/javascript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = built.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setExportFeedback({
      kind: "prepared",
      fileName: built.fileName,
      eligible: built.eligible,
    });
    return { fileName: built.fileName, toolCount: built.toolCount, eligible: built.eligible };
  }, [buildExport]);

  const copyAdapter = useCallback(async () => {
    const built = buildExport();
    if (!built) return null;
    try {
      await navigator.clipboard.writeText(built.source);
      setExportFeedback({
        kind: "copied",
        fileName: built.fileName,
        eligible: built.eligible,
      });
    } catch {
      // Every insecure context and some browsers refuse clipboard writes. A
      // button that silently does nothing is worse than one that falls back.
      exportAdapter();
    }
    return built;
  }, [buildExport, exportAdapter]);

  const verifyDeployment = useCallback(async (override?: {
    url?: string;
    expected?: readonly string[];
  }) => {
    const target = override?.url?.trim() || verificationUrl.trim();
    if (!target) {
      setVerificationStatus("error");
      setVerificationReport(null);
      setVerificationFailure({
        message: "Enter a deployed URL to verify.",
        detail: "Graft can only inspect a public page that its verification browser can reach.",
      });
      return;
    }

    verificationRequestRef.current?.abort();
    const controller = new AbortController();
    verificationRequestRef.current = controller;
    setVerificationStatus("loading");
    setVerificationReport(null);
    setVerificationFailure(null);

    const expected = override?.expected
      ? [...override.expected]
      : verificationExpected
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
    const query = new URLSearchParams({ url: target });
    if (expected.length > 0) query.set("expect", expected.join(","));

    try {
      const response = await fetch(`/api/verify?${query.toString()}`, {
        signal: controller.signal,
      });
      const payload = (await response.json()) as Partial<VerificationReport> & {
        ok?: boolean;
        message?: string;
        detail?: string;
      };

      if (!response.ok || payload.ok !== true) {
        setVerificationStatus("error");
        setVerificationFailure({
          message:
            typeof payload.message === "string"
              ? payload.message
              : `Verification failed with HTTP ${response.status}.`,
          detail: typeof payload.detail === "string" ? payload.detail : undefined,
        });
        return;
      }

      if (
        typeof payload.url !== "string" ||
        typeof payload.verdict !== "string" ||
        !Array.isArray(payload.checks) ||
        !Array.isArray(payload.tools) ||
        !Array.isArray(payload.findings)
      ) {
        setVerificationStatus("error");
        setVerificationFailure({
          message: "The verifier returned an unreadable response.",
          detail: "Try again. If it repeats, inspect the deployment function logs.",
        });
        return;
      }

      setVerificationReport(payload as VerificationReport);
      setVerificationStatus("complete");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setVerificationStatus("error");
      setVerificationFailure({
        message: "Graft could not complete the verification request.",
        detail: caught instanceof Error ? caught.message : undefined,
      });
    } finally {
      if (verificationRequestRef.current === controller) {
        verificationRequestRef.current = null;
      }
    }
  }, [verificationExpected, verificationUrl]);

  controlStateRef.current = {
    sourceUrl: activeSource?.sourceUrl ?? "",
    sourceKind: activeSource?.kind ?? "none",
    phase,
    tools,
    registeredCount: registration.registered.length,
    webmcpAvailable: registration.available,
  };
  controlActionsRef.current = {
    compile: async (url: string) => {
      setIntakeMode("live");
      setUrlInput(url);
      await runLiveIntake(url);
    },
    setStatus: setToolStatusByName,
    exportAdapter,
  };


  const schemaProperties = useMemo(
    () => Object.entries(selectedTool?.inputSchema.properties ?? {}),
    [selectedTool],
  );

  const pendingKey =
    intakeMode === "live"
      ? urlInput.trim()
      : intakeMode === "paste"
        ? "pasted-html"
        : selectedFixtureId;
  const dirty = compiledSourceKey !== null && compiledSourceKey !== pendingKey;
  const connected = controlToolNames.length === CONTROL_TOOLS.length;
  const currentAdapterFileName = adapterFileName(compiledSourceKey);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#compiler-bench">
        Skip to compiler bench
      </a>

      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand-lockup" href="#top" aria-label="Graft home">
            <span className="brand-mark" aria-hidden="true">
              <img src="/graft-mark.png" alt="" width="36" height="36" />
            </span>
            <span className="brand-copy">
              <span className="brand-word">Graft</span>
              <span className="brand-descriptor">WebMCP compatibility compiler</span>
            </span>
          </a>
          <nav className="primary-nav" aria-label="Primary navigation">
            <a href="#compiler-bench">Compiler</a>
            <a href="#method">Method</a>
            <a href="#trust-title">Trust</a>
            <a href="#verify-deployment">Verifier</a>
          </nav>
          {registration.available ? (
            <div className="connection-state" data-connected={connected} aria-live="polite">
              <span className="connection-light" aria-hidden="true" />
              <span className="connection-label">
                {controlRegistrationLabel(registration, controlToolNames.length)}
              </span>
            </div>
          ) : (
            /* A bare "not detected" badge reads as a broken demo. It is the one
               state most visitors land in, so it has to say what still works. */
            <details className="connection-help">
              <summary className="connection-state" data-connected={false}>
                <span className="connection-light" aria-hidden="true" />
                <span className="connection-label">WebMCP not detected</span>
                <span className="connection-more">
                  <span className="connection-more-long">What this means</span>
                  <span className="connection-more-short" aria-hidden="true">
                    Why
                  </span>
                </span>
              </summary>
              <div className="connection-panel">
                <p>
                  <strong>Nothing here is broken.</strong> Your browser has no WebMCP API yet, so
                  tools cannot register natively. Compiling, the scored evidence and running each
                  tool from the inspector all work on this page right now.
                </p>
                <p>To let an agent call the tools instead of you:</p>
                <ul>
                  <li>
                    Chrome 149 or later, with <code>chrome://flags/#enable-webmcp-testing</code>{" "}
                    enabled, then restart.
                  </li>
                  <li>Or open this page in the ChatGPT desktop in-app browser.</li>
                </ul>
              </div>
            </details>
          )}
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="page-container hero-grid">
            <div className="hero-copy">
              <div>
                <p className="kicker">A tool layer for websites that never shipped one</p>
                <h1 id="hero-title">Give the old web a governed tool layer.</h1>
                <p className="hero-deck">
                  Paste a URL. Graft reads the page once, strips every script and
                  network attribute, then compiles what is left into typed WebMCP tools
                  you can review, register and run.
                </p>
              </div>
              <div className="hero-actions">
                <a className="primary-cta" href="#compiler-bench">
                  Open the compiler
                  <ArrowRight size={18} weight="bold" aria-hidden="true" />
                </a>
                <a className="secondary-cta" href="#trust-title">Read the trust model</a>
              </div>
              <div className="hero-facts" aria-label="Product constraints">
                <span><ShieldCheck size={16} weight="fill" aria-hidden="true" />Any public page</span>
                <span><LockKey size={16} weight="fill" aria-hidden="true" />No credentials forwarded</span>
              </div>
            </div>
            <figure className="hero-visual">
              <div className="hero-image-wrap">
                <picture>
                  <source
                    type="image/webp"
                    srcSet="/graft-semantic-topology-768.webp 768w, /graft-semantic-topology-1448.webp 1448w"
                    sizes="(max-width: 900px) calc(100vw - 2rem), min(48vw, 620px)"
                  />
                  <img
                    src="/graft-semantic-topology.png"
                    width="1448"
                    height="1086"
                    alt="A translucent page passing through a red graft joint and resolving into three structured tool modules."
                    fetchPriority="high"
                  />
                </picture>
              </div>
              <figcaption>
                <span>Semantic compile</span>
                <strong>One page in. Typed contracts out.</strong>
              </figcaption>
              <div className="hero-index" aria-label="Current compilation summary">
                <div className="hero-stat">
                  <span>Registered</span>
                  <strong>
                    {String(registration.registered.length).padStart(2, "0")}
                  </strong>
                </div>
                <div className="hero-stat">
                  <span>Tools</span>
                  <strong>{String(tools.length).padStart(2, "0")}</strong>
                </div>
                <div className="hero-stat">
                  <span>Held</span>
                  <strong>{String(heldCount).padStart(2, "0")}</strong>
                </div>
              </div>
            </figure>
          </div>
        </section>

        <section className="intake-section" aria-labelledby="source-title">
          <div className="page-container">
            <div className="section-intro">
              <div>
                <p className="kicker">Intake</p>
                <h2 id="source-title">Point Graft at a page.</h2>
              </div>
              <p className="section-description">
                Graft reads the page once on the server, strips every script, frame and
                network attribute, then compiles what is left. Nothing you type is stored
                and no credentials are ever forwarded.
              </p>
            </div>

            <div className="intake-modes" role="group" aria-label="Intake method">
              {INTAKE_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className="intake-mode"
                  aria-pressed={intakeMode === mode.id}
                  onClick={() => {
                    setIntakeMode(mode.id);
                    setIntakeFailure(null);
                    if (
                      shouldCompileFixtureOnModeSelection(mode.id, activeSource?.kind)
                    ) {
                      void compileSource(fixtureSource(selectedFixtureId));
                    }
                  }}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {intakeMode === "live" ? (
              <form
                className="intake-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  compileActiveIntake();
                }}
              >
                <div className="intake-field">
                  <label className="control-label" htmlFor="intake-url">
                    Page URL
                  </label>
                  <input
                    id="intake-url"
                    className="intake-input"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    placeholder="https://books.toscrape.com"
                    value={urlInput}
                    onChange={(event) => setUrlInput(event.target.value)}
                    aria-describedby="intake-help"
                  />
                </div>
                <button
                  className="compile-button"
                  type="submit"
                  disabled={intakeStatus === "loading" || phase === "compiling"}
                  aria-busy={intakeStatus === "loading"}
                >
                  <Lightning size={18} weight="fill" aria-hidden="true" />
                  {intakeStatus === "loading"
                    ? "Reading page"
                    : dirty
                      ? "Compile this page"
                      : "Recompile"}
                </button>
              </form>
            ) : null}

            {intakeMode === "live" ? (
              <>
                <p className="intake-help" id="intake-help">
                  Any public page works. Derived search tools query the live site rather
                  than filtering the snapshot. If the server returns a shell, Graft renders
                  the page in a headless browser and compiles that instead. Authentication, banking, mail and government
                  domains are refused, and robots.txt is honoured.
                </p>
                <ul className="preset-rack" aria-label="Verified example pages">
                  {livePresets.map((preset) => (
                    <li key={preset.url}>
                      <button
                        type="button"
                        className="source-preset"
                        aria-current={urlInput.trim() === preset.url ? "true" : undefined}
                        onClick={() => {
                          setUrlInput(preset.url);
                          void runLiveIntake(preset.url);
                        }}
                      >
                        <span className="source-kind">{preset.posture}</span>
                        <span className="preset-content">
                          <strong>{preset.label}</strong>
                          <span>{preset.note}</span>
                        </span>
                        <span className="source-select" aria-hidden="true">
                          Compile
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {intakeMode === "paste" ? (
              <div className="intake-form intake-form-stacked">
                <div className="intake-field">
                  <label className="control-label" htmlFor="intake-paste">
                    HTML markup
                  </label>
                  <textarea
                    id="intake-paste"
                    className="intake-textarea"
                    rows={8}
                    spellCheck={false}
                    placeholder="<main><h2>Products</h2><ul>...</ul></main>"
                    value={pasteInput}
                    onChange={(event) => setPasteInput(event.target.value)}
                    aria-describedby="paste-help"
                  />
                </div>
                <p className="intake-help" id="paste-help">
                  Paste any markup, including a page you saved from your own site. It never
                  leaves your browser.
                </p>
                <button
                  className="compile-button"
                  type="button"
                  disabled={phase === "compiling"}
                  onClick={compileActiveIntake}
                >
                  <Lightning size={18} weight="fill" aria-hidden="true" />
                  Compile pasted HTML
                </button>
              </div>
            ) : null}

            {intakeMode === "fixture" ? (
              <>
                <ul className="preset-rack" aria-label="Owned demo fixtures">
                  {fixtureDefinitions.map((fixture) => (
                    <li key={fixture.id}>
                      <button
                        type="button"
                        className="source-preset"
                        aria-current={selectedFixtureId === fixture.id ? "true" : undefined}
                        onClick={() => {
                          setSelectedFixtureId(fixture.id);
                          void compileSource(fixtureSource(fixture.id));
                        }}
                      >
                        <span className="source-kind">{fixture.id.replace("-", " ")}</span>
                        <span className="preset-content">
                          <strong>{fixture.title}</strong>
                          <span>{fixture.description}</span>
                        </span>
                        <span className="source-select" aria-hidden="true">
                          Compile
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="intake-help">
                  Fixtures are original pages bundled with Graft. They run the same compiler
                  offline, which makes them useful when a live page is unreachable.
                </p>
              </>
            ) : null}

            {intakeFailure ? (
              <div className="intake-failure" role="alert">
                <WarningCircle size={20} weight="fill" aria-hidden="true" />
                <div>
                  <strong>{intakeFailure.message}</strong>
                  {intakeFailure.detail ? <p>{intakeFailure.detail}</p> : null}
                  <div className="intake-failure-actions">
                    {intakeMode === "live" && RETRYABLE_REASONS.has(intakeFailure.reason) ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => void runLiveIntake(urlInput)}
                      >
                        Try again
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setIntakeFailure(null);
                        setUrlInput(livePresets[0]?.url ?? "");
                        void runLiveIntake(livePresets[0]?.url ?? "");
                      }}
                    >
                      Use a verified page
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {activeSource ? (
              <div className="source-address" aria-live="polite">
                <LockKey size={18} weight="fill" aria-hidden="true" />
                <div>
                  <span className="control-label">Compiled source</span>
                  <div className="address-display">{activeSource.sourceUrl}</div>
                </div>
                {activeSource.meta ? (
                  <dl className="source-facts">
                    <div>
                      <dt>Read</dt>
                      <dd>{Math.max(1, Math.round(activeSource.meta.bytes / 1024))} KB</dd>
                    </div>
                    <div>
                      <dt>Headers stripped</dt>
                      <dd>{activeSource.meta.strippedHeaders.length}</dd>
                    </div>
                    <div>
                      <dt>Styles inlined</dt>
                      <dd>{activeSource.meta.inlinedStylesheets}</dd>
                    </div>
                  </dl>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section
          id="compiler-bench"
          className="bench-section"
          aria-labelledby="bench-title"
        >
          <div className="bench-head">
            <div className="bench-title">
              <span className="panel-kicker">Live compiler</span>
              <h2 id="bench-title">Inspect the whole compile.</h2>
            </div>
            <div className="compile-rail" aria-label="Compilation stages">
              <div
                className="rail-step"
                data-state={phase === "compiling" && compileStage === 0 ? "active" : snapshot ? "done" : "idle"}
              >
                <span className="micro-label">Snapshot</span>
                <strong>{snapshot ? "Sanitized" : "Waiting"}</strong>
              </div>
              <div
                className="rail-step"
                data-state={phase === "compiling" && compileStage === 1 ? "active" : tools.length ? "done" : "idle"}
              >
                <span className="micro-label">Derive</span>
                <strong>{tools.length ? `${tools.length} candidates` : "Waiting"}</strong>
              </div>
              <div
                className="rail-step"
                data-state={phase === "compiling" && compileStage === 2 ? "active" : phase === "complete" ? "done" : "idle"}
              >
                <span className="micro-label">Register</span>
                <strong>
                  {registration.available
                    ? `${registration.registered.length} native`
                    : `${eligibleCount} local`}
                </strong>
              </div>
            </div>
          </div>

          {!registration.available && phase === "complete" ? (
            <div className="runtime-notice">
              <ShieldCheck size={20} weight="fill" aria-hidden="true" />
              <div>
                <strong>
                  Tools compiled. This browser cannot register them natively.
                </strong>
                <p>
                  Everything below is real derived output, and you can run each tool
                  locally from the inspector. To let an agent call them, open this page in
                  the ChatGPT desktop in-app browser, or in Chrome 149 or later with{" "}
                  <code>chrome://flags/#enable-webmcp-testing</code> enabled.
                </p>
              </div>
            </div>
          ) : null}

          {error && (
            <div className="system-error" role="alert">
              <WarningCircle size={22} weight="fill" aria-hidden="true" />
              <span>{error}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                title="Dismiss error"
                onClick={() => setError(null)}
                className="icon-button"
              >
                <X size={20} weight="bold" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="bench-mobile-tabs" aria-label="Choose compiler panel">
            <button
              type="button"
              className="bench-mobile-tab"
              aria-pressed={mobileView === "preview"}
              onClick={() => setMobileView("preview")}
            >
              Source preview
            </button>
            <button
              type="button"
              className="bench-mobile-tab"
              aria-pressed={mobileView === "tools"}
              onClick={() => setMobileView("tools")}
            >
              Tool bench
            </button>
          </div>

          <div className="bench-grid" inert={phase === "compiling" ? true : undefined}>
            <section
              className={`bench-panel preview-panel ${mobileView !== "preview" ? "mobile-hidden" : ""}`}
              aria-label="Sanitized source preview"
            >
              <div className="panel-head">
                <div className="panel-title-wrap">
                  <span className="panel-kicker">Source</span>
                  <strong>{snapshot?.title ?? selectedFixture.title}</strong>
                </div>
                <span className="panel-meta">Sandboxed / scripts removed</span>
              </div>
              <div className="preview-frame-wrap">
                {previewHtml ? (
                  <iframe
                    className="preview-frame"
                    title={`Sanitized snapshot of ${activeSource?.label ?? selectedFixture.title}`}
                    srcDoc={previewHtml}
                    sandbox=""
                  />
                ) : (
                  <div className="timeline-empty">Waiting for a source snapshot</div>
                )}
                <div className="preview-shield">
                  <ShieldCheck size={14} weight="fill" aria-hidden="true" />
                  {sanitization.removedNodes +
                    sanitization.removedAttributes +
                    sanitization.neutralizedCssReferences >
                  0
                    ? `${
                        sanitization.removedNodes +
                        sanitization.removedAttributes +
                        sanitization.neutralizedCssReferences
                      } active refs stripped`
                    : "CSP locked / inert"}
                </div>
              </div>
              <div className="snapshot-readout">
                <div className="readout-cell">
                  <span className="micro-label">Headings</span>
                  <strong>{snapshot?.headings.length ?? 0}</strong>
                </div>
                <div className="readout-cell">
                  <span className="micro-label">Collections</span>
                  <strong>{snapshot?.collections.length ?? 0}</strong>
                </div>
                <div className="readout-cell">
                  <span className="micro-label">Tables</span>
                  <strong>{snapshot?.tables.length ?? 0}</strong>
                </div>
                <div className="readout-cell">
                  <span className="micro-label">Forms</span>
                  <strong>{snapshot?.searchForms.length ?? 0}</strong>
                </div>
              </div>
            </section>

            <section
              className={`bench-panel tools-panel ${mobileView !== "tools" ? "mobile-hidden" : ""}`}
              aria-label="Generated WebMCP tool bench"
            >
              <div className="panel-head">
                <div className="panel-title-wrap">
                  <span className="panel-kicker">WebMCP</span>
                  <strong>Review and run contracts</strong>
                </div>
                <span className="panel-meta">
                  {eligibleCount} ready / {heldCount} held
                </span>
              </div>

              <div className="control-plane">
                <div className="control-plane-head">
                  <span className="panel-kicker">Graft's own tools</span>
                  <span className="panel-meta">
                    {controlToolNames.length > 0
                      ? `${controlToolNames.length} registered`
                      : "needs WebMCP"}
                  </span>
                </div>
                <p className="control-plane-note">
                  These drive Graft itself, so an agent can compile a URL, read the evidence
                  behind a candidate and publish a held one without touching this interface.
                </p>
                <ul className="control-plane-list">
                  {CONTROL_TOOLS.map((control) => (
                    <li key={control.name} data-registered={controlToolNames.includes(control.name)}>
                      <code>{control.name}</code>
                      <span>{control.summary}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="tool-workspace">
                <div className="tool-list">
                  <div className="tool-list-head">
                    <span className="panel-kicker">Candidates</span>
                    <span className="panel-meta">Confidence</span>
                  </div>
                  <div className="tool-list-items" aria-label="Tool candidates">
                    {tools.map((tool) => (
                      <button
                        key={tool.id}
                        type="button"
                        className="tool-row"
                        data-status={tool.status}
                        aria-pressed={tool.id === selectedTool?.id}
                        onClick={() => setSelectedToolId(tool.id)}
                      >
                        <span className="tool-status-rail" aria-hidden="true" />
                        <span className="tool-row-name">
                          <code>{tool.name}</code>
                          <span>
                            {tool.recipe} / {statusLabel(tool.status)}
                          </span>
                        </span>
                        <span className="confidence-dial" aria-label={`${tool.confidence} percent confidence`}>
                          {tool.confidence}
                        </span>
                      </button>
                    ))}
                    {tools.length === 0 && (
                      <div className="timeline-empty">No candidates derived</div>
                    )}
                  </div>
                </div>

                <div className="tool-inspector">
                  <div className="inspector-head">
                    <span className="panel-kicker">Inspector</span>
                    <span className="panel-meta">Typed contract</span>
                  </div>
                  {selectedTool ? (
                    <div className="inspector-scroll">
                      <div className="inspector-identity">
                        <div className="tool-name-line">
                          <h3>{selectedTool.name}</h3>
                          <div className="tool-head-actions">
                            <button
                              type="button"
                              className="contract-edit-trigger"
                              onClick={beginToolEdit}
                              disabled={editingToolId === selectedTool.id}
                            >
                              <Wrench size={14} weight="bold" aria-hidden="true" />
                              Edit
                            </button>
                            <span className="status-block" data-status={selectedTool.status}>
                              {selectedTool.status === "held" ? (
                                <WarningCircle size={14} weight="fill" aria-hidden="true" />
                              ) : (
                                <Check size={14} weight="bold" aria-hidden="true" />
                              )}
                              {statusLabel(selectedTool.status)}
                            </span>
                          </div>
                        </div>
                        {editingToolId === selectedTool.id ? (
                          <form
                            className="contract-edit-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveToolEdit();
                            }}
                          >
                            <label htmlFor="tool-name-edit">Tool name</label>
                            <input
                              id="tool-name-edit"
                              value={draftToolName}
                              maxLength={30}
                              spellCheck={false}
                              onChange={(event) => setDraftToolName(event.target.value)}
                            />
                            <label htmlFor="tool-description-edit">Description</label>
                            <textarea
                              id="tool-description-edit"
                              value={draftDescription}
                              minLength={20}
                              maxLength={500}
                              rows={4}
                              onChange={(event) => setDraftDescription(event.target.value)}
                            />
                            <div className="contract-edit-actions">
                              <button
                                type="button"
                                onClick={() => setEditingToolId(null)}
                              >
                                Cancel
                              </button>
                              <button type="submit">
                                Save and register
                              </button>
                            </div>
                          </form>
                        ) : (
                          <p>{selectedTool.description}</p>
                        )}
                      </div>

                      <div className="property-grid">
                        <div className="property-cell">
                          <span className="micro-label">Recipe</span>
                          <strong>{selectedTool.recipe}</strong>
                        </div>
                        <div className="property-cell">
                          <span className="micro-label">Effect</span>
                          <strong>{selectedTool.readOnly ? "Read only" : "Local mutation"}</strong>
                        </div>
                        <div className="property-cell">
                          <span className="micro-label">Annotations</span>
                          <code>
                            readOnly:{String(selectedTool.readOnly)} / untrusted:true
                          </code>
                        </div>
                        <div className="property-cell">
                          <span className="micro-label">Binding</span>
                          <code title={selectedTool.selector}>{selectedTool.selector}</code>
                        </div>
                      </div>

                      <div className="schema-block">
                        <div className="schema-head">
                          <span className="panel-kicker">Input schema</span>
                          <span className="panel-meta">JSON Schema</span>
                        </div>
                        <pre className="schema-code">
                          {JSON.stringify(selectedTool.inputSchema, null, 2)}
                        </pre>
                      </div>

                      <div className="evidence-block">
                        <span className="panel-kicker">Why this score</span>
                        <ul className="evidence-list">
                          {selectedTool.confidenceReasons.map((reason) => (
                            <li key={reason}>
                              <Check size={15} weight="bold" aria-hidden="true" />
                              <span>{reason}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="argument-block">
                        <div className="argument-head">
                          <span className="panel-kicker">Test arguments</span>
                          <span className="panel-meta">Local executor</span>
                        </div>
                        {schemaProperties.length > 0 ? (
                          <div className="argument-fields">
                            {schemaProperties.map(([name, schema]) => (
                              <SchemaField
                                key={name}
                                name={name}
                                schema={schema}
                                value={argumentValues[name] ?? ""}
                                required={selectedTool.inputSchema.required?.includes(name) ?? false}
                                onChange={(field, value) =>
                                  setArgumentValues((current) => ({ ...current, [field]: value }))
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="panel-meta">No arguments required</span>
                        )}
                      </div>

                      <div className="inspector-actions">
                        <button
                          type="button"
                          className="run-button"
                          aria-busy={runningTool === selectedTool.id}
                          disabled={
                            runningTool !== null ||
                            selectedTool.status === "held" ||
                            selectedTool.status === "rejected"
                          }
                          onClick={() => void runSelectedTool()}
                        >
                          <Play size={18} weight="fill" aria-hidden="true" />
                          {runningTool === selectedTool.id ? "Running tool" : "Run tool"}
                        </button>
                        <button
                          type="button"
                          className="publish-button"
                          disabled={selectedTool.status === "rejected"}
                          onClick={() => void publishSelectedTool()}
                        >
                          <Wrench size={18} weight="bold" aria-hidden="true" />
                          {selectedTool.status === "held" ? "Publish" : "Hold for review"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="timeline-empty">Select a candidate to inspect it</div>
                  )}
                </div>
              </div>

              <div className="call-timeline" aria-live="polite">
                <div className="timeline-head">
                  <span className="panel-kicker">Call timeline</span>
                  <span className="panel-meta">Latest first / {timeline.length} calls</span>
                </div>
                <div className="timeline-rows">
                  {timeline.length === 0 ? (
                    <div className="timeline-empty">
                      Run a tool here or invoke it through Site tools. Arguments and results land here.
                    </div>
                  ) : (
                    timeline.map((entry) => (
                      <div className="timeline-row" key={entry.id}>
                        <span>{entry.time}</span>
                        <code>{entry.name}</code>
                        <code className="timeline-summary">
                          {compactJson(entry.arguments)} → {compactJson(entry.result, 280)}
                        </code>
                        <span className="timeline-status" data-state={entry.state}>
                          {entry.state === "success" ? `${entry.duration}ms` : entry.state}
                        </span>
                        <details
                          className="timeline-detail"
                          onToggle={(event) => {
                            if (!event.currentTarget.open) return;
                            const detail = event.currentTarget;
                            window.requestAnimationFrame(() => {
                              detail.scrollIntoView({ block: "nearest" });
                            });
                          }}
                        >
                          <summary>Inspect exact tool call JSON</summary>
                          <div className="timeline-json-grid">
                            <div>
                              <span className="micro-label">Arguments</span>
                              <pre>{serializeJson(entry.arguments, 2)}</pre>
                            </div>
                            <div>
                              <span className="micro-label">Result</span>
                              <pre>{serializeJson(entry.result, 2)}</pre>
                            </div>
                          </div>
                        </details>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          </div>

          {phase === "compiling" && (
            <div className="compile-overlay" role="status" aria-live="polite">
              <div className="compile-overlay-box">
                <span className="compile-pulse" aria-hidden="true" />
                <div>
                  <span className="panel-kicker">Compiler active</span>
                  <div>
                    {compileStage === 0
                      ? "Sanitizing owned snapshot"
                      : compileStage === 1
                        ? "Deriving typed candidates"
                        : "Registering eligible tools"}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <section id="method" className="method-section" aria-labelledby="method-title">
          <div className="page-container">
            <div className="section-intro">
              <div>
                <p className="kicker">Deterministic by design</p>
                <h2 id="method-title">A compiler you can interrogate.</h2>
              </div>
              <p className="section-description">
                Every candidate has a recipe, schema, binding and confidence record. The product
                shows its work before anything reaches the browser tool registry.
              </p>
            </div>
            <div className="method-grid">
              <article className="method-step">
                <span className="method-number">01</span>
                <h3>Read native semantics</h3>
                <p>
                  Graft scans headings, forms, repeated structures and tables inside an inert
                  snapshot. Imported scripts never enter the runtime.
                </p>
              </article>
              <article className="method-step">
                <span className="method-number">02</span>
                <h3>Propose typed contracts</h3>
                <p>
                  Deterministic recipes produce bounded schemas and selector bindings. Ambiguous
                  candidates stay held until a person reviews them.
                </p>
              </article>
              <article className="method-step">
                <span className="method-number">03</span>
                <h3>Register and observe</h3>
                <p>
                  Eligible tools register with WebMCP. Arguments, results, timing and local
                  fixture effects remain visible in the same workbench.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="trust-band" aria-labelledby="trust-title">
          <div className="page-container trust-layout">
            <div className="trust-lead">
              <p className="kicker">Permission is part of the product</p>
              <h2 id="trust-title">No ghost clicks. No silent publish.</h2>
              <p>
                Graft is a migration preview for site owners, not a remote-control layer for the
                public web.
              </p>
            </div>
            <div className="trust-rules">
              <div className="trust-rule">
                <ShieldCheck size={20} weight="fill" aria-hidden="true" />
                <div>
                  <strong>Inert by construction</strong>
                  <p>Snapshots run without target scripts, network actions, cookies or credentials.</p>
                </div>
              </div>
              <div className="trust-rule">
                <WarningCircle size={20} weight="fill" aria-hidden="true" />
                <div>
                  <strong>Untrusted content stays labelled</strong>
                  <p>Every page-derived result carries the WebMCP untrusted content annotation.</p>
                </div>
              </div>
              <div className="trust-rule">
                <LockKey size={20} weight="fill" aria-hidden="true" />
                <div>
                  <strong>Consequential actions fail closed</strong>
                  <p>The demo mutation requires confirmation and can touch only local fixture state.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="final-section" aria-labelledby="final-title">
          <div className="page-container final-layout">
            <div className="final-copy">
              <p className="kicker">Ship from the owner site</p>
              <h2 id="final-title">Review once. Ship one file.</h2>
              <p>
                The adapter carries the reviewed contracts and the runtime that executes approved
                generated tools against your live DOM. Consequential writes stay out until you bind
                an owner handler, so the compiler never invents permission.
              </p>
              <ol className="install-steps" aria-label="Install a Graft adapter">
                <li>
                  <span>01</span>
                  <div>
                    <strong>Download</strong>
                    <p>Export {currentAdapterFileName} with the contracts you approved.</p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>Install</strong>
                    <p>Place the file beside your page, then register it from one module script.</p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>Deploy and verify</strong>
                    <p>Open the deployed URL in Graft to catch missing tools or contract drift.</p>
                  </div>
                </li>
              </ol>
              <pre className="final-snippet">
{`<script type="module">
  import { registerGraftTools } from "./${currentAdapterFileName}";
  await registerGraftTools();
</script>`}
              </pre>
            </div>
            <div className="final-actions">
              <button
                type="button"
                className="final-action"
                disabled={tools.length === 0}
                onClick={exportAdapter}
              >
                <span>
                  {exportFeedback?.kind === "prepared"
                    ? `Prepared ${exportFeedback.fileName}`
                    : "Download reviewed adapter"}
                </span>
                <DownloadSimple size={20} weight="bold" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="final-action"
                disabled={tools.length === 0}
                onClick={() => void copyAdapter()}
              >
                <span>
                  {exportFeedback?.kind === "copied"
                    ? "Copied adapter source"
                    : "Copy adapter source"}
                </span>
                <ArrowRight size={20} weight="bold" aria-hidden="true" />
              </button>
              <a
                className="final-action"
                href="https://graft-owner-example.vercel.app/"
                target="_blank"
                rel="noreferrer"
              >
                <span>Open live owner implementation</span>
                <ArrowRight size={20} weight="bold" aria-hidden="true" />
              </a>
              {exportFeedback && (
                <div className="export-receipt" role="status" aria-live="polite">
                  <Check size={18} weight="bold" aria-hidden="true" />
                  <div>
                    <strong>
                      {exportFeedback.kind === "copied" ? "Source copied" : "Adapter prepared"}
                    </strong>
                    <span>
                      {exportFeedback.eligible} approved tools in {exportFeedback.fileName}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <section
            className="page-container verification-panel"
            id="verify-deployment"
            aria-labelledby="verification-title"
          >
            <div className="verification-control">
              <div className="verification-intro">
                <p className="kicker">Live deployment audit</p>
                <h2 id="verification-title">See the tools an agent actually gets.</h2>
                <p>
                  Graft opens the public page in a WebMCP-capable browser, reads its native registry
                  and compares it with the contract you reviewed.
                </p>
              </div>

              <div className="verification-preset">
                <div>
                  <span>Live proof target</span>
                  <strong>OmniDev Agent Review Room</strong>
                  <small>Eight expected tools on an origin Graft does not serve.</small>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setVerificationUrl(AGENT_REVIEW_ROOM_PRESET.url);
                    setVerificationExpected(AGENT_REVIEW_ROOM_PRESET.tools.join(", "));
                    void verifyDeployment({
                      url: AGENT_REVIEW_ROOM_PRESET.url,
                      expected: AGENT_REVIEW_ROOM_PRESET.tools,
                    });
                  }}
                  disabled={verificationStatus === "loading"}
                  aria-label="Verify the live OmniDev Agent Review Room and its eight expected tools"
                >
                  Verify the 8-tool surface
                  <ArrowRight size={16} weight="bold" aria-hidden="true" />
                </button>
              </div>

              <form
                className="verification-form"
                aria-labelledby="verification-title"
                onSubmit={(event) => {
                  event.preventDefault();
                  void verifyDeployment();
                }}
              >
                <label className="verification-field" htmlFor="verification-url">
                  <span>Deployed URL</span>
                  <input
                    id="verification-url"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    value={verificationUrl}
                    onChange={(event) => setVerificationUrl(event.target.value)}
                    placeholder="https://your-site.example"
                    disabled={verificationStatus === "loading"}
                    aria-describedby="verification-help"
                    required
                  />
                </label>
                <label className="verification-field" htmlFor="verification-expected">
                  <span>Expected tool names <em>optional</em></span>
                  <textarea
                    id="verification-expected"
                    rows={3}
                    spellCheck={false}
                    value={verificationExpected}
                    onChange={(event) => setVerificationExpected(event.target.value)}
                    placeholder="search_catalog, get_product, update_cart"
                    disabled={verificationStatus === "loading"}
                    aria-describedby="verification-help"
                  />
                </label>
                <p className="verification-help" id="verification-help">
                  Separate exact tool names with commas. Graft sends them to the verifier without
                  renaming or reordering them.
                </p>
                <button
                  type="submit"
                  className="verification-submit"
                  disabled={verificationStatus === "loading"}
                >
                  {verificationStatus === "loading" ? (
                    <>
                      <span className="compile-pulse" aria-hidden="true" />
                      Reading live registry
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={20} weight="bold" aria-hidden="true" />
                      Verify deployed site
                    </>
                  )}
                </button>
              </form>
            </div>

            <div
              className="verification-output"
              aria-busy={verificationStatus === "loading"}
            >
              {verificationStatus === "idle" && (
                <div className="verification-empty">
                  <Lightning size={24} weight="fill" aria-hidden="true" />
                  <div>
                    <strong>No deployment checked yet</strong>
                    <p>Enter a public URL to read its live WebMCP surface.</p>
                  </div>
                </div>
              )}

              {verificationStatus === "loading" && (
                <div className="verification-empty verification-loading" role="status">
                  <span className="compile-pulse" aria-hidden="true" />
                  <div>
                    <strong>Opening the deployed page</strong>
                    <p>The browser is waiting for the page to register its native tools.</p>
                  </div>
                </div>
              )}

              {verificationStatus === "error" && verificationFailure && (
                <div className="verification-error" role="alert">
                  <WarningCircle size={22} weight="fill" aria-hidden="true" />
                  <div>
                    <strong>{verificationFailure.message}</strong>
                    {verificationFailure.detail && <p>{verificationFailure.detail}</p>}
                    <button
                      type="button"
                      className="verification-retry"
                      onClick={() => void verifyDeployment()}
                    >
                      Try verification again
                    </button>
                  </div>
                </div>
              )}

              {verificationStatus === "complete" && verificationReport && (
                <div className="verification-report" data-verdict={verificationReport.verdict}>
                  <header className="verification-report-head" role="status">
                    <div className="verification-live-summary">
                      <span className="verification-seal" aria-hidden="true">
                        {verificationReport.verdict === "fail" ? (
                          <X size={24} weight="bold" />
                        ) : (
                          <Check size={24} weight="bold" />
                        )}
                      </span>
                      <div>
                        <span>Live browser result</span>
                        <strong>
                          {verificationReport.verdict === "fail"
                            ? verificationReport.drift && !verificationReport.drift.exact
                              ? "Tool-name drift found"
                              : "Verification needs attention"
                            : `${verificationReport.tools.length} tools live`}
                        </strong>
                        <p>
                          {verificationReport.drift?.exact
                            ? "The deployed tool names exactly match the expected names."
                            : "The result below comes from the registry exposed by the deployed page."}
                        </p>
                      </div>
                    </div>
                    <div className="verification-score">
                      <strong>
                        {verificationReport.passed}<span>/</span>{verificationReport.total}
                      </strong>
                      <span>checks passed</span>
                      {verificationReport.skipped > 0 && (
                        <small>{verificationReport.skipped} inconclusive</small>
                      )}
                    </div>
                  </header>

                  <a
                    className="verification-target"
                    href={verificationReport.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open verified origin ${verificationReport.url} in a new tab`}
                  >
                    <span>{verificationReport.url}</span>
                    <span className="verification-target-action">
                      Open origin
                      <ArrowRight size={16} weight="bold" aria-hidden="true" />
                    </span>
                  </a>

                  <section className="verification-registry" aria-labelledby="verification-tools">
                    <div className="verification-registry-head">
                      <div>
                        <span>Native tool registry</span>
                        <h3 id="verification-tools">The exact surface available to agents</h3>
                      </div>
                      <strong aria-label={`${verificationReport.tools.length} tools`}>
                        {String(verificationReport.tools.length).padStart(2, "0")}
                      </strong>
                    </div>
                    {verificationReport.tools.length > 0 ? (
                      <ol className="verification-tool-registry">
                        {verificationReport.tools.map((tool, index) => (
                          <li key={`${tool}-${index}`}>
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <code>{tool}</code>
                            <small>
                              {verificationReport.drift?.exact ? "expected name matched" : "registered"}
                            </small>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="verification-block-empty">The endpoint returned no tools.</p>
                    )}
                  </section>

                  <section className="verification-block" aria-labelledby="verification-checks">
                    <div className="verification-block-head">
                      <h3 id="verification-checks">Checks</h3>
                      <span>{verificationReport.checks.length} returned</span>
                    </div>
                    <div className="verification-checks">
                      {verificationReport.checks.map((check) => {
                        const state = check.inconclusive
                          ? "inconclusive"
                          : check.pass
                            ? "pass"
                            : "fail";
                        return (
                          <div className="verification-check" data-state={state} key={check.id}>
                            <span className="verification-check-icon" aria-hidden="true">
                              {state === "pass" ? (
                                <Check size={16} weight="bold" />
                              ) : state === "fail" ? (
                                <X size={16} weight="bold" />
                              ) : (
                                <WarningCircle size={16} weight="fill" />
                              )}
                            </span>
                            <div>
                              <strong>{check.label}</strong>
                              <p>{check.detail}</p>
                            </div>
                            <span className="verification-check-state">{state}</span>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <div className="verification-evidence-grid">
                    <section className="verification-block" aria-labelledby="verification-findings">
                      <div className="verification-block-head">
                        <h3 id="verification-findings">Contract findings</h3>
                        <span>
                          {verificationReport.findings.reduce(
                            (total, finding) => total + finding.issues.length,
                            0,
                          )} issues
                        </span>
                      </div>
                      {verificationReport.findings.length > 0 ? (
                        <div className="verification-findings">
                          {verificationReport.findings.map((finding, index) => (
                            <div key={`${finding.name}-${index}`}>
                              <code>{finding.name}</code>
                              <ul>
                                {finding.issues.map((issue, issueIndex) => (
                                  <li key={`${issue}-${issueIndex}`}>{issue}</li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="verification-findings-clear">
                          <Check size={16} weight="bold" aria-hidden="true" />
                          No contract findings
                        </p>
                      )}
                    </section>

                    <section className="verification-block" aria-labelledby="verification-drift">
                      <div className="verification-block-head">
                        <h3 id="verification-drift">Contract drift</h3>
                        {verificationReport.drift && (
                          <span>{verificationReport.drift.exact ? "exact" : "changed"}</span>
                        )}
                      </div>
                      {verificationReport.drift ? (
                        <div className="verification-drift">
                          {verificationReport.drift.exact && (
                            <p className="verification-drift-exact">
                              <Check size={16} weight="bold" aria-hidden="true" />
                              Exact expected-name match
                            </p>
                          )}
                          {verificationReport.drift.missing.length > 0 && (
                            <div className="verification-drift-missing">
                              <strong>Missing</strong>
                              <p>{verificationReport.drift.missing.join(", ")}</p>
                            </div>
                          )}
                          {verificationReport.drift.added.length > 0 && (
                            <div className="verification-drift-added">
                              <strong>Added</strong>
                              <p>{verificationReport.drift.added.join(", ")}</p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="verification-block-empty">
                          Add expected names to compare this registry with a reviewed contract.
                        </p>
                      )}
                    </section>
                  </div>

                  <details className="verification-environment">
                    <summary>Verification environment</summary>
                    <p>
                      {verificationReport.schemasVisible} schemas visible · {verificationReport.userAgent}
                    </p>
                  </details>
                </div>
              )}
            </div>
          </section>
        </section>
      </main>

      <footer className="site-footer">
        <div className="page-container footer-inner">
          <span>Graft · Open source · Reads pages, never proxies them</span>
          <a
            href="https://webmachinelearning.github.io/webmcp/"
            target="_blank"
            rel="noreferrer"
          >
            Read the WebMCP draft community report
          </a>
        </div>
      </footer>

      <ConfirmDialog pending={pendingConfirmation} onSettle={settleConfirmation} />
    </div>
  );
}
