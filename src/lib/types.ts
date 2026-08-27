export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: JsonPrimitive[];
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
}

export type GraftRecipe = "R1" | "R3" | "R4" | "R6" | "R7" | "R8" | "R9";

export type GraftAction = "fill_submit" | "local_mutation" | "read" | "summarize" | "unbound_write";

export type GraftToolStatus = "auto" | "held" | "rejected" | "published";

export type GraftToolOrigin = "derived" | "human";

export interface HeadingSnapshot {
  level: number;
  text: string;
  selector: string;
}

export interface SnapshotRow {
  fields: Record<string, string>;
  text: string;
}

export interface CollectionSnapshot {
  id: string;
  label: string;
  selector: string;
  itemSelector: string;
  count: number;
  rows: SnapshotRow[];
  selectorStable: boolean;
  inferredFromClasses: boolean;
  chrome: boolean;
  labelSource: "semantic" | "classes" | "fallback";
}

export interface TableColumnSnapshot {
  key: string;
  label: string;
  index: number;
}

export interface TableSnapshot {
  id: string;
  label: string;
  selector: string;
  columns: TableColumnSnapshot[];
  rows: SnapshotRow[];
  selectorStable: boolean;
}

export interface SearchFormSnapshot {
  id: string;
  label: string;
  selector: string;
  inputSelector: string;
  inputName: string;
  accessibleName: string;
  selectorStable: boolean;
  verb: "search" | "filter";
  fields: SearchFormFieldSnapshot[];
  liveEndpoint: string | null;
}

export interface SearchFormFieldSnapshot {
  key: string;
  /** The control's real name attribute, needed to rebuild the query string. */
  name: string;
  label: string;
  selector: string;
  control: "text" | "number" | "select" | "checkbox";
  required: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface LocalActionSnapshot {
  id: string;
  label: string;
  selector: string;
  toolName: string;
  productSelector: string;
  quantitySelector: string;
  outputSelector: string;
  allowedProductIds: string[];
}

export interface PageSnapshot {
  title: string;
  url: string;
  description: string;
  mainText: string;
  headings: HeadingSnapshot[];
  collections: CollectionSnapshot[];
  tables: TableSnapshot[];
  searchForms: SearchFormSnapshot[];
  localActions: LocalActionSnapshot[];
  actionCandidates: ActionCandidateSnapshot[];
}

export interface ActionCandidateSnapshot {
  id: string;
  label: string;
  verb: string;
  selector: string;
  count: number;
  targets: string[];
}

export type ToolBinding =
  | { kind: "summary" }
  | { kind: "outline" }
  | { kind: "collection"; itemSelector: string }
  | { kind: "collection_item"; itemSelector: string; keyField: string }
  | {
      kind: "table";
      columns: TableColumnSnapshot[];
    }
  | { kind: "table_item"; columns: TableColumnSnapshot[]; keyField: string }
  | {
      kind: "search";
      inputSelector: string;
      fields: SearchFormFieldSnapshot[];
      liveEndpoint: string | null;
    }
  | { kind: "action_candidate"; controlSelector: string; targets: string[] }
  | {
      kind: "local_cart";
      productSelector: string;
      quantitySelector: string;
      outputSelector: string;
      allowedProductIds: string[];
    };

export interface GraftTool {
  id: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  recipe: GraftRecipe;
  selector: string;
  fallbackSelectors: string[];
  action: GraftAction;
  readOnly: boolean;
  destructive: boolean;
  confidence: number;
  confidenceReasons: string[];
  status: GraftToolStatus;
  origin: GraftToolOrigin;
  binding: ToolBinding;
}

export interface ConfidenceEvidence {
  accessibleName?: string | boolean;
  stableSelector?: string | boolean;
  unambiguousRecipe?: string | boolean;
  fullyTypedInputs?: string | boolean;
  positionalSelector?: string | boolean;
  classNameInference?: string | boolean;
  ambiguousRepeat?: string | boolean;
  nameCollision?: string | boolean;
  overrideScore?: number;
}

export interface ConfidenceResult {
  score: number;
  reasons: string[];
  status: Exclude<GraftToolStatus, "published">;
}

export interface ToolExecutionResult {
  ok: boolean;
  message: string;
  data?: Record<string, JsonValue>;
}

export interface LiveSearchRequest {
  endpoint: string;
  params: Record<string, string>;
  toolName: string;
}

export interface LiveSearchResponse {
  url: string;
  rows: string[];
  total: number;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface ModelContextToolAnnotations {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
}

export interface ModelContextToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ModelContextToolAnnotations;
  execute: (
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>;
}

export interface ModelContextLike extends EventTarget {
  registerTool: (
    descriptor: ModelContextToolDescriptor,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
  unregisterTool?: (name: string) => void | Promise<void>;
  getTools?: () => unknown[] | Promise<unknown[]>;
}

export interface ToolRegistrationFailure {
  name: string;
  error: string;
}

export interface ToolRegistrationReport {
  available: boolean;
  registered: string[];
  skipped: string[];
  failures: ToolRegistrationFailure[];
}

export type GraftLifecycleEvent =
  | { type: "registered"; report: ToolRegistrationReport }
  | { type: "tools_changed"; names: string[] }
  | {
      type: "execution_started";
      name: string;
      args: Record<string, JsonValue>;
      startedAt: number;
    }
  | {
      type: "execution_finished";
      name: string;
      args: Record<string, JsonValue>;
      result: ToolExecutionResult;
      status: "success" | "error" | "cancelled";
      durationMs: number;
    }
  | { type: "unsupported" }
  | { type: "registration_error"; name: string; error: string };
