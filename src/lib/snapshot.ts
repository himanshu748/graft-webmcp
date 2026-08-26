import {
  createSelector,
  findSectionLabel,
  getAccessibleName,
  isElementVisible,
  nounFromLabel,
  normalizeParameterName,
  normalizeWhitespace,
  sanitizePageText,
  stableId,
  pluralize,
  visibleText,
} from "./dom-utils";
import type {
  CollectionSnapshot,
  LocalActionSnapshot,
  PageSnapshot,
  SearchFormSnapshot,
  SearchFormFieldSnapshot,
  SnapshotRow,
  TableColumnSnapshot,
  TableSnapshot,
} from "./types";

const MAX_SNAPSHOT_ROWS = 100;
const SEARCH_TERM = /(?:^|[-_\s])(search|query|keyword|lookup|find|q)(?:$|[-_\s])/i;
const FIELD_TERM = /(price|cost|rating|status|availability|stock|author|date|time|category|tag|location)/i;

interface CollectionCandidate {
  parent: Element;
  items: Element[];
  inferredFromClasses: boolean;
}

function elementChildren(element: Element): Element[] {
  return [...element.children].filter(
    (child) => !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(child.tagName),
  );
}

function structuralSignature(element: Element): string {
  const classes = [...element.classList]
    .filter((token) => !/^(active|current|selected|open|closed|first|last|odd|even)$/i.test(token))
    .sort()
    .slice(0, 4)
    .join(".");
  const childShape = elementChildren(element)
    .slice(0, 8)
    .map((child) => child.tagName.toLowerCase())
    .join(",");
  return [
    element.tagName.toLowerCase(),
    element.getAttribute("role") ?? "",
    classes,
    childShape,
  ].join("|");
}

function repeatedChildren(parent: Element): Element[] {
  const children = elementChildren(parent).filter(isElementVisible);
  if (children.length < 3) return [];

  const groups = new Map<string, Element[]>();
  for (const child of children) {
    const signature = structuralSignature(child);
    const group = groups.get(signature) ?? [];
    group.push(child);
    groups.set(signature, group);
  }

  return [...groups.values()]
    .filter((group) => group.length >= 3)
    .sort((left, right) => right.length - left.length)[0] ?? [];
}

function collectionCandidates(root: ParentNode): CollectionCandidate[] {
  const candidates: CollectionCandidate[] = [];
  const claimed = new Set<Element>();

  for (const list of root.querySelectorAll("ul, ol, [role='list']")) {
    if (!isElementVisible(list)) continue;
    const items = elementChildren(list).filter(
      (child) => child.matches("li, [role='listitem']") && isElementVisible(child),
    );
    if (items.length < 3) continue;
    candidates.push({ parent: list, items, inferredFromClasses: false });
    items.forEach((item) => claimed.add(item));
  }

  const genericParents = root.querySelectorAll(
    "main, section, article, div, [role='main'], [role='region'], [role='feed']",
  );
  for (const parent of genericParents) {
    if (!isElementVisible(parent) || parent.closest("table")) continue;
    const items = repeatedChildren(parent);
    if (items.length < 3) continue;
    if (items.every((item) => claimed.has(item))) continue;
    if (candidates.some((candidate) => candidate.items.includes(parent))) {
      continue;
    }
    candidates.push({ parent, items, inferredFromClasses: true });
    items.forEach((item) => claimed.add(item));
  }

  return candidates.slice(0, 12);
}

function fieldNameFromElement(element: Element): string | null {
  const explicit = element.getAttribute("data-field") ?? element.getAttribute("itemprop");
  if (explicit) return normalizeParameterName(explicit);
  const token = [...element.classList].find((className) => FIELD_TERM.test(className));
  if (token) return normalizeParameterName(token.replace(/^(product|item)[-_]/i, ""));
  return null;
}

function firstUsefulTitle(element: Element): string {
  const titled = element.querySelector("[title]")?.getAttribute("title");
  if (titled) return sanitizePageText(titled, 180);
  const heading = element.querySelector("h1, h2, h3, h4, h5, h6");
  if (heading?.textContent) return sanitizePageText(heading.textContent, 180);
  const link = element.querySelector("a");
  if (link) return getAccessibleName(link);
  return "";
}

export function snapshotElementRow(element: Element): SnapshotRow {
  const fields: Record<string, string> = {};
  for (const attribute of element.getAttributeNames()) {
    const match = attribute.match(/^data-(.+)-(id|slug)$/i);
    if (!match) continue;
    const value = element.getAttribute(attribute);
    if (value) fields[normalizeParameterName(`${match[1]}_${match[2]}`)] = value;
  }
  const title = firstUsefulTitle(element);
  if (title) fields.title = title;

  const link = element.querySelector<HTMLAnchorElement>("a[href]");
  if (link?.href) fields.href = link.href;

  const semanticFields = element.querySelectorAll(
    "[data-field], [itemprop], [class*='price'], [class*='cost'], [class*='rating'], [class*='status'], [class*='availability'], [class*='stock'], [class*='author'], time",
  );
  for (const fieldElement of semanticFields) {
    const key = fieldElement.tagName === "TIME" ? "date" : fieldNameFromElement(fieldElement);
    if (!key || fields[key]) continue;
    const value = sanitizePageText(
      fieldElement.getAttribute("datetime") ?? fieldElement.textContent,
      180,
    );
    if (value) fields[key] = value;
    if (Object.keys(fields).length >= 8) break;
  }

  const text = visibleText(element, 500);
  if (!fields.title && text) fields.title = text.slice(0, 180);
  return { fields, text };
}

function itemSelector(parentSelector: string, items: Element[]): string {
  const first = items[0];
  if (!first) return `${parentSelector} > *`;
  const tag = first.tagName.toLowerCase();
  const classes = [...first.classList]
    .filter((token) => items.every((item) => item.classList.contains(token)))
    .filter((token) => /^[a-zA-Z_-][\w-]*$/.test(token))
    .slice(0, 2);
  const segment = classes.length ? `${tag}.${classes.join(".")}` : tag;
  return `${parentSelector} > ${segment}`;
}

function snapshotCollections(root: ParentNode): CollectionSnapshot[] {
  return collectionCandidates(root).map(({ parent, items, inferredFromClasses }) => {
    const parentSelector = createSelector(parent);
    const label = findSectionLabel(parent, items[0]?.tagName.toLowerCase() ?? "items");
    const selector = parentSelector.selector;
    return {
      id: stableId("collection", selector),
      label,
      selector,
      itemSelector: itemSelector(selector, items),
      count: items.length,
      rows: items.slice(0, MAX_SNAPSHOT_ROWS).map(snapshotElementRow),
      selectorStable: parentSelector.stable,
      inferredFromClasses,
    };
  });
}

function uniqueColumnKey(label: string, used: Set<string>, index: number): string {
  const base = normalizeParameterName(label, `column_${index + 1}`);
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    const tail = `_${suffix}`;
    key = `${base.slice(0, 30 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

function tableColumns(table: HTMLTableElement): {
  columns: TableColumnSnapshot[];
  headerRow: HTMLTableRowElement | null;
} {
  const rows = [...table.rows];
  const headerRow = rows.find((row) => row.querySelector("th")) ?? null;
  if (!headerRow) return { columns: [], headerRow: null };
  const cells = [...headerRow.cells];
  const used = new Set<string>();
  const columns = cells.map((cell, index) => {
    const label = sanitizePageText(cell.textContent, 80) || `Column ${index + 1}`;
    return { key: uniqueColumnKey(label, used, index), label, index };
  });
  return { columns, headerRow };
}

function snapshotTableRows(
  table: HTMLTableElement,
  columns: TableColumnSnapshot[],
  headerRow: HTMLTableRowElement,
): SnapshotRow[] {
  return [...table.rows]
    .filter((row) => row !== headerRow)
    .filter((row) => row.cells.length > 0)
    .slice(0, MAX_SNAPSHOT_ROWS)
    .map((row) => {
      const fields: Record<string, string> = {};
      for (const column of columns) {
        const cell = row.cells[column.index];
        fields[column.key] = sanitizePageText(cell?.textContent, 300);
      }
      return { fields, text: Object.values(fields).filter(Boolean).join(" · ") };
    });
}

function snapshotTables(root: ParentNode): TableSnapshot[] {
  const tables: TableSnapshot[] = [];
  for (const element of root.querySelectorAll("table")) {
    if (!isElementVisible(element)) continue;
    const table = element as HTMLTableElement;
    const { columns, headerRow } = tableColumns(table);
    if (!headerRow || columns.length === 0) continue;
    const selectorInfo = createSelector(element);
    const label = findSectionLabel(element, "table");
    tables.push({
      id: stableId("table", selectorInfo.selector),
      label,
      selector: selectorInfo.selector,
      columns,
      rows: snapshotTableRows(table, columns, headerRow),
      selectorStable: selectorInfo.stable,
    });
  }
  return tables.slice(0, 8);
}

function isSearchInput(input: HTMLInputElement): boolean {
  if (input.type === "search" || input.getAttribute("role") === "searchbox") return true;
  const signal = [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("aria-label") ?? "",
  ].join(" ");
  return SEARCH_TERM.test(signal);
}

function searchLabel(form: HTMLFormElement, input: HTMLInputElement): string {
  const formLabel = form.getAttribute("aria-label") ?? "";
  const inputLabel = getAccessibleName(input);
  const heading = findSectionLabel(form, "");
  return sanitizePageText(formLabel || inputLabel || heading || "site search", 80);
}

function searchVerb(form: HTMLFormElement): "search" | "filter" {
  const submitText = sanitizePageText(
    form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')?.textContent,
    50,
  );
  return /^filter\b/i.test(submitText) ? "filter" : "search";
}

function finiteNumber(value: string): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function searchFields(form: HTMLFormElement): SearchFormFieldSnapshot[] {
  const used = new Set<string>();
  const fields: SearchFormFieldSnapshot[] = [];
  const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select");
  for (const control of controls) {
    if (control.tagName === "INPUT") {
      if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(control.type)) {
        continue;
      }
    }
    const rawKey = control.getAttribute("name") || control.id;
    if (!rawKey) continue;
    let key = normalizeParameterName(rawKey);
    let suffix = 2;
    while (used.has(key)) {
      const tail = `_${suffix}`;
      key = `${normalizeParameterName(rawKey).slice(0, 30 - tail.length)}${tail}`;
      suffix += 1;
    }
    used.add(key);
    const isSelect = control.tagName === "SELECT";
    const inputType = isSelect ? "select" : (control as HTMLInputElement).type;
    const field: SearchFormFieldSnapshot = {
      key,
      label: getAccessibleName(control) || key.replace(/_/g, " "),
      selector: createSelector(control).selector,
      control:
        inputType === "checkbox"
          ? "checkbox"
          : inputType === "number"
            ? "number"
            : isSelect
              ? "select"
              : "text",
      required: control.hasAttribute("required"),
    };
    if (isSelect) {
      field.enum = [...(control as HTMLSelectElement).options].map((option) => option.value);
    }
    if (inputType === "number") {
      field.minimum = finiteNumber((control as HTMLInputElement).min);
      field.maximum = finiteNumber((control as HTMLInputElement).max);
    }
    fields.push(field);
  }
  return fields;
}

function snapshotSearchForms(root: ParentNode): SearchFormSnapshot[] {
  const forms: SearchFormSnapshot[] = [];
  for (const element of root.querySelectorAll("form")) {
    if (!isElementVisible(element)) continue;
    const form = element as HTMLFormElement;
    const inputs = [...form.querySelectorAll<HTMLInputElement>("input")];
    const input = inputs.find(isSearchInput);
    if (!input || input.disabled) continue;
    const selectorInfo = createSelector(form);
    const inputSelectorInfo = createSelector(input);
    const label = searchLabel(form, input);
    forms.push({
      id: stableId("search", selectorInfo.selector, inputSelectorInfo.selector),
      label,
      selector: selectorInfo.selector,
      inputSelector: inputSelectorInfo.selector,
      inputName: input.name || "query",
      accessibleName: getAccessibleName(input),
      selectorStable: selectorInfo.stable && inputSelectorInfo.stable,
      verb: searchVerb(form),
      fields: searchFields(form),
    });
  }
  return forms.slice(0, 6);
}

function isExplicitLocalAction(form: HTMLFormElement): boolean {
  if (form.getAttribute("data-graft-tool") === "add_to_demo_cart") return true;
  const intent = form.querySelector<HTMLInputElement>('input[name="intent"]')?.value;
  const scope = form.querySelector<HTMLInputElement>('input[name="scope"]')?.value;
  return intent === "add-to-demo-cart" && scope === "local-fixture";
}

function snapshotLocalActions(root: ParentNode): LocalActionSnapshot[] {
  const actions: LocalActionSnapshot[] = [];
  for (const element of root.querySelectorAll("form")) {
    const form = element as HTMLFormElement;
    if (!isExplicitLocalAction(form)) continue;
    const product = form.querySelector<HTMLSelectElement>('select[name="product_id"]');
    const quantity = form.querySelector<HTMLInputElement>('input[name="quantity"][type="number"]');
    const output = form.querySelector<HTMLOutputElement>("output[name='cart_status'], output");
    if (!product || !quantity || !output) continue;
    const allowedProductIds = [...product.options]
      .map((option) => option.value)
      .filter(Boolean)
      .slice(0, 50);
    if (allowedProductIds.length === 0) continue;
    const formSelector = createSelector(form).selector;
    actions.push({
      id: stableId("local-action", formSelector),
      label: findSectionLabel(form, "demo cart"),
      selector: formSelector,
      toolName: form.getAttribute("data-graft-tool") || "add_to_demo_cart",
      productSelector: createSelector(product).selector,
      quantitySelector: createSelector(quantity).selector,
      outputSelector: createSelector(output).selector,
      allowedProductIds,
    });
  }
  return actions.slice(0, 2);
}

function snapshotHeadings(root: ParentNode): PageSnapshot["headings"] {
  return [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")]
    .filter(isElementVisible)
    .map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: sanitizePageText(heading.textContent, 180),
      selector: createSelector(heading).selector,
    }))
    .filter((heading) => heading.text)
    .slice(0, 80);
}

export function deriveSnapshot(root: ParentNode = document): PageSnapshot {
  const ownerDocument = root.nodeType === 9 ? (root as Document) : root.ownerDocument ?? document;
  const title = sanitizePageText(ownerDocument.title || "Untitled page", 180);
  const description = sanitizePageText(
    ownerDocument.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
    300,
  );
  const main =
    root.querySelector("main, [role='main'], article") ??
    ownerDocument.body ??
    ownerDocument.documentElement;

  return {
    title,
    url: ownerDocument.location?.href ?? "",
    description,
    mainText: main ? visibleText(main, 3_000) : "",
    headings: snapshotHeadings(root),
    collections: snapshotCollections(root),
    tables: snapshotTables(root),
    searchForms: snapshotSearchForms(root),
    localActions: snapshotLocalActions(root),
  };
}

export function collectionNoun(collection: CollectionSnapshot): string {
  const keys = Object.keys(collection.rows[0]?.fields ?? {});
  const stableKey = keys.find((key) => /_(?:id|slug)$/.test(key));
  if (stableKey) return pluralize(stableKey.replace(/_(?:id|slug)$/, ""));
  if (keys.includes("price") || keys.includes("availability")) return "products";
  return nounFromLabel(collection.label, "items");
}

export function tableNoun(table: TableSnapshot): string {
  const idColumn = table.columns.find((column) => /_id$/.test(column.key));
  if (idColumn) return pluralize(idColumn.key.replace(/_id$/, ""));
  return nounFromLabel(table.label, "table");
}

export function searchNoun(form: SearchFormSnapshot): string {
  return nounFromLabel(form.label.replace(/catalogue/gi, "catalog"), "site");
}

export function snapshotFingerprint(snapshot: PageSnapshot): string {
  return stableId(
    snapshot.url,
    snapshot.title,
    snapshot.headings.map((heading) => `${heading.level}:${heading.text}`).join("|"),
    snapshot.collections.map((collection) => `${collection.selector}:${collection.count}`).join("|"),
    snapshot.tables.map((table) => `${table.selector}:${table.rows.length}`).join("|"),
    snapshot.searchForms
      .map((form) => `${form.selector}:${form.fields.map((field) => field.key).join(",")}`)
      .join("|"),
    snapshot.localActions.map((action) => action.selector).join("|"),
  );
}

export function rowText(row: SnapshotRow): string {
  const fields = Object.entries(row.fields)
    .filter(([, value]) => normalizeWhitespace(value))
    .map(([key, value]) => `${key}: ${normalizeWhitespace(value)}`);
  return fields.join(" | ") || row.text;
}
