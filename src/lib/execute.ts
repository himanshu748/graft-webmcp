import {
  abortError,
  errorMessage,
  getOwnerDocument,
  isElementVisible,
  normalizeParameterName,
  normalizeWhitespace,
  resolveUniqueElement,
  sanitizePageText,
  throwIfAborted,
} from "./dom-utils";
import { deriveSnapshot, snapshotElementRow } from "./snapshot";
import { validateToolArguments } from "./validation";
import type {
  LiveSearchRequest,
  LiveSearchResponse,
  GraftTool,
  JsonValue,
  SnapshotRow,
  ToolContentResult,
  ToolExecutionResult,
} from "./types";

export interface ToolConfirmationRequest {
  tool: GraftTool;
  args: Record<string, unknown>;
  target: Element | null;
  signal?: AbortSignal;
}

export interface ExecuteToolOptions {
  runLiveSearch?: (request: LiveSearchRequest) => Promise<LiveSearchResponse>;
  root?: ParentNode;
  signal?: AbortSignal;
  maxOutputChars?: number;
  settleQuietMs?: number;
  settleTimeoutMs?: number;
  confirm?: (request: ToolConfirmationRequest) => boolean | Promise<boolean>;
}

export interface DomSettleOptions {
  signal?: AbortSignal;
  quietMs?: number;
  timeoutMs?: number;
}

interface PaginatedRows {
  rows: SnapshotRow[];
  total: number;
  offset: number;
  limit: number;
  remaining: number;
}

const DEFAULT_MAX_OUTPUT = 1_500;
const MAX_OUTPUT = 10_000;

function numberArgument(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function paginate(rows: SnapshotRow[], args: Record<string, unknown>): PaginatedRows {
  const offset = numberArgument(args.offset, 0, 0, Math.max(0, rows.length));
  const limit = numberArgument(args.limit, 10, 1, 25);
  const selected = rows.slice(offset, offset + limit);
  return {
    rows: selected,
    total: rows.length,
    offset,
    limit,
    remaining: Math.max(0, rows.length - (offset + selected.length)),
  };
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as JsonValue;
  }
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, asJsonValue(item)]),
    );
  }
  return String(value);
}

function contentResult(
  text: string,
  structuredContent: Record<string, unknown>,
  maxChars: number,
): ToolExecutionResult {
  const result: ToolExecutionResult = {
    ok: true,
    message: truncateToolOutput(text, maxChars),
    data: Object.fromEntries(
      Object.entries(structuredContent).map(([key, value]) => [key, asJsonValue(value)]),
    ),
  };
  if (JSON.stringify(result).length <= maxChars) return result;

  result.message = truncateToolOutput(text, Math.min(360, Math.max(120, maxChars / 3)));
  if (result.data) {
    result.data = compactJsonRecord(result.data);
    const rows = result.data.rows;
    if (Array.isArray(rows)) {
      while (rows.length > 1 && JSON.stringify(result).length > maxChars) rows.pop();
      result.data.returnedRows = rows.length;
      result.data.truncated = true;
    }
  }
  if (JSON.stringify(result).length <= maxChars) return result;

  result.data = { truncated: true };
  const wrapperBudget = Math.max(40, maxChars - JSON.stringify({ ...result, message: "" }).length);
  result.message = truncateToolOutput(text, wrapperBudget);
  if (JSON.stringify(result).length <= maxChars) return result;
  return { ok: true, message: "Output truncated. Use a larger offset or narrower filter." };
}

function compactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return truncateToolOutput(value, 220);
  if (Array.isArray(value)) return value.slice(0, 10).map(compactJsonValue);
  if (value && typeof value === "object") return compactJsonRecord(value);
  return value;
}

function compactJsonRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 24)
      .map(([key, item]) => [key, compactJsonValue(item)]),
  );
}

/**
 * Live results still owe the agent an honest, bounded payload, and a truncated
 * list must say it was truncated so the agent paginates instead of assuming it
 * saw everything.
 */
function liveRowsWithinBudget(rows: string[], maxChars: number): string[] {
  const budget = Math.max(200, maxChars - 200);
  const kept: string[] = [];
  let used = 0;
  for (const row of rows) {
    const text = truncateToolOutput(row, 300);
    if (used + text.length > budget) break;
    kept.push(text);
    used += text.length;
  }
  if (kept.length < rows.length) {
    kept.push(`...truncated, ${rows.length - kept.length} more results not shown.`);
  }
  return kept;
}

export function truncateToolOutput(text: string, maxChars = DEFAULT_MAX_OUTPUT): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  const marker = " …truncated; call again with a larger offset for more rows.";
  if (marker.length >= maxChars) {
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

function rowsText(label: string, page: PaginatedRows, maxChars: number): string {
  const returned = page.rows.length;
  const next = page.remaining
    ? ` ${page.remaining} remain; continue at offset ${page.offset + returned}.`
    : " No rows remain.";
  return truncateToolOutput(
    `${label}: returned ${returned} of ${page.total} total rows from offset ${page.offset}.${next}`,
    maxChars,
  );
}

function toolRoot(options: ExecuteToolOptions): ParentNode {
  return options.root ?? document;
}

function targetForTool(tool: GraftTool, root: ParentNode): Element | null {
  return resolveUniqueElement(root, tool.selector, tool.fallbackSelectors);
}

function cancelledResult(message = "Cancelled: the user did not confirm."): ToolExecutionResult {
  return { ok: false, message };
}

function withAbort<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return value;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function confirmIfNeeded(
  tool: GraftTool,
  args: Record<string, unknown>,
  target: Element | null,
  options: ExecuteToolOptions,
): Promise<ToolExecutionResult | null> {
  if (!tool.destructive) return null;
  if (!options.confirm) {
    return cancelledResult("Blocked: this tool requires explicit in-page confirmation.");
  }
  const confirmed = await withAbort(
    Promise.resolve(options.confirm({ tool, args, target, signal: options.signal })),
    options.signal,
  );
  throwIfAborted(options.signal);
  return confirmed ? null : cancelledResult();
}

function preflightTool(tool: GraftTool, args: Record<string, unknown>): void {
  if (tool.binding.kind !== "local_cart") return;
  const productId = normalizeWhitespace(args.product_id);
  const quantity = typeof args.quantity === "number" ? args.quantity : Number(args.quantity);
  if (!tool.binding.allowedProductIds.includes(productId)) {
    throw new Error(`Product “${productId || "(empty)"}” is not in the fixture allowlist.`);
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 3) {
    throw new Error("Quantity must be an integer from 1 to 3.");
  }
}

function summaryResult(root: ParentNode, maxChars: number): ToolExecutionResult {
  const snapshot = deriveSnapshot(root);
  const structured = {
    title: snapshot.title,
    url: snapshot.url,
    description: snapshot.description,
    headings: snapshot.headings.map(({ level, text }) => ({ level, text })),
    mainText: snapshot.mainText,
  };
  const text = [
    snapshot.title,
    snapshot.description,
    snapshot.headings.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`).join("\n"),
    snapshot.mainText,
  ]
    .filter(Boolean)
    .join("\n");
  return contentResult(text, structured, maxChars);
}

function outlineResult(root: ParentNode, maxChars: number): ToolExecutionResult {
  const headings = deriveSnapshot(root).headings.map(({ level, text }) => ({ level, text }));
  const text = headings.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`).join("\n");
  return contentResult(text || "No visible headings found.", { headings }, maxChars);
}

interface LiveSectionGroupItem {
  element: Element;
  row: SnapshotRow;
}

function isVisibleWithin(element: Element, boundary: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (!isElementVisible(current) || current.hasAttribute("data-graft-ignore")) return false;
    if (current === boundary) return true;
    current = current.parentElement;
  }
  return false;
}

function visibleDescendantText(element: Element, boundary: Element, maxLength: number): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (
      !isVisibleWithin(child, boundary) ||
      ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "SVG"].includes(child.tagName)
    ) {
      return;
    }
    child.childNodes.forEach(visit);
  };
  visit(element);
  return sanitizePageText(parts.join(" "), maxLength);
}

function liveSectionGroupItems(tool: GraftTool, target: Element): LiveSectionGroupItem[] {
  if (tool.binding.kind !== "section_group" && tool.binding.kind !== "show_section") return [];
  const binding = tool.binding;
  const ownerDocument = getOwnerDocument(target);
  const allIdElements = [...ownerDocument.querySelectorAll("[id]")];

  return binding.sectionIds.map((id) => {
    const matches = allIdElements.filter((candidate) => candidate.getAttribute("id") === id);
    const section = matches[0];
    if (
      matches.length !== 1 ||
      !section ||
      section.parentElement !== target ||
      !section.matches("section, article, [role='region']") ||
      section.getAttribute("data-graft-section") !== binding.marker ||
      !isVisibleWithin(section, target)
    ) {
      throw new Error(`Tool “${tool.name}” is stale: section “${id}” no longer matches its contract.`);
    }

    const heading = [...section.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((candidate) =>
      isVisibleWithin(candidate, section),
    );
    const explicitSummary = [
      ...section.querySelectorAll('[data-field="summary"], [itemprop="description"]'),
    ].find((candidate) => isVisibleWithin(candidate, section));
    const summary =
      explicitSummary ??
      [...section.querySelectorAll("p")].find((candidate) =>
        isVisibleWithin(candidate, section),
      );
    const title = heading ? visibleDescendantText(heading, section, 180) : "";
    const summaryText = summary ? visibleDescendantText(summary, section, 400) : "";
    if (!title || !summaryText) {
      throw new Error(`Tool “${tool.name}” is stale: section “${id}” lost its heading or summary.`);
    }

    return {
      element: section,
      row: {
        fields: { id, title, summary: summaryText },
        text: `${title} ${summaryText}`,
      },
    };
  });
}

function sectionGroupRows(tool: GraftTool, target: Element): SnapshotRow[] {
  return liveSectionGroupItems(tool, target).map((item) => item.row);
}

function sectionGroupResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  const page = paginate(sectionGroupRows(tool, target), args);
  return contentResult(
    rowsText(tool.name, page, maxChars),
    {
      rows: page.rows.map((row) => row.fields),
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.remaining > 0,
    },
    maxChars,
  );
}

function showSectionResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  if (tool.binding.kind !== "show_section") {
    throw new Error(`Tool “${tool.name}” has an invalid section binding.`);
  }
  const id = normalizeWhitespace(args.id);
  if (!tool.binding.sectionIds.includes(id)) {
    throw new Error(`Section “${id || "(empty)"}” is not in the compiled allowlist.`);
  }

  const item = liveSectionGroupItems(tool, target).find((candidate) => candidate.row.fields.id === id);
  if (!item) throw new Error(`Section “${id}” is no longer available.`);

  const ownerDocument = getOwnerDocument(target);
  const scrollIntoView = ownerDocument.defaultView?.Element.prototype.scrollIntoView;
  if (typeof scrollIntoView !== "function") {
    throw new Error("This browser cannot move the viewport to the requested section.");
  }
  scrollIntoView.call(item.element, { behavior: "auto", block: "center" });

  return contentResult(
    `Moved the current page to “${item.row.fields.title || id}”.`,
    { section: item.row.fields, effect: "scrolled_into_view" },
    maxChars,
  );
}

function collectionRows(tool: GraftTool, root: ParentNode, target: Element): SnapshotRow[] {
  if (tool.binding.kind !== "collection") return [];
  let items: Element[] = [];
  try {
    items = [...root.querySelectorAll(tool.binding.itemSelector)].filter(
      (item) => target.contains(item) && isElementVisible(item),
    );
  } catch {
    items = [];
  }
  if (items.length === 0) {
    items = [...target.children].filter(
      (element) =>
        !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(element.tagName) &&
        isElementVisible(element),
    );
  }
  return items.map(snapshotElementRow);
}

function collectionResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  root: ParentNode,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  const page = paginate(collectionRows(tool, root, target), args);
  return contentResult(
    rowsText(tool.name, page, maxChars),
    {
      rows: page.rows.map((row) => row.fields),
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.remaining > 0,
    },
    maxChars,
  );
}

function collectionItemResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  root: ParentNode,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  if (tool.binding.kind !== "collection_item") {
    throw new Error(`Tool “${tool.name}” has an invalid collection binding.`);
  }
  const expected = normalizeWhitespace(args[tool.binding.keyField]);
  const keyField = tool.binding.keyField;
  if (!expected) throw new Error(`A non-empty ${tool.binding.keyField} is required.`);
  const row = collectionRows(
    { ...tool, binding: { kind: "collection", itemSelector: tool.binding.itemSelector } },
    root,
    target,
  ).find((candidate) => candidate.fields[keyField] === expected);
  if (!row) throw new Error(`No visible row has ${keyField} “${expected}”.`);
  return contentResult(
    JSON.stringify(row.fields),
    { row: row.fields, key: expected },
    maxChars,
  );
}

function tableRows(tool: GraftTool, target: Element): SnapshotRow[] {
  if (tool.binding.kind !== "table" || target.tagName !== "TABLE") return [];
  const table = target as HTMLTableElement;
  const headerRow = [...table.rows].find((row) => row.querySelector("th"));
  return [...table.rows]
    .filter((row) => row !== headerRow && row.cells.length > 0 && isElementVisible(row))
    .map((row) => {
      const fields: Record<string, string> = {};
      for (const column of tool.binding.kind === "table" ? tool.binding.columns : []) {
        fields[column.key] = normalizeWhitespace(row.cells[column.index]?.textContent);
      }
      return { fields, text: Object.values(fields).join(" · ") };
    });
}

function filterTableRows(
  tool: GraftTool,
  rows: SnapshotRow[],
  args: Record<string, unknown>,
): SnapshotRow[] {
  if (tool.binding.kind !== "table") return rows;
  return rows.filter((row) =>
    tool.binding.kind === "table"
      ? tool.binding.columns.every((column) => {
          const expected = normalizeWhitespace(args[column.key]).toLowerCase();
          if (!expected) return true;
          return normalizeWhitespace(row.fields[column.key]).toLowerCase().includes(expected);
        })
      : true,
  );
}

function tableResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  const matchingRows = filterTableRows(tool, tableRows(tool, target), args);
  const page = paginate(matchingRows, args);
  return contentResult(
    rowsText(tool.name, page, maxChars),
    {
      rows: page.rows.map((row) => row.fields),
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.remaining > 0,
    },
    maxChars,
  );
}

function tableItemResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  if (tool.binding.kind !== "table_item") {
    throw new Error(`Tool “${tool.name}” has an invalid table binding.`);
  }
  const expected = normalizeWhitespace(args[tool.binding.keyField]);
  const keyField = tool.binding.keyField;
  if (!expected) throw new Error(`A non-empty ${tool.binding.keyField} is required.`);
  const row = tableRows(
    { ...tool, binding: { kind: "table", columns: tool.binding.columns } },
    target,
  ).find((candidate) => candidate.fields[keyField] === expected);
  if (!row) throw new Error(`No visible table row has ${keyField} “${expected}”.`);
  return contentResult(
    JSON.stringify(row.fields),
    { row: row.fields, key: expected },
    maxChars,
  );
}

function setNativeValue(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const ownerDocument = input.ownerDocument;
  const view = ownerDocument.defaultView;
  const prototype =
    input.tagName === "TEXTAREA"
      ? view?.HTMLTextAreaElement?.prototype
      : input.tagName === "SELECT"
        ? view?.HTMLSelectElement?.prototype
        : view?.HTMLInputElement?.prototype;
  const setter = prototype
    ? Object.getOwnPropertyDescriptor(prototype, "value")?.set
    : undefined;
  if (setter) setter.call(input, value);
  else input.value = value;

  const EventConstructor = view?.Event ?? Event;
  input.dispatchEvent(new EventConstructor("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new EventConstructor("change", { bubbles: true, composed: true }));
}

function setNativeChecked(input: HTMLInputElement, checked: boolean): void {
  const view = input.ownerDocument.defaultView;
  const setter = view?.HTMLInputElement
    ? Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "checked")?.set
    : undefined;
  if (setter) setter.call(input, checked);
  else input.checked = checked;
  const EventConstructor = view?.Event ?? Event;
  input.dispatchEvent(new EventConstructor("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new EventConstructor("change", { bubbles: true, composed: true }));
}

function queryInsideForm<T extends Element>(
  root: ParentNode,
  form: HTMLFormElement,
  selector: string,
  fallback: string,
): T | null {
  let element: Element | null = null;
  try {
    element = root.querySelector(selector);
  } catch {
    element = null;
  }
  if (!element || !form.contains(element)) element = form.querySelector(fallback);
  return element as T | null;
}

function localCartResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  root: ParentNode,
  target: Element,
  maxChars: number,
): ToolExecutionResult {
  if (tool.binding.kind !== "local_cart" || target.tagName !== "FORM") {
    throw new Error(`Tool “${tool.name}” no longer resolves to its local fixture form.`);
  }
  const productId = normalizeWhitespace(args.product_id);
  const quantity = typeof args.quantity === "number" ? args.quantity : Number(args.quantity);
  if (!tool.binding.allowedProductIds.includes(productId)) {
    throw new Error(`Product “${productId || "(empty)"}” is not in the fixture allowlist.`);
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 3) {
    throw new Error("Quantity must be an integer from 1 to 3.");
  }

  const form = target as HTMLFormElement;
  const product = queryInsideForm<HTMLSelectElement>(
    root,
    form,
    tool.binding.productSelector,
    'select[name="product_id"]',
  );
  const quantityInput = queryInsideForm<HTMLInputElement>(
    root,
    form,
    tool.binding.quantitySelector,
    'input[name="quantity"]',
  );
  const output = queryInsideForm<HTMLOutputElement>(
    root,
    form,
    tool.binding.outputSelector,
    "output",
  );
  if (product?.tagName !== "SELECT" || quantityInput?.tagName !== "INPUT" || output?.tagName !== "OUTPUT") {
    throw new Error(`Local controls for “${tool.name}” are stale or ambiguous.`);
  }

  setNativeValue(product, productId);
  setNativeValue(quantityInput, String(quantity));
  const productLabel = normalizeWhitespace(product.selectedOptions[0]?.textContent) || productId;
  const message = `Demo cart updated: ${quantity} × ${productLabel}. No purchase was made.`;
  output.value = message;
  output.textContent = message;

  const cartCount = form.ownerDocument.querySelector<HTMLDataElement>('a[href="#demo-cart"] data');
  const nextCount = numberArgument(cartCount?.value, 0, 0, 999) + quantity;
  if (cartCount) {
    cartCount.value = String(nextCount);
    cartCount.textContent = String(nextCount);
  }

  const view = form.ownerDocument.defaultView;
  const EventConstructor = view?.CustomEvent;
  if (EventConstructor) {
    form.dispatchEvent(
      new EventConstructor("graft:local-action", {
        bubbles: true,
        detail: { product_id: productId, quantity, cart_count: nextCount },
      }),
    );
  }
  return contentResult(
    message,
    {
      product_id: productId,
      product_label: productLabel,
      quantity,
      cart_count: nextCount,
      local_only: true,
    },
    maxChars,
  );
}

function dispatchSafeSubmit(form: HTMLFormElement): void {
  const view = form.ownerDocument.defaultView;
  const SubmitEventConstructor = view?.SubmitEvent;
  const event = SubmitEventConstructor
    ? new SubmitEventConstructor("submit", { bubbles: true, cancelable: true })
    : new (view?.Event ?? Event)("submit", { bubbles: true, cancelable: true });
  event.preventDefault();
  form.dispatchEvent(event);
}

function searchResultRegion(root: ParentNode, form: HTMLFormElement): Element {
  return (
    root.querySelector("[role='status'], [aria-live], main, [role='main']") ??
    form.ownerDocument.body ??
    form
  );
}

function searchableRows(root: ParentNode, form: HTMLFormElement): Element[] {
  const groups = [...root.querySelectorAll("[role='list'], table")]
    .map((container) => ({
      container,
      rows: container.matches("table")
        ? [...container.querySelectorAll(":scope tbody > tr")]
        : [...container.querySelectorAll(":scope > [role='listitem']")],
    }))
    .filter((group) => group.rows.length > 0);
  const following = groups.find(
    (group) => Boolean(form.compareDocumentPosition(group.container) & 4),
  );
  return following?.rows ?? groups[0]?.rows ?? [];
}

function normalizedMatchText(value: unknown): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[-_]+/g, " ");
}

function rowMatchesSearch(
  row: Element,
  fields: GraftTool["binding"] & { kind: "search" },
  applied: Record<string, string | number | boolean>,
): boolean {
  const rowText = normalizedMatchText(row.textContent);
  for (const field of fields.fields) {
    const value = applied[field.key];
    if (value === undefined || value === false) continue;
    const expected = normalizedMatchText(value);
    if (!expected || expected === "all") continue;
    if (field.control === "checkbox") {
      if (field.key === "in_stock" && !/(?:\bin stock\b|instock)/.test(rowText)) return false;
      continue;
    }
    if (!rowText.includes(expected)) return false;
  }
  return true;
}

function snapshotSearchRow(row: Element): SnapshotRow {
  if (row.tagName !== "TR") return snapshotElementRow(row);
  const fields: Record<string, string> = {};
  for (const attribute of row.getAttributeNames()) {
    const match = attribute.match(/^data-(.+)-(id|slug)$/i);
    const value = row.getAttribute(attribute);
    if (match && value) fields[normalizeParameterName(`${match[1]}_${match[2]}`)] = value;
  }
  const table = row.closest("table") as HTMLTableElement | null;
  const headers = table
    ? [...table.querySelectorAll("thead th")].map((header, index) =>
        normalizeParameterName(header.textContent ?? "", `column_${index + 1}`),
      )
    : [];
  const cells = [...(row as HTMLTableRowElement).cells];
  cells.forEach((cell, index) => {
    fields[headers[index] ?? `column_${index + 1}`] = normalizeWhitespace(cell.textContent);
  });
  return { fields, text: normalizeWhitespace(row.textContent) };
}

function applyLocalSearch(
  root: ParentNode,
  form: HTMLFormElement,
  binding: GraftTool["binding"] & { kind: "search" },
  applied: Record<string, string | number | boolean>,
): { rows: SnapshotRow[]; total: number } | null {
  const candidates = searchableRows(root, form);
  if (candidates.length === 0) return null;
  const matches: Element[] = [];
  for (const row of candidates) {
    const matchesSearch = rowMatchesSearch(row, binding, applied);
    row.toggleAttribute("hidden", !matchesSearch);
    if (matchesSearch) matches.push(row);
  }
  return { rows: matches.map(snapshotSearchRow), total: candidates.length };
}

async function searchResult(
  tool: GraftTool,
  args: Record<string, unknown>,
  root: ParentNode,
  target: Element,
  options: ExecuteToolOptions,
  maxChars: number,
): Promise<ToolExecutionResult> {
  if (tool.binding.kind !== "search" || target.tagName !== "FORM") {
    throw new Error(`Tool “${tool.name}” no longer resolves to its search form.`);
  }
  const form = target as HTMLFormElement;

  // A snapshot can only filter the rows it captured. When the form declares a
  // GET endpoint and a runner is available, the query goes to the live site so
  // the agent sees results the snapshot never held.
  if (tool.binding.liveEndpoint && options.runLiveSearch) {
    const params: Record<string, string> = {};
    for (const field of tool.binding.fields) {
      const raw = args[field.key];
      if (raw === undefined || raw === null || raw === "") continue;
      params[field.name] = String(raw);
    }
    if (Object.keys(params).length > 0) {
      try {
        const live = await options.runLiveSearch({
          endpoint: tool.binding.liveEndpoint,
          params,
          toolName: tool.name,
        });
        throwIfAborted(options.signal);
        if (live.rows.length > 0) {
          return {
            ok: true,
            message: `${live.total} result${live.total === 1 ? "" : "s"} from the live page.`,
            data: {
              source: "live",
              url: live.url,
              total: live.total,
              results: liveRowsWithinBudget(live.rows, maxChars),
            },
          };
        }
        return {
          ok: true,
          message: "The live page returned no matching results.",
          data: { source: "live", url: live.url, total: 0, results: [] },
        };
      } catch (error) {
        // Falling back to the snapshot is better than failing the call, but the
        // agent is told which one it got.
        void error;
      }
    }
  }

  const applied: Record<string, string | number | boolean> = {};
  for (const field of tool.binding.fields) {
    const rawValue = args[field.key];
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const control = queryInsideForm<HTMLInputElement | HTMLSelectElement>(
      root,
      form,
      field.selector,
      `[name="${field.key}"]`,
    );
    if (!control) throw new Error(`Search field “${field.key}” is stale or ambiguous.`);
    if (field.control === "checkbox") {
      if (typeof rawValue !== "boolean" || control.tagName !== "INPUT") {
        throw new Error(`Search field “${field.key}” requires a boolean.`);
      }
      setNativeChecked(control as HTMLInputElement, rawValue);
      applied[field.key] = rawValue;
      continue;
    }
    if (field.control === "number") {
      const number = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (
        !Number.isFinite(number) ||
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      ) {
        throw new Error(`Search field “${field.key}” is outside its allowed numeric range.`);
      }
      setNativeValue(control as HTMLInputElement, String(number));
      applied[field.key] = number;
      continue;
    }
    const value = normalizeWhitespace(rawValue);
    if (field.enum && !field.enum.includes(value)) {
      throw new Error(`Search field “${field.key}” does not allow “${value}”.`);
    }
    setNativeValue(control as HTMLInputElement | HTMLSelectElement, value);
    applied[field.key] = value;
  }
  if (Object.keys(applied).length === 0) {
    throw new Error("Provide at least one search or filter field.");
  }
  throwIfAborted(options.signal);
  dispatchSafeSubmit(form);
  const filtered = applyLocalSearch(root, form, tool.binding, applied);
  await waitForDomSettled(searchResultRegion(root, form), {
    signal: options.signal,
    quietMs: options.settleQuietMs,
    timeoutMs: options.settleTimeoutMs,
  });
  if (filtered) {
    const page = paginate(filtered.rows, args);
    return contentResult(
      rowsText(`Matched ${filtered.rows.length} of ${filtered.total} visible source rows`, page, maxChars),
      {
        arguments: applied,
        rows: page.rows.map((row) => row.fields),
        matched: filtered.rows.length,
        total: filtered.total,
        hasMore: page.remaining > 0,
      },
      maxChars,
    );
  }
  const resultText = normalizeWhitespace(searchResultRegion(root, form).textContent);
  return contentResult(
    resultText || `Visible controls submitted with ${JSON.stringify(applied)}.`,
    { arguments: applied, submitted: true, visibleResult: resultText },
    maxChars,
  );
}

export function waitForDomSettled(
  target: Node,
  options: DomSettleOptions = {},
): Promise<void> {
  const quietMs = options.quietMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 3_000;
  throwIfAborted(options.signal);

  const ownerDocument = getOwnerDocument(target);
  const Observer = ownerDocument.defaultView?.MutationObserver;
  if (!Observer) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let quietTimer = 0;
    let timeoutTimer = 0;
    const view = ownerDocument.defaultView;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      view?.clearTimeout(quietTimer);
      view?.clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const scheduleQuiet = () => {
      view?.clearTimeout(quietTimer);
      quietTimer = view?.setTimeout(() => finish(), quietMs) ?? 0;
    };
    const onAbort = () => finish(options.signal?.reason ?? abortError());
    const observer = new Observer(scheduleQuiet);
    observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = view?.setTimeout(() => finish(), timeoutMs) ?? 0;
    scheduleQuiet();
  });
}

/**
 * The spec's execute contract returns content blocks. Returning the raw internal
 * result would hand the agent a shape it has no reason to understand, so the
 * structured payload rides alongside the text.
 */
export function toContentResult(result: ToolExecutionResult): ToolContentResult {
  return {
    content: [{ type: "text", text: result.message }],
    ...(result.data ? { structuredContent: result.data } : {}),
    ...(result.ok ? {} : { isError: true as const }),
  };
}

export async function executeTool(
  tool: GraftTool,
  args: Record<string, unknown> = {},
  options: ExecuteToolOptions = {},
): Promise<ToolExecutionResult> {
  throwIfAborted(options.signal);
  validateToolArguments(tool, args);
  const root = toolRoot(options);
  const maxChars = numberArgument(
    options.maxOutputChars,
    DEFAULT_MAX_OUTPUT,
    200,
    MAX_OUTPUT,
  );
  const target = targetForTool(tool, root);
  if (!target && tool.binding.kind !== "summary") {
    throw new Error(`Tool “${tool.name}” is stale: its selector no longer resolves uniquely.`);
  }

  preflightTool(tool, args);
  const cancelled = await confirmIfNeeded(tool, args, target, options);
  if (cancelled) return cancelled;
  throwIfAborted(options.signal);

  switch (tool.binding.kind) {
    case "summary":
      return summaryResult(root, maxChars);
    case "outline":
      return outlineResult(root, maxChars);
    case "section_group":
      return sectionGroupResult(tool, args, target as Element, maxChars);
    case "show_section":
      return showSectionResult(tool, args, target as Element, maxChars);
    case "collection":
      return collectionResult(tool, args, root, target as Element, maxChars);
    case "collection_item":
      return collectionItemResult(tool, args, root, target as Element, maxChars);
    case "table":
      return tableResult(tool, args, target as Element, maxChars);
    case "table_item":
      return tableItemResult(tool, args, target as Element, maxChars);
    case "search":
      return searchResult(tool, args, root, target as Element, options, maxChars);
    case "action_candidate":
      return {
        ok: false,
        message:
          "No handler is bound. Graft derived this contract from a page it does not own, and an inert snapshot cannot perform a write. Export the manifest and bind a handler in the owner site to make it callable.",
        data: { boundHandler: false, control: tool.binding.controlSelector },
      };
    case "local_cart":
      return localCartResult(tool, args, root, target as Element, maxChars);
    default: {
      const exhaustive: never = tool.binding;
      throw new Error(`Unsupported tool binding: ${errorMessage(exhaustive)}`);
    }
  }
}
