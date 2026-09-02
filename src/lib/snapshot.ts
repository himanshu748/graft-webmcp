import {
  createSelector,
  describeSectionLabel,
  findSemanticSectionFields,
  isStructuralNoun,
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
  ActionCandidateSnapshot,
  CollectionSnapshot,
  LocalActionSnapshot,
  PageSnapshot,
  SearchFormSnapshot,
  SearchFormFieldSnapshot,
  SectionGroupSnapshot,
  SnapshotRow,
  TableColumnSnapshot,
  TableSnapshot,
} from "./types";

const MAX_SNAPSHOT_ROWS = 100;
const SEARCH_TERM = /(?:^|[-_\s])(search|query|keyword|lookup|find|q)(?:$|[-_\s])/i;
const FIELD_TERM = /(price|cost|rating|status|availability|stock|author|date|time|category|tag|location)/i;
const GRAFT_SECTION_SELECTOR = "[data-graft-section]";
const SAFE_SECTION_NOUN = /^[a-z][a-z0-9_-]{0,30}$/;
const SAFE_SECTION_ID = /^[A-Za-z][\w:.-]{0,79}$/;
const MAX_GRAFT_SECTION_MARKERS = 150;
const MAX_GRAFT_SECTION_PARENTS = 24;
const MAX_GRAFT_SECTION_GROUPS = 6;
const MAX_SECTION_TEXT_NODES = 800;
const MAX_VISIBILITY_ANCESTOR_STEPS = 100;

interface CollectionCandidate {
  chrome: boolean;
  parent: Element;
  items: Element[];
  inferredFromClasses: boolean;
}

function elementChildren(element: Element): Element[] {
  return [...element.children].filter(
    (child) => !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(child.tagName),
  );
}

function isGraftIgnored(element: Element): boolean {
  let current: Element | null = element;
  for (let steps = 0; current && steps < MAX_VISIBILITY_ANCESTOR_STEPS; steps += 1) {
    if (current.hasAttribute("data-graft-ignore")) return true;
    current = current.parentElement;
  }
  return current !== null;
}

function isInsideDeclaredSection(element: Element): boolean {
  return Boolean(element.closest(GRAFT_SECTION_SELECTOR));
}

function visibleDescendantText(element: Element, maxLength: number): string {
  const parts: string[] = [];
  const stack: Node[] = [element];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_SECTION_TEXT_NODES) {
    const node = stack.pop();
    if (!node) continue;
    visited += 1;
    if (node !== element && node.nextSibling) stack.push(node.nextSibling);

    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (
      !isElementVisible(child) ||
      child.hasAttribute("data-graft-ignore") ||
      ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "SVG"].includes(child.tagName)
    ) {
      continue;
    }

    if (child.firstChild) stack.push(child.firstChild);
  }

  return sanitizePageText(parts.join(" "), maxLength);
}

function snapshotSectionGroups(root: ParentNode): SectionGroupSnapshot[] {
  const ownerDocument = root.nodeType === 9 ? (root as Document) : root.ownerDocument ?? document;
  const grouped = new Map<Element, Map<string, Element[]>>();
  const idCounts = new Map<string, number>();
  for (const candidate of ownerDocument.querySelectorAll("[id]")) {
    const id = candidate.getAttribute("id") ?? "";
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  let scannedMarkers = 0;
  for (const section of root.querySelectorAll(GRAFT_SECTION_SELECTOR)) {
    if (scannedMarkers >= MAX_GRAFT_SECTION_MARKERS) break;
    scannedMarkers += 1;
    if (!section.matches("section, article, [role='region']")) continue;
    if (!isElementVisible(section) || isGraftIgnored(section)) continue;
    const noun = section.getAttribute("data-graft-section")?.trim() ?? "";
    const parent = section.parentElement;
    if (!parent || !SAFE_SECTION_NOUN.test(noun)) continue;
    if (!grouped.has(parent) && grouped.size >= MAX_GRAFT_SECTION_PARENTS) continue;
    const byNoun = grouped.get(parent) ?? new Map<string, Element[]>();
    const items = byNoun.get(noun) ?? [];
    items.push(section);
    byNoun.set(noun, items);
    grouped.set(parent, byNoun);
  }

  const groups: SectionGroupSnapshot[] = [];
  groupsLoop: for (const [parent, byNoun] of grouped) {
    const parentSelector = createSelector(parent);
    if (!parentSelector.stable) continue;
    for (const [noun, sections] of byNoun) {
      if (groups.length >= MAX_GRAFT_SECTION_GROUPS) break groupsLoop;
      if (sections.length < 2 || sections.length > 25) continue;
      const items = sections.map((section) => {
        const id = section.id;
        const fields = findSemanticSectionFields(section);
        const title = fields.heading ? visibleDescendantText(fields.heading, 180) : "";
        const summary = fields.summary ? visibleDescendantText(fields.summary, 400) : "";
        if (!SAFE_SECTION_ID.test(id) || !title || !summary || idCounts.get(id) !== 1) return null;
        return { id, title, summary };
      });
      if (items.some((item) => item === null)) continue;
      groups.push({
        id: stableId("section-group", parentSelector.selector, noun),
        noun,
        selector: parentSelector.selector,
        sections: items as SectionGroupSnapshot["sections"],
      });
    }
  }

  return groups;
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
  const children = elementChildren(parent).filter(
    (child) =>
      isElementVisible(child) &&
      !isGraftIgnored(child) &&
      !child.hasAttribute("data-graft-section"),
  );
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

/**
 * Site chrome repeats just like content does, so a naive repeated-structure
 * scan turns every nav bar and table of contents into a "content" tool.
 */
const CHROME_SELECTOR = [
  "nav",
  "header",
  "footer",
  "aside",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='menu']",
  "[role='menubar']",
  "[role='tablist']",
  "[class*='breadcrumb']",
  "[class*='pagination']",
  "[id='toc']",
  "[class*='toc-']",
  "[class*='navbox']",
].join(", ");

const CONTENT_SELECTOR = "main, [role='main'], article, #content, #mw-content-text";

function isChrome(element: Element): boolean {
  const chrome = element.closest(CHROME_SELECTOR);
  if (!chrome) return false;
  const content = element.closest(CONTENT_SELECTOR);
  // An outer chrome wrapper must not disqualify the article it contains, but a
  // nav that sits inside the article is still chrome.
  if (!content) return true;
  return content.contains(chrome) && chrome !== content;
}

function collectionCandidates(root: ParentNode): CollectionCandidate[] {
  const candidates: CollectionCandidate[] = [];
  const claimed = new Set<Element>();

  for (const list of root.querySelectorAll("ul, ol, [role='list']")) {
    if (
      !isElementVisible(list) ||
      isGraftIgnored(list) ||
      isInsideDeclaredSection(list)
    ) {
      continue;
    }
    const items = elementChildren(list).filter(
      (child) => child.matches("li, [role='listitem']") && isElementVisible(child),
    );
    if (items.length < 3) continue;
    candidates.push({ parent: list, items, inferredFromClasses: false, chrome: isChrome(list) });
    items.forEach((item) => claimed.add(item));
  }

  const genericParents = root.querySelectorAll(
    "main, section, article, div, [role='main'], [role='region'], [role='feed']",
  );
  for (const parent of genericParents) {
    if (
      !isElementVisible(parent) ||
      isGraftIgnored(parent) ||
      parent.closest("table") ||
      isInsideDeclaredSection(parent)
    ) {
      continue;
    }
    const items = repeatedChildren(parent);
    if (items.length < 3) continue;
    if (items.every((item) => claimed.has(item))) continue;
    if (candidates.some((candidate) => candidate.items.includes(parent))) {
      continue;
    }
    candidates.push({ parent, items, inferredFromClasses: true, chrome: isChrome(parent) });
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
    if (isGraftIgnored(fieldElement)) continue;
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
  return collectionCandidates(root).map(({ parent, items, inferredFromClasses, chrome }) => {
    const parentSelector = createSelector(parent);
    const described = describeSectionLabel(
      parent,
      items[0]?.tagName.toLowerCase() ?? "items",
    );
    const selector = parentSelector.selector;
    return {
      id: stableId("collection", selector),
      label: described.label,
      chrome,
      labelSource: described.source,
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
    if (!isElementVisible(element) || isGraftIgnored(element) || isChrome(element)) continue;
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
      name: control.getAttribute("name") || rawKey,
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
    if (!isElementVisible(element) || isGraftIgnored(element)) continue;
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
      liveEndpoint: form.getAttribute("data-graft-action"),
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
    if (isGraftIgnored(form)) continue;
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

const ACTION_VERB =
  /\b(add|buy|order|checkout|subscribe|sign up|join|book|reserve|delete|remove|send|post|submit|save|apply|download|donate|pay)\b/i;

/** Text that tells one repeated control apart from its twenty siblings. */
function distinguishingKey(control: Element): string | null {
  let node: Element | null = control;
  for (let depth = 0; node && depth < 6; depth += 1) {
    const titled = node.querySelector("[title]")?.getAttribute("title");
    if (titled) return sanitizePageText(titled, 90);
    const heading = node.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading?.textContent) return sanitizePageText(heading.textContent, 90);
    node = node.parentElement;
  }
  return null;
}

/**
 * A write control is a real part of the page's surface even though an inert
 * snapshot cannot perform it. Graft proposes the contract and says plainly that
 * the owner still has to bind a handler.
 */
function snapshotActionCandidates(root: ParentNode): ActionCandidateSnapshot[] {
  const groups = new Map<string, { label: string; controls: Element[] }>();

  for (const control of root.querySelectorAll(
    "button, input[type='submit'], input[type='button'], [role='button']",
  )) {
    if (!isElementVisible(control) || isGraftIgnored(control) || isChrome(control)) continue;
    const raw =
      control.getAttribute("value") ??
      getAccessibleName(control) ??
      visibleText(control, 60);
    const label = sanitizePageText(raw, 60);
    if (!label || !ACTION_VERB.test(label)) continue;
    const key = label.toLowerCase();
    const group = groups.get(key) ?? { label, controls: [] };
    group.controls.push(control);
    groups.set(key, group);
  }

  const candidates: ActionCandidateSnapshot[] = [];
  for (const [, group] of groups) {
    const first = group.controls[0];
    if (!first) continue;
    const targets = group.controls
      .map((control) => distinguishingKey(control))
      .filter((value): value is string => Boolean(value));
    const unique = [...new Set(targets)].slice(0, 25);
    candidates.push({
      id: stableId("action", group.label, String(group.controls.length)),
      label: group.label,
      verb: ACTION_VERB.exec(group.label)?.[0]?.toLowerCase() ?? "submit",
      selector: createSelector(first).selector,
      count: group.controls.length,
      targets: group.controls.length > 1 ? unique : [],
    });
  }

  return candidates.sort((a, b) => b.count - a.count).slice(0, 4);
}

function snapshotHeadings(root: ParentNode): PageSnapshot["headings"] {
  return [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")]
    .filter((heading) => isElementVisible(heading) && !isGraftIgnored(heading))
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
    sectionGroups: snapshotSectionGroups(root),
    collections: snapshotCollections(root),
    tables: snapshotTables(root),
    searchForms: snapshotSearchForms(root),
    localActions: snapshotLocalActions(root),
    actionCandidates: snapshotActionCandidates(root),
  };
}

export type CollectionNounSource = "row-key" | "row-fields" | "label" | "fallback";

/**
 * Where a noun came from decides how much it can be trusted. A noun read out of
 * the rows themselves is evidence about content; one read off a class attribute
 * is evidence about markup.
 */
export function collectionNounInfo(collection: CollectionSnapshot): {
  noun: string;
  source: CollectionNounSource;
} {
  const keys = Object.keys(collection.rows[0]?.fields ?? {});
  const stableKey = keys.find((key) => /_(?:id|slug)$/.test(key));
  if (stableKey) {
    return { noun: pluralize(stableKey.replace(/_(?:id|slug)$/, "")), source: "row-key" };
  }
  if (keys.includes("price") || keys.includes("availability")) {
    return { noun: "products", source: "row-fields" };
  }
  const fromLabel = nounFromLabel(collection.label, "items");
  if (isStructuralNoun(fromLabel)) return { noun: "items", source: "fallback" };
  return { noun: fromLabel, source: "label" };
}

export function collectionNoun(collection: CollectionSnapshot): string {
  return collectionNounInfo(collection).noun;
}

export function tableNoun(table: TableSnapshot): string {
  const idColumn = table.columns.find((column) => /_id$/.test(column.key));
  if (idColumn) return pluralize(idColumn.key.replace(/_id$/, ""));
  const fromLabel = nounFromLabel(table.label, "rows");
  return isStructuralNoun(fromLabel) ? "rows" : fromLabel;
}

export function searchNoun(form: SearchFormSnapshot): string {
  return nounFromLabel(form.label.replace(/catalogue/gi, "catalog"), "site");
}

export function snapshotFingerprint(snapshot: PageSnapshot): string {
  return stableId(
    snapshot.url,
    snapshot.title,
    snapshot.headings.map((heading) => `${heading.level}:${heading.text}`).join("|"),
    snapshot.sectionGroups
      .map((group) => `${group.selector}:${group.noun}:${group.sections.map((section) => section.id).join(",")}`)
      .join("|"),
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
