const INSTRUCTION_SHAPED_TEXT = [
  /ignore\s+(?:all\s+)?previous/gi,
  /ignore\s+(?:the\s+)?above/gi,
  /(?:system|assistant|developer)\s*:/gi,
  /you\s+(?:must|should|need\s+to)/gi,
  /follow\s+(?:these|my)\s+instructions/gi,
  /disregard\s+(?:all\s+)?(?:prior|previous)/gi,
];

const GENERIC_WORDS = new Set([
  "all",
  "content",
  "container",
  "grid",
  "items",
  "list",
  "main",
  "results",
  "section",
  "wrapper",
]);

export interface SelectorInfo {
  selector: string;
  stable: boolean;
  positional: boolean;
}

export function normalizeWhitespace(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizePageText(value: unknown, maxLength = 120): string {
  let text = normalizeWhitespace(value);
  for (const pattern of INSTRUCTION_SHAPED_TEXT) {
    text = text.replace(pattern, "[removed]");
  }
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  text = normalizeWhitespace(text);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function normalizeToolName(value: string, fallback = "page_tool"): string {
  const normalized = normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const withLetter = /^[a-z]/.test(normalized) ? normalized : `tool_${normalized}`;
  const clipped = withLetter.slice(0, 30).replace(/_+$/g, "");
  return clipped || fallback;
}

export function normalizeParameterName(value: string, fallback = "value"): string {
  return normalizeToolName(value, fallback).slice(0, 30);
}

export function stableId(...parts: string[]): string {
  const input = parts.join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `g_${(hash >>> 0).toString(36)}`;
}

export function cssEscape(value: string): string {
  const nativeEscape = globalThis.CSS?.escape;
  if (nativeEscape) return nativeEscape(value);
  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, leadingDigit: string) => {
    if (leadingDigit) return `\\3${leadingDigit} `;
    return `\\${match}`;
  });
}

export function cssAttributeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function getOwnerDocument(node: Node | ParentNode): Document {
  if (node.nodeType === 9) return node as Document;
  return node.ownerDocument ?? document;
}

function queryCount(root: ParentNode, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function selectorRoot(element: Element): ParentNode {
  return getOwnerDocument(element);
}

function stableAttributeSelector(element: Element): string | null {
  const root = selectorRoot(element);
  const tag = element.tagName.toLowerCase();
  if (element.id) {
    const selector = `#${cssEscape(element.id)}`;
    if (queryCount(root, selector) === 1) return selector;
  }

  for (const attribute of ["data-testid", "data-test", "data-qa", "name"]) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const selector = `${tag}[${attribute}="${cssAttributeEscape(value)}"]`;
    if (queryCount(root, selector) === 1) return selector;
  }

  const role = element.getAttribute("role");
  const ariaLabel = element.getAttribute("aria-label");
  if (role && ariaLabel) {
    const selector = `${tag}[role="${cssAttributeEscape(role)}"][aria-label="${cssAttributeEscape(ariaLabel)}"]`;
    if (queryCount(root, selector) === 1) return selector;
  }

  return null;
}

function semanticSegment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const usableClasses = [...element.classList]
    .filter((token) => /^[a-zA-Z_-][\w-]*$/.test(token))
    .filter((token) => !/^(active|current|selected|open|closed|hover|focus|js-)/i.test(token))
    .slice(0, 2);
  if (usableClasses.length) return `${tag}.${usableClasses.map(cssEscape).join(".")}`;
  const role = element.getAttribute("role");
  if (role) return `${tag}[role="${cssAttributeEscape(role)}"]`;
  return tag;
}

export function createSelector(element: Element): SelectorInfo {
  const direct = stableAttributeSelector(element);
  if (direct) return { selector: direct, stable: true, positional: false };

  const documentRoot = selectorRoot(element);
  const semantic = semanticSegment(element);
  if (queryCount(documentRoot, semantic) === 1) {
    return { selector: semantic, stable: true, positional: false };
  }

  const segments: string[] = [];
  let cursor: Element | null = element;
  let positional = false;
  while (cursor && cursor.tagName.toLowerCase() !== "html") {
    const stable = stableAttributeSelector(cursor);
    if (stable) {
      segments.unshift(stable);
      const selector = segments.join(" > ");
      return { selector, stable: !positional, positional };
    }

    let segment = semanticSegment(cursor);
    const parent: Element | null = cursor.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter(
        (candidate) => semanticSegment(candidate) === segment,
      );
      if (siblings.length > 1) {
        const sameTag = [...parent.children].filter(
          (candidate) => candidate.tagName === cursor?.tagName,
        );
        segment = `${segment}:nth-of-type(${sameTag.indexOf(cursor) + 1})`;
        positional = true;
      }
    }
    segments.unshift(segment);
    const selector = segments.join(" > ");
    if (queryCount(documentRoot, selector) === 1) {
      return { selector, stable: !positional, positional };
    }
    cursor = parent;
  }

  return {
    selector: segments.join(" > ") || element.tagName.toLowerCase(),
    stable: false,
    positional: true,
  };
}

export function getAccessibleName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return sanitizePageText(ariaLabel);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const root = getOwnerDocument(element);
    const label = labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById(id)?.textContent)
      .filter(Boolean)
      .join(" ");
    if (label) return sanitizePageText(label);
  }

  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
    const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const labels = [...(control.labels ?? [])]
      .map((label) => label.textContent)
      .filter(Boolean)
      .join(" ");
    if (labels) return sanitizePageText(labels);
    const placeholder = control.getAttribute("placeholder");
    if (placeholder) return sanitizePageText(placeholder);
  }

  const title = element.getAttribute("title");
  if (title) return sanitizePageText(title);
  return sanitizePageText(element.textContent, 100);
}

export type SectionLabelSource = "semantic" | "classes" | "fallback";

export interface SectionLabel {
  label: string;
  source: SectionLabelSource;
}

/**
 * A label lifted from a class attribute is not an accessible name, and the
 * difference decides whether a derived tool is trustworthy. Callers need the
 * provenance, not just the string.
 */
export function describeSectionLabel(element: Element, fallback: string): SectionLabel {
  const semantic = (label: string): SectionLabel => ({ label, source: "semantic" });
  const explicit = getAccessibleName(element);
  if (element.hasAttribute("aria-label") && explicit) return semantic(explicit);

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy && explicit) return semantic(explicit);

  const caption = element.querySelector(":scope > caption");
  if (caption?.textContent) return semantic(sanitizePageText(caption.textContent));

  const ownHeading = element.querySelector(":scope > h1, :scope > h2, :scope > h3");
  if (ownHeading?.textContent) return semantic(sanitizePageText(ownHeading.textContent));

  let previous = element.previousElementSibling;
  while (previous) {
    if (/^H[1-6]$/.test(previous.tagName) && previous.textContent) {
      return semantic(sanitizePageText(previous.textContent));
    }
    if (previous.matches("section, article, main, nav, table, ul, ol")) break;
    previous = previous.previousElementSibling;
  }

  const classTokens = [...element.classList]
    .flatMap((token) => token.split(/[-_]/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2 && !GENERIC_WORDS.has(token));
  if (classTokens.length) {
    return { label: sanitizePageText(classTokens.join(" ")), source: "classes" };
  }
  return { label: fallback, source: "fallback" };
}

export function findSectionLabel(element: Element, fallback: string): string {
  return describeSectionLabel(element, fallback).label;
}

/**
 * Words that only describe markup or layout. A tool named after one of these
 * tells an agent nothing, so the noun is rejected rather than shipped.
 */
const STRUCTURAL_NOUNS = new Set([
  "li", "lis", "ul", "ol", "div", "divs", "span", "spans", "col", "cols", "row", "rows",
  "cell", "cells", "gap", "gaps", "center", "centers", "inner", "inners", "outer", "outers",
  "wrapper", "wrappers", "container", "containers", "box", "boxes", "block", "blocks",
  "grid", "grids", "flex", "item", "items", "content", "contents", "element", "elements",
  "menu", "menus", "nav", "navs", "navbar", "navbars", "toc", "tocs", "popover", "popovers",
  "dropdown", "dropdowns", "carousel", "carousels", "breadcrumb", "breadcrumbs",
  "sidebar", "sidebars", "footer", "footers", "header", "headers", "widget", "widgets",
  "vector", "vectors", "panel", "panels", "wrap", "wraps", "inline", "small", "large",
  "navbox", "navboxes", "wikitable", "wikitables", "infobox", "infoboxes", "table", "tables",
  "mobile", "desktop", "hidden", "visible", "primary", "secondary", "main", "mains",
]);

export function isStructuralNoun(noun: string): boolean {
  const tokens = noun.split("_").filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => STRUCTURAL_NOUNS.has(token) || /^\d+$/.test(token));
}

/** Words whose plural and singular are the same, so naive trimming mangles them. */
const UNCOUNTABLE = new Set([
  "news", "series", "species", "data", "media", "analysis", "status", "bus",
  "campus", "atlas", "index", "press", "class", "process", "access", "focus",
]);

export function singularize(value: string): string {
  const tail = value.split("_").pop() ?? value;
  if (UNCOUNTABLE.has(tail.toLowerCase())) return value;
  if (/ies$/i.test(value)) return value.replace(/ies$/i, "y");
  if (/(sses|shes|ches|xes|zes)$/i.test(value)) return value.replace(/es$/i, "");
  if (/s$/i.test(value) && !/ss$/i.test(value)) return value.slice(0, -1);
  return value;
}

export function pluralize(value: string): string {
  const tail = value.split("_").pop() ?? value;
  if (UNCOUNTABLE.has(tail.toLowerCase())) return value;
  if (/s$/i.test(value)) return value;
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
}

export function nounFromLabel(label: string, fallback: string): string {
  const cleaned = sanitizePageText(label, 70)
    .toLowerCase()
    .replace(/\b(search|find|browse|view|show|all|our|the|a|an|for|by)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  return tokens.slice(-2).join("_") || fallback;
}

export function visibleText(element: Element, maxLength = 500): string {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "script, style, template, noscript, svg, [hidden], [aria-hidden='true'], [data-graft-ignore]",
    )
    .forEach((node) => node.remove());
  return sanitizePageText(clone.textContent, maxLength);
}

export function isElementVisible(element: Element): boolean {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
  const view = getOwnerDocument(element).defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export function resolveUniqueElement(
  root: ParentNode,
  primary: string,
  fallbacks: string[] = [],
): Element | null {
  for (const selector of [primary, ...fallbacks]) {
    if (!selector) continue;
    let matches: Element[];
    try {
      matches = [...root.querySelectorAll(selector)];
    } catch {
      continue;
    }
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

export function abortError(message = "Operation cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return normalizeWhitespace(error) || "Unknown error";
}
