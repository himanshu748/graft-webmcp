import catalogHtml from "./fixtureHtml/catalog.html?raw";
import dataTableHtml from "./fixtureHtml/data-table.html?raw";
import fieldGuideHtml from "./fixtureHtml/field-guide.html?raw";

export type FixtureId = "catalog" | "field-guide" | "data-table";

export type FixturePattern =
  | "search-form"
  | "repeated-list"
  | "detail-records"
  | "definition-lists"
  | "semantic-table"
  | "owned-form";

export interface ExpectedTool {
  name: string;
  mode: "read" | "local-write";
  source: "search-form" | "repeated-content" | "table" | "owned-form";
  description: string;
}

export interface ControlledFixtureAction {
  toolName: "add_to_demo_cart";
  marker: '[data-graft-tool="add_to_demo_cart"]';
  effect: "local-demo-cart";
  allowedProductIds: readonly string[];
  quantity: Readonly<{ min: 1; max: 3 }>;
}

export interface FixtureDefinition {
  id: FixtureId;
  shortLabel: string;
  title: string;
  description: string;
  sourceUrl: string;
  html: string;
  patterns: readonly FixturePattern[];
  expectedTools: readonly ExpectedTool[];
  controlledAction?: ControlledFixtureAction;
}

export const defaultFixtureId: FixtureId = "catalog";

export const fixtureDefinitions = [
  {
    id: "catalog",
    shortLabel: "Catalog",
    title: "Signal Cabinet",
    description: "A compact music-device catalogue with search, repeated products, typed prices and one controlled local cart action.",
    sourceUrl: "/fixtures/catalog.html",
    html: catalogHtml,
    patterns: ["search-form", "repeated-list", "detail-records", "definition-lists", "owned-form"],
    expectedTools: [
      {
        name: "search_catalog",
        mode: "read",
        source: "search-form",
        description: "Search devices by text, category and stock state.",
      },
      {
        name: "list_products",
        mode: "read",
        source: "repeated-content",
        description: "Return the structured product collection.",
      },
      {
        name: "get_product",
        mode: "read",
        source: "repeated-content",
        description: "Return one product by its stable product ID.",
      },
      {
        name: "add_to_demo_cart",
        mode: "local-write",
        source: "owned-form",
        description: "Add an allowlisted fixture product to an in-memory demo cart.",
      },
    ],
    controlledAction: {
      toolName: "add_to_demo_cart",
      marker: '[data-graft-tool="add_to_demo_cart"]',
      effect: "local-demo-cart",
      allowedProductIds: [
        "palm-relay",
        "shoreline-4",
        "loop-fold",
        "grain-dial",
        "tone-parcel",
        "cable-dock-8",
      ],
      quantity: { min: 1, max: 3 },
    },
  },
  {
    id: "field-guide",
    shortLabel: "Field guide",
    title: "Mossbank Field Guide",
    description: "An editorial knowledge base with semantic search, topic navigation, repeated entries and a plain-language glossary.",
    sourceUrl: "/fixtures/field-guide.html",
    html: fieldGuideHtml,
    patterns: ["search-form", "repeated-list", "detail-records", "definition-lists"],
    expectedTools: [
      {
        name: "search_field_guide",
        mode: "read",
        source: "search-form",
        description: "Search knowledge entries by text and topic.",
      },
      {
        name: "list_entries",
        mode: "read",
        source: "repeated-content",
        description: "List field-guide entries with topic and reading-time metadata.",
      },
      {
        name: "read_entry",
        mode: "read",
        source: "repeated-content",
        description: "Return one field-guide entry by its stable slug.",
      },
    ],
  },
  {
    id: "data-table",
    shortLabel: "Data table",
    title: "Basin Ledger",
    description: "A dense materials-intake page with query controls, typed values, scoped headers and a semantic table.",
    sourceUrl: "/fixtures/data-table.html",
    html: dataTableHtml,
    patterns: ["search-form", "semantic-table", "detail-records"],
    expectedTools: [
      {
        name: "filter_batches",
        mode: "read",
        source: "search-form",
        description: "Filter ledger rows by query, status and storage zone.",
      },
      {
        name: "list_batches",
        mode: "read",
        source: "table",
        description: "Return all structured material batches.",
      },
      {
        name: "get_batch",
        mode: "read",
        source: "table",
        description: "Return one batch by its stable batch ID.",
      },
    ],
  },
] as const satisfies readonly FixtureDefinition[];

export const fixtureById: Readonly<Record<FixtureId, FixtureDefinition>> = {
  catalog: fixtureDefinitions[0],
  "field-guide": fixtureDefinitions[1],
  "data-table": fixtureDefinitions[2],
};

export const fixtureHtmlById: Readonly<Record<FixtureId, string>> = {
  catalog: catalogHtml,
  "field-guide": fieldGuideHtml,
  "data-table": dataTableHtml,
};

export function isFixtureId(value: string): value is FixtureId {
  return value in fixtureById;
}

export function getFixture(id: FixtureId): FixtureDefinition {
  return fixtureById[id];
}
