export interface SanitizedFixture {
  document: Document;
  removedNodes: number;
  removedAttributes: number;
  neutralizedCssReferences: number;
}

const ACTIVE_NODE_SELECTOR = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "base",
  "link",
  "meta[http-equiv]",
].join(", ");

const NETWORK_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "formaction",
  "href",
  "longdesc",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
]);

function neutralizeCss(css: string): {
  css: string;
  removed: number;
} {
  let removed = 0;
  let next = css.replace(/@import\s+(?:url\()?[^;]+;?/gi, () => {
    removed += 1;
    return "";
  });
  next = next.replace(/url\(\s*(['"]?)[^)]*\1\s*\)/gi, () => {
    removed += 1;
    return "none";
  });
  return { css: next, removed };
}

function isSafeFragment(value: string): boolean {
  return /^#[A-Za-z][\w:.-]*$/.test(value.trim());
}

export function sanitizeFixtureHtml(html: string, baseUrl?: string): SanitizedFixture {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  // Read the form targets before the network attributes are stripped. They are
  // kept as inert data so a GET search can be replayed against the live site.
  const formTargets = new Map<Element, { action: string; method: string }>();
  for (const form of documentNode.querySelectorAll("form")) {
    const rawAction = form.getAttribute("action");
    const method = (form.getAttribute("method") || "get").toLowerCase();
    if (method !== "get") continue;
    if (!baseUrl) continue;
    try {
      const resolved = new URL(rawAction ?? "", baseUrl);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") {
        formTargets.set(form, { action: resolved.href, method });
      }
    } catch {
      // An unresolvable action simply means no live replay for that form.
    }
  }
  const activeNodes = [...documentNode.querySelectorAll(ACTIVE_NODE_SELECTOR)];
  activeNodes.forEach((node) => node.remove());

  let removedAttributes = 0;
  let neutralizedCssReferences = 0;

  for (const element of documentNode.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        removedAttributes += 1;
        continue;
      }

      if (name === "style") {
        const neutralized = neutralizeCss(attribute.value);
        neutralizedCssReferences += neutralized.removed;
        if (neutralized.css.trim()) element.setAttribute("style", neutralized.css);
        else element.removeAttribute("style");
        continue;
      }

      const networkCapable =
        NETWORK_ATTRIBUTES.has(name) || name.endsWith(":href");
      if (!networkCapable) continue;
      if (name === "href" && isSafeFragment(attribute.value)) continue;
      element.removeAttribute(attribute.name);
      removedAttributes += 1;
    }
  }

  documentNode.querySelectorAll("style").forEach((style) => {
    const neutralized = neutralizeCss(style.textContent ?? "");
    style.textContent = neutralized.css;
    neutralizedCssReferences += neutralized.removed;
  });

  documentNode.querySelectorAll("form").forEach((form) => {
    const target = formTargets.get(form);
    form.removeAttribute("action");
    form.removeAttribute("method");
    form.setAttribute("data-graft-inert", "true");
    if (target) {
      form.setAttribute("data-graft-action", target.action);
      form.setAttribute("data-graft-method", target.method);
    }
  });

  const csp = documentNode.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'",
  );
  documentNode.head.prepend(csp);
  documentNode.documentElement.setAttribute("data-graft-snapshot", "sanitized");

  return {
    document: documentNode,
    removedNodes: activeNodes.length,
    removedAttributes,
    neutralizedCssReferences,
  };
}

export function serializeSanitizedDocument(documentNode: Document): string {
  return `<!doctype html>${documentNode.documentElement.outerHTML}`;
}
