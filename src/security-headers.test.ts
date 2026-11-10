import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Header = { key: string; value: string };
type HeaderRule = { source: string; headers: Header[] };

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  headers: HeaderRule[];
};

describe("Vercel security headers", () => {
  const allPaths = config.headers.find((rule) => rule.source === "/(.*)");
  const headers = new Map(allPaths?.headers.map(({ key, value }) => [key, value]));

  it("applies security headers to the app, static assets, and API paths", () => {
    expect(allPaths).toBeDefined();
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Permissions-Policy")).toContain("microphone=()");
    expect(headers.get("Permissions-Policy")).toContain("geolocation=()");
  });

  it("forbids inline scripts and limits fetches while allowing sandboxed previews", () => {
    const csp = headers.get("Content-Security-Policy") ?? "";
    const directives = new Map(
      csp.split(";").map((part) => {
        const [directive, ...values] = part.trim().split(/\s+/);
        return [directive, values];
      }),
    );

    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("frame-src")).toContain("about:");
    expect(directives.get("style-src")).toContain("'unsafe-inline'");
  });
});
