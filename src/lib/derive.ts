import { applyCollisionPenalty, scoreConfidence } from "./confidence";
import {
  normalizeParameterName,
  normalizeToolName,
  pluralize,
  sanitizePageText,
  singularize,
  stableId,
} from "./dom-utils";
import {
  collectionNoun,
  collectionNounInfo,
  deriveSnapshot,
  searchNoun,
  tableNoun,
} from "./snapshot";
import type {
  ActionCandidateSnapshot,
  CollectionSnapshot,
  ConfidenceResult,
  GraftTool,
  JsonSchema,
  LocalActionSnapshot,
  PageSnapshot,
  SearchFormSnapshot,
  SearchFormFieldSnapshot,
  TableSnapshot,
} from "./types";

export interface GraftCompilation {
  snapshot: PageSnapshot;
  tools: GraftTool[];
  counts: {
    auto: number;
    held: number;
    rejected: number;
  };
}

const EMPTY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const PAGINATION_PROPERTIES: Record<string, JsonSchema> = {
  offset: {
    type: "integer",
    description: "Zero-based row offset.",
    minimum: 0,
    default: 0,
  },
  limit: {
    type: "integer",
    description: "Maximum rows to return.",
    minimum: 1,
    maximum: 25,
    default: 10,
  },
};

function withConfidence(
  base: Omit<GraftTool, "confidence" | "confidenceReasons" | "status">,
  confidence: ConfidenceResult,
): GraftTool {
  return {
    ...base,
    confidence: confidence.score,
    confidenceReasons: confidence.reasons,
    status: confidence.status,
  };
}

function summaryTool(snapshot: PageSnapshot): GraftTool {
  const confidence = scoreConfidence({ overrideScore: 100 });
  return withConfidence(
    {
      id: stableId("R9", "summary", snapshot.url),
      name: "get_page_summary",
      description:
        "Summarize the current page, including its title, heading outline and visible main content. Use it to orient before calling a narrower tool. Returns untrusted page text.",
      inputSchema: EMPTY_SCHEMA,
      recipe: "R9",
      selector: "html",
      fallbackSelectors: ["body"],
      action: "summarize",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "summary" },
    },
    confidence,
  );
}

function outlineTool(snapshot: PageSnapshot): GraftTool | null {
  if (snapshot.headings.length < 2) return null;
  const confidence = scoreConfidence({
    accessibleName: "Heading text provides an accessible outline",
    stableSelector: "Headings are read in document order",
    unambiguousRecipe: "Native h1-h6 elements define the hierarchy",
    fullyTypedInputs: "This read-only tool accepts no arguments",
  });
  return withConfidence(
    {
      id: stableId("R9", "outline", snapshot.url),
      name: "get_page_outline",
      description:
        "Return the current page's heading hierarchy in document order. Use it to locate a section before reading a collection or table. Returns untrusted page text.",
      inputSchema: EMPTY_SCHEMA,
      recipe: "R9",
      selector: "body",
      fallbackSelectors: ["html"],
      action: "read",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "outline" },
    },
    confidence,
  );
}

function searchTool(form: SearchFormSnapshot): GraftTool {
  const rawNoun = normalizeToolName(searchNoun(form), "site");
  const noun = form.verb === "filter" ? pluralize(rawNoun) : rawNoun;
  const formSubject = sanitizePageText(form.label, 80)
    .replace(/^(?:search|find|filter)\s+/i, "")
    .trim();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of form.fields) {
    properties[field.key] = searchFieldSchema(field);
    if (field.required) required.push(field.key);
  }
  const confidence = scoreConfidence({
    accessibleName: form.accessibleName
      ? `Search input is named “${sanitizePageText(form.accessibleName, 60)}”`
      : false,
    stableSelector: form.selectorStable ? "Form and input selectors resolve uniquely" : false,
    positionalSelector: !form.selectorStable ? "Search control requires a positional selector" : false,
    unambiguousRecipe: "Native search form and search-like input detected",
    fullyTypedInputs: "Query maps directly to a text input",
  });
  return withConfidence(
    {
      id: form.id,
      name: normalizeToolName(`${form.verb}_${noun}`, "search_site"),
      description: `${form.verb === "filter" ? "Filter" : "Search"} ${formSubject || "this page"} using its visible controls. Use only the fields the user specifies. It drives the page UI and returns untrusted visible results.`,
      inputSchema: {
        type: "object",
        properties,
        required: required.length ? required : undefined,
        additionalProperties: false,
      },
      recipe: "R1",
      selector: form.selector,
      fallbackSelectors: [],
      action: "fill_submit",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "search", inputSelector: form.inputSelector, fields: form.fields },
    },
    confidence,
  );
}

function searchFieldSchema(field: SearchFormFieldSnapshot): JsonSchema {
  const description = sanitizePageText(field.label, 110) || field.key.replace(/_/g, " ");
  if (field.control === "checkbox") {
    return { type: "boolean", description };
  }
  if (field.control === "number") {
    return {
      type: "number",
      description,
      minimum: field.minimum,
      maximum: field.maximum,
    };
  }
  return {
    type: "string",
    description,
    enum: field.control === "select" ? field.enum : undefined,
    maxLength: 300,
  };
}

/**
 * A class-derived label like "row" reads as nonsense in a tool description.
 * Fall back to the noun, which is derived from the rows themselves.
 */
function humanCollectionLabel(collection: CollectionSnapshot, noun: string): string {
  if (collection.labelSource === "semantic" && collection.label) {
    return sanitizePageText(collection.label, 80);
  }
  return noun.replace(/_/g, " ");
}

function collectionTool(collection: CollectionSnapshot): GraftTool {
  const nounInfo = collectionNounInfo(collection);
  const noun = pluralize(normalizeToolName(nounInfo.noun, "items"));
  const hasDistinguishingRows = collection.rows.every(
    (row) => Boolean(row.fields.title || row.fields.href),
  );
  const namedSemantically =
    collection.labelSource === "semantic" && Boolean(collection.label);
  const namedFromClasses = collection.labelSource === "classes";
  // Rows that name themselves are self-describing, so a missing heading is not
  // the same kind of ambiguity as a region nobody can identify at all.
  const namedByRows = nounInfo.source === "row-key" || nounInfo.source === "row-fields";
  const unnamed = collection.labelSource === "fallback" && !namedByRows;
  const confidence = scoreConfidence({
    accessibleName: namedSemantically
      ? `Region is labelled “${sanitizePageText(collection.label, 60)}”`
      : namedByRows
        ? `Rows name themselves through the “${nounInfo.noun}” fields they expose`
        : false,
    stableSelector: collection.selectorStable ? "Collection selector resolves uniquely" : false,
    positionalSelector: !collection.selectorStable ? "Collection requires a positional selector" : false,
    fullyTypedInputs: "Pagination maps to bounded integer parameters",
    classNameInference:
      collection.inferredFromClasses || namedFromClasses
        ? namedFromClasses
          ? `Name came from the class attribute “${sanitizePageText(collection.label, 40)}”, not from page semantics`
          : "Repeated structure was inferred partly from class signatures"
        : false,
    ambiguousRepeat:
      !hasDistinguishingRows || unnamed
        ? unnamed
          ? "Repeated region carries no heading, caption or accessible name"
          : "Some repeated rows have no title or link key"
        : false,
  });
  return withConfidence(
    {
      id: collection.id,
      name: normalizeToolName(`list_${noun}`, "list_items"),
      description: `List ${humanCollectionLabel(collection, nounInfo.noun)} visible on the current page. Use offset and limit to paginate. Returns structured, untrusted page content and never changes the page.`,
      inputSchema: {
        type: "object",
        properties: { ...PAGINATION_PROPERTIES },
        additionalProperties: false,
      },
      recipe: "R3",
      selector: collection.selector,
      fallbackSelectors: [],
      action: "read",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "collection", itemSelector: collection.itemSelector },
    },
    confidence,
  );
}

function stableRowKey(rows: CollectionSnapshot["rows"]): string | null {
  const first = rows[0];
  if (!first) return null;
  const keys = Object.keys(first.fields);
  // An id or slug is ideal. A title that is present and unique on every row is
  // what real pages actually publish, and it identifies a row just as well.
  const ranked = [
    ...keys.filter((key) => /_(?:id|slug)$/.test(key)),
    ...keys.filter((key) => key === "title" || key === "name"),
  ];
  for (const key of ranked) {
    const values = rows.map((row) => row.fields[key]).filter(Boolean);
    if (values.length === rows.length && new Set(values).size === values.length) return key;
  }
  return null;
}

function collectionDetailTool(collection: CollectionSnapshot): GraftTool | null {
  const keyField = stableRowKey(collection.rows);
  if (!keyField) return null;
  const noun = singularize(normalizeToolName(collectionNoun(collection), "item"));
  const verb = /entry|article|guide/.test(noun) ? "read" : "get";
  const confidence = scoreConfidence({
    accessibleName: `Rows expose the stable key “${keyField}”`,
    stableSelector: collection.selectorStable ? "Collection selector resolves uniquely" : false,
    positionalSelector: !collection.selectorStable ? "Collection requires a positional selector" : false,
    fullyTypedInputs: "The row key maps to one required string parameter",
  });
  return withConfidence(
    {
      id: stableId(collection.id, "detail", keyField),
      name: normalizeToolName(`${verb}_${noun}`, "get_item"),
      description: `${verb === "read" ? "Read" : "Return"} one ${sanitizePageText(noun.replace(/_/g, " "), 50)} from the visible collection by its exact ${keyField}. Use the identifier returned by the matching list tool. Returns untrusted page content.`,
      inputSchema: {
        type: "object",
        properties: {
          [keyField]: {
            type: "string",
            description: `Exact ${keyField} returned by the list tool.`,
            enum: collection.rows
              .map((row) => row.fields[keyField])
              .filter((value): value is string => Boolean(value)),
          },
        },
        required: [keyField],
        additionalProperties: false,
      },
      recipe: "R3",
      selector: collection.selector,
      fallbackSelectors: [],
      action: "read",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "collection_item", itemSelector: collection.itemSelector, keyField },
    },
    confidence,
  );
}

function tableTool(table: TableSnapshot): GraftTool {
  const noun = normalizeToolName(tableNoun(table), "table");
  const properties: Record<string, JsonSchema> = { ...PAGINATION_PROPERTIES };
  for (const column of table.columns) {
    const key = normalizeParameterName(column.key, `column_${column.index + 1}`);
    properties[key] = {
      type: "string",
      description: `Case-insensitive text filter for the “${sanitizePageText(column.label, 60)}” column.`,
      maxLength: 200,
    };
  }
  const confidence = scoreConfidence({
    accessibleName:
      table.label !== "table" ? `Table is labelled “${sanitizePageText(table.label, 60)}”` : false,
    stableSelector: table.selectorStable ? "Table selector resolves uniquely" : false,
    positionalSelector: !table.selectorStable ? "Table requires a positional selector" : false,
    unambiguousRecipe: "Native table headers map columns deterministically",
    fullyTypedInputs: "Every header maps to an optional string filter",
  });
  return withConfidence(
    {
      id: table.id,
      name: normalizeToolName(`list_${pluralize(noun)}`, "list_table"),
      description: `Query ${sanitizePageText(table.label, 80) || "the table"} by its visible columns. Use optional column filters plus offset and limit. Returns structured, untrusted rows and never changes the page.`,
      inputSchema: {
        type: "object",
        properties,
        additionalProperties: false,
      },
      recipe: "R4",
      selector: table.selector,
      fallbackSelectors: [],
      action: "read",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "table", columns: table.columns },
    },
    confidence,
  );
}

function tableDetailTool(table: TableSnapshot): GraftTool | null {
  const keyColumn = table.columns.find((column) => /_id$/.test(column.key));
  if (!keyColumn) return null;
  const values = table.rows
    .map((row) => row.fields[keyColumn.key])
    .filter((value): value is string => Boolean(value));
  if (values.length !== table.rows.length || new Set(values).size !== values.length) return null;
  const noun = singularize(tableNoun(table));
  const confidence = scoreConfidence({
    accessibleName: `Table exposes the stable key “${keyColumn.label}”`,
    stableSelector: table.selectorStable ? "Table selector resolves uniquely" : false,
    positionalSelector: !table.selectorStable ? "Table requires a positional selector" : false,
    unambiguousRecipe: "Native table headers map the selected row deterministically",
    fullyTypedInputs: "The row key maps to one required string parameter",
  });
  return withConfidence(
    {
      id: stableId(table.id, "detail", keyColumn.key),
      name: normalizeToolName(`get_${noun}`, "get_row"),
      description: `Return one ${sanitizePageText(noun.replace(/_/g, " "), 50)} from the visible table by its exact ${keyColumn.key}. Use an identifier returned by the matching list tool. Returns untrusted page content.`,
      inputSchema: {
        type: "object",
        properties: {
          [keyColumn.key]: {
            type: "string",
            description: `Exact ${keyColumn.label} shown in the table.`,
            enum: values,
          },
        },
        required: [keyColumn.key],
        additionalProperties: false,
      },
      recipe: "R4",
      selector: table.selector,
      fallbackSelectors: [],
      action: "read",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "table_item", columns: table.columns, keyField: keyColumn.key },
    },
    confidence,
  );
}

function localActionTool(action: LocalActionSnapshot): GraftTool {
  const confidence = scoreConfidence({ overrideScore: 55 });
  confidence.reasons.push(
    "Explicit local-fixture markers found",
    "Product choices are allowlisted from the owned fixture",
    "Held for human review because this tool mutates visible local state",
  );
  confidence.status = "held";
  return withConfidence(
    {
      id: action.id,
      name: normalizeToolName(action.toolName, "add_to_demo_cart"),
      description:
        "Add one allowlisted fixture product to the local demo cart. Use only after the user chooses a product and quantity. Requires human confirmation, changes in-memory demo state only and never submits a purchase.",
      inputSchema: {
        type: "object",
        properties: {
          product_id: {
            type: "string",
            description: "Exact fixture product identifier.",
            enum: action.allowedProductIds,
          },
          quantity: {
            type: "integer",
            description: "Quantity to add, from 1 to 3.",
            minimum: 1,
            maximum: 3,
            default: 1,
          },
        },
        required: ["product_id", "quantity"],
        additionalProperties: false,
      },
      recipe: "R7",
      selector: action.selector,
      fallbackSelectors: [],
      action: "local_mutation",
      readOnly: false,
      destructive: true,
      origin: "derived",
      binding: {
        kind: "local_cart",
        productSelector: action.productSelector,
        quantitySelector: action.quantitySelector,
        outputSelector: action.outputSelector,
        allowedProductIds: action.allowedProductIds,
      },
    },
    confidence,
  );
}

function uniqueNames(tools: GraftTool[]): GraftTool[] {
  const totals = tools.reduce((map, tool) => {
    map.set(tool.name, (map.get(tool.name) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  const counts = new Map<string, number>();
  return tools.map((tool) => {
    const count = (counts.get(tool.name) ?? 0) + 1;
    counts.set(tool.name, count);
    if ((totals.get(tool.name) ?? 0) === 1) return tool;

    const suffix = `_${count}`;
    const name =
      count === 1
        ? tool.name
        : `${tool.name.slice(0, 30 - suffix.length).replace(/_+$/g, "")}${suffix}`;
    const confidence = applyCollisionPenalty(
      {
        score: tool.confidence,
        reasons: tool.confidenceReasons,
        status: tool.status === "published" ? "auto" : tool.status,
      },
      count === 1
        ? `“${tool.name}” collides with another normalized tool name`
        : `“${tool.name}” collides after normalization; renamed to “${name}”`,
    );
    return {
      ...tool,
      name,
      confidence: confidence.score,
      confidenceReasons: confidence.reasons,
      status: confidence.status,
    };
  });
}

/**
 * Navigation is not content, but where a site can take you is genuinely useful
 * to an agent. It gets one read tool of its own rather than being mistaken for
 * a product list.
 */
function navigationTool(collection: CollectionSnapshot): GraftTool {
  const named = collection.rows.filter((row) => Boolean(row.fields.title || row.text)).length;
  const confidence = scoreConfidence({
    accessibleName: "Navigation links carry their own link text",
    stableSelector: collection.selectorStable ? "Navigation region resolves uniquely" : false,
    positionalSelector: !collection.selectorStable
      ? "Navigation region requires a positional selector"
      : false,
    fullyTypedInputs: "Pagination maps to bounded integer parameters",
    ambiguousRepeat:
      named < collection.rows.length ? "Some navigation entries have no link text" : false,
  });
  return withConfidence(
    {
      id: collection.id,
      name: "list_navigation",
      description:
        "List the navigation destinations offered by this page, with their link text and target. Use it to discover where the site can go before asking for a specific page. Returns untrusted page content and never changes the page.",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "integer", description: "Zero-based row offset.", minimum: 0, default: 0 },
          limit: {
            type: "integer",
            description: "Maximum rows to return.",
            minimum: 1,
            maximum: 25,
            default: 15,
          },
        },
        additionalProperties: false,
      },
      recipe: "R6",
      selector: collection.selector,
      fallbackSelectors: [],
      action: "read",
      readOnly: true,
      destructive: false,
      origin: "derived",
      binding: { kind: "collection", itemSelector: collection.itemSelector },
    },
    confidence,
  );
}

function actionCandidateTool(candidate: ActionCandidateSnapshot): GraftTool {
  const noun = normalizeToolName(candidate.label, "submit_action");
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  if (candidate.targets.length > 0) {
    properties.target = {
      type: "string",
      description: "Which item the action applies to, exactly as shown on the page.",
      enum: candidate.targets,
    };
    required.push("target");
  }

  const confidence = scoreConfidence({
    overrideScore: 55,
    accessibleName: `Control is labelled “${candidate.label}”`,
    ambiguousRepeat:
      candidate.count > 1 && candidate.targets.length === 0
        ? `${candidate.count} identical controls with no distinguishing text`
        : false,
  });

  // An unbound destructive contract must never register itself. Whatever the
  // evidence says, this one waits for a human.
  const held: ConfidenceResult = {
    score: Math.min(confidence.score, 55),
    reasons: [
      ...confidence.reasons,
      "Held: a write contract with no bound handler is never registered automatically",
    ],
    status: "held",
  };

  return withConfidence(
    {
      id: candidate.id,
      name: normalizeToolName(noun, "submit_action"),
      description: `Perform "${candidate.label}" on this page. Graft derived this contract from ${candidate.count === 1 ? "one control" : `${candidate.count} repeated controls`} but no handler is bound, because a snapshot cannot write to a site Graft does not own. Export the manifest to implement it.`,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      recipe: "R7",
      selector: candidate.selector,
      fallbackSelectors: [],
      action: "unbound_write",
      readOnly: false,
      destructive: true,
      origin: "derived",
      binding: {
        kind: "action_candidate",
        controlSelector: candidate.selector,
        targets: candidate.targets,
      },
    },
    held,
  );
}

export function deriveToolsFromSnapshot(snapshot: PageSnapshot): GraftTool[] {
  const tools: GraftTool[] = [summaryTool(snapshot)];
  const outline = outlineTool(snapshot);
  if (outline) tools.push(outline);
  tools.push(...snapshot.searchForms.map(searchTool));
  let navigationEmitted = false;
  for (const collection of snapshot.collections) {
    if (collection.chrome) {
      // One navigation tool is useful. Six are noise.
      if (navigationEmitted || collection.rows.length < 3) continue;
      navigationEmitted = true;
      tools.push(navigationTool(collection));
      continue;
    }
    tools.push(collectionTool(collection));
    const detail = collectionDetailTool(collection);
    if (detail) tools.push(detail);
  }
  for (const table of snapshot.tables) {
    tools.push(tableTool(table));
    const detail = tableDetailTool(table);
    if (detail) tools.push(detail);
  }
  tools.push(...snapshot.localActions.map(localActionTool));
  tools.push(...snapshot.actionCandidates.map(actionCandidateTool));
  return uniqueNames(dedupeEquivalentTools(tools));
}

/**
 * Responsive markup ships the same control twice, once for mobile and once for
 * desktop. Emitting search_products and search_products_2 hands the agent a
 * coin flip, so identical contracts collapse to the most confident one.
 */
function dedupeEquivalentTools(tools: GraftTool[]): GraftTool[] {
  const byShape = new Map<string, GraftTool>();
  const ordered: GraftTool[] = [];

  for (const tool of tools) {
    const shape = [
      tool.name,
      tool.recipe,
      tool.action,
      Object.keys(tool.inputSchema?.properties ?? {}).sort().join(","),
    ].join("|");
    const existing = byShape.get(shape);
    if (!existing) {
      byShape.set(shape, tool);
      ordered.push(tool);
      continue;
    }
    if (tool.confidence > existing.confidence) {
      byShape.set(shape, tool);
      ordered[ordered.indexOf(existing)] = tool;
    }
  }

  return ordered;
}

export function deriveTools(root: ParentNode = document): GraftTool[] {
  return deriveToolsFromSnapshot(deriveSnapshot(root));
}

export function compileDocument(root: ParentNode = document): GraftCompilation {
  const snapshot = deriveSnapshot(root);
  const tools = deriveToolsFromSnapshot(snapshot);
  return {
    snapshot,
    tools,
    counts: {
      auto: tools.filter((tool) => tool.status === "auto").length,
      held: tools.filter((tool) => tool.status === "held").length,
      rejected: tools.filter((tool) => tool.status === "rejected").length,
    },
  };
}

export function toolSetFingerprint(tools: GraftTool[]): string {
  return stableId(
    ...tools.map((tool) =>
      [
        tool.id,
        tool.name,
        tool.status,
        tool.selector,
        tool.confidence,
        JSON.stringify(tool.inputSchema),
      ].join(":"),
    ),
  );
}
