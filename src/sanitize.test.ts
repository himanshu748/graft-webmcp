// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { sanitizeFixtureHtml, serializeSanitizedDocument } from "./sanitize";

describe("sanitizeFixtureHtml", () => {
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
    </body></html>`;

    const { document: documentNode } = sanitizeFixtureHtml(source);
    const form = documentNode.querySelector("form");
    expect(form?.dataset.graftTool).toBe("add_to_demo_cart");
    expect(form?.dataset.graftOwned).toBe("true");
    expect(form?.querySelector("select[name='product_id']")).not.toBeNull();
    expect(form?.querySelector("input[name='quantity']")?.getAttribute("max")).toBe("3");
    expect(form?.querySelector("output[data-graft-cart-output]")).not.toBeNull();
  });
});
