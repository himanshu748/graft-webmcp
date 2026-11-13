// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { sanitizeFixtureHtml, serializeSanitizedDocument } from "./sanitize";

describe("sanitizeFixtureHtml", () => {
  it("keeps adversarial markup inert across reproducible nested-HTML mutations", () => {
    // Fixed-seed cases make a failed security invariant repeatable in CI.
    let seed = 0x5a17e11;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const tags = ["a", "img", "form", "div", "svg", "math", "noscript"];
    const attributes = [
      "href", "src", "srcset", "action", "formaction", "poster", "background",
      "xlink:href", "onclick", "onerror", "style",
    ];
    const destinations = [
      "javascript:alert(1)",
      "data:text/html,<svg onload=alert(1)>",
      "https://attacker.example/pixel?x=1&y=2",
      "//attacker.example/track",
      "#safe-section",
      "https://attacker.example/a%22onload%3Dalert(1)",
    ];
    const networkAttributes = new Set([
      "action", "background", "cite", "formaction", "href", "longdesc",
      "ping", "poster", "src", "srcdoc", "srcset",
    ]);

    for (let attempt = 0; attempt < 256; attempt += 1) {
      const tag = tags[next() % tags.length];
      const attribute = attributes[next() % attributes.length];
      const destination = destinations[next() % destinations.length];
      const value = attribute === "style"
        ? `background: url('${destination}')`
        : destination;
      const source = `<!doctype html><html><head>
        <style>@import "https://attacker.example/import.css";
          .remote { background: url(https://attacker.example/bg.png) }
        </style></head><body>
        <${tag} ${attribute}="${value.replaceAll('"', "&quot;")}" onmouseover="alert(1)">
          <svg><script>alert(1)</script><a xlink:href="javascript:alert(1)">X</a></svg>
          <math><mtext><img src="https://attacker.example/math.png"></mtext></math>
        </${tag}>
        <meta http-equiv="refresh" content="0;url=https://attacker.example">
        <iframe srcdoc="<script>alert(1)</script>"></iframe>
        </body></html>`;

      const result = sanitizeFixtureHtml(source, "https://owned.example/");
      const doc = result.document;
      expect(doc.querySelector("script, iframe, frame, object, embed, portal, base, link")).toBeNull();
      expect(doc.querySelector('meta[http-equiv]:not([http-equiv="Content-Security-Policy"])')).toBeNull();

      for (const element of doc.querySelectorAll("*")) {
        for (const attr of element.attributes) {
          const name = attr.name.toLowerCase();
          expect(name.startsWith("on"), `case ${attempt}: event attribute ${name}`).toBe(false);
          if (name === "href") {
            expect(attr.value, `case ${attempt}: navigable href`).toMatch(/^#[A-Za-z][\w:.-]*$/);
          } else {
            expect(networkAttributes.has(name) || name.endsWith(":href"),
              `case ${attempt}: network attribute ${name}`).toBe(false);
          }
        }
      }

      const css = [
        ...[...doc.querySelectorAll("style")].map((style) => style.textContent ?? ""),
        ...[...doc.querySelectorAll("[style]")].map((element) => element.getAttribute("style") ?? ""),
      ].join("\n");
      expect(css, `case ${attempt}: network CSS`).not.toMatch(/@import|url\s*\(/i);
    }
  });

  it("removes active content and blocks network-capable references", () => {
    const unsafe = `<!doctype html>
      <html>
        <head>
          <meta http-equiv="refresh" content="0;url=https://evil.test">
          <link rel="stylesheet" href="https://evil.test/site.css">
          <style>
            @import "https://evil.test/import.css";
            .remote { background-image: url(https://evil.test/pixel.png); }
          </style>
        </head>
        <body onload="steal()">
          <script>steal()</script>
          <iframe src="https://evil.test/frame"></iframe>
          <object data="https://evil.test/object"></object>
          <img src="https://evil.test/image.png" onerror="steal()">
          <a href="https://evil.test/path" ping="https://evil.test/ping">External</a>
          <a href="#safe-section">Safe fragment</a>
          <div style="background:url('https://evil.test/style.png')">Styled</div>
          <form action="https://evil.test/submit" method="post">
            <input name="query" value="safe">
          </form>
        </body>
      </html>`;

    const sanitized = sanitizeFixtureHtml(unsafe);
    const output = serializeSanitizedDocument(sanitized.document);

    expect(sanitized.document.querySelector("script, iframe, object, link")).toBeNull();
    expect(sanitized.document.body.hasAttribute("onload")).toBe(false);
    expect(sanitized.document.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(sanitized.document.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(sanitized.document.querySelectorAll("a")[1]?.getAttribute("href")).toBe(
      "#safe-section",
    );
    expect(sanitized.document.querySelector("form")?.hasAttribute("action")).toBe(false);
    expect(sanitized.document.querySelector("form")?.dataset.graftInert).toBe("true");
    expect(output).not.toContain("evil.test");
    expect(output).not.toMatch(/@import|url\s*\(/i);
    expect(
      sanitized.document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    ).not.toBeNull();
    expect(sanitized.removedNodes).toBeGreaterThanOrEqual(4);
    expect(sanitized.removedAttributes).toBeGreaterThanOrEqual(6);
    expect(sanitized.neutralizedCssReferences).toBe(3);
  });

  it("keeps semantic controls and explicit owned-fixture markers", () => {
    const source = `<!doctype html><html><head><title>Owned</title></head><body>
      <form data-graft-tool="add_to_demo_cart" data-graft-owned="true">
        <label>Product <select name="product_id"><option value="p-1">One</option></select></label>
        <label>Quantity <input name="quantity" type="number" min="1" max="3"></label>
        <output data-graft-cart-output>Empty</output>
      </form>
      <section id="search" data-graft-section="capability">
        <h2>Search</h2>
        <p data-field="summary">Find local files.</p>
      </section>
      <aside data-graft-ignore>Compiler-only noise</aside>
    </body></html>`;

    const { document: documentNode } = sanitizeFixtureHtml(source);
    const form = documentNode.querySelector("form");
    expect(form?.dataset.graftTool).toBe("add_to_demo_cart");
    expect(form?.dataset.graftOwned).toBe("true");
    expect(form?.querySelector("select[name='product_id']")).not.toBeNull();
    expect(form?.querySelector("input[name='quantity']")?.getAttribute("max")).toBe("3");
    expect(form?.querySelector("output[data-graft-cart-output]")).not.toBeNull();
    expect(documentNode.querySelector("#search")?.getAttribute("data-graft-section")).toBe(
      "capability",
    );
    expect(documentNode.querySelector("#search [data-field='summary']")).not.toBeNull();
    expect(documentNode.querySelector("[data-graft-ignore]")).not.toBeNull();
  });
});
