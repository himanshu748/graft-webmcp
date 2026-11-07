import { describe, expect, it } from "vitest";

import { isAllowedByRobots, robotsVerdict, rulesFor } from "../api/_robots";

const lines = (...rows: string[]) => rows.join("\n");

describe("isAllowedByRobots", () => {
  it.each([
    // The three cases reported in #45.
    ["a longer allow beats a shorter disallow", lines("User-agent: *", "Allow: /public/", "Disallow: /"), "/public/x", true],
    ["consecutive user-agent lines share one group", lines("User-agent: *", "User-agent: otherbot", "Disallow: /"), "/x", false],
    ["* matches any run of characters", lines("User-agent: *", "Disallow: /*.php"), "/a/b.php", false],
    // Longest match, allow on a tie.
    ["a longer disallow beats a shorter allow", lines("User-agent: *", "Allow: /", "Disallow: /private"), "/private/x", false],
    ["allow wins a tie in length", lines("User-agent: *", "Disallow: /page", "Allow: /page"), "/page", true],
    ["rule order does not matter", lines("User-agent: *", "Disallow: /", "Allow: /public/"), "/public/x", true],
    // `$` anchors the end.
    ["$ anchors the end of the path", lines("User-agent: *", "Disallow: /*.php$"), "/a.php", false],
    ["$ does not match a longer path", lines("User-agent: *", "Disallow: /*.php$"), "/a.php5", true],
    ["a literal prefix still matches by prefix", lines("User-agent: *", "Disallow: /tmp"), "/tmp-files/x", false],
    // Query strings take part in matching.
    ["the query string is matched", lines("User-agent: *", "Disallow: /search?q="), "/search?q=cats", false],
    ["a path rule ignores a different query", lines("User-agent: *", "Disallow: /search?q="), "/search?page=2", true],
    // Edge cases.
    ["an empty disallow allows everything", lines("User-agent: *", "Disallow:"), "/anything", true],
    ["no matching group allows everything", lines("User-agent: otherbot", "Disallow: /"), "/x", true],
    ["an empty file allows everything", "", "/x", true],
    ["comments and blank lines are ignored", lines("# hi", "", "User-agent: * # all", "Disallow: /a # no"), "/a", false],
    ["sitemap lines do not end a group", lines("User-agent: *", "Sitemap: https://example.com/s.xml", "Disallow: /a"), "/a", false],
    ["field names are case-insensitive", lines("USER-AGENT: *", "DISALLOW: /a"), "/a", false],
    ["percent-escapes compare case-insensitively", lines("User-agent: *", "Disallow: /a%2fb"), "/a%2Fb", false],
    ["non-ASCII patterns match the encoded path", lines("User-agent: *", "Disallow: /café"), "/caf%C3%A9", false],
    ["regex characters in patterns are literal", lines("User-agent: *", "Disallow: /a.b"), "/aXb", true],
  ])("%s", (_name, body, path, expected) => {
    expect(isAllowedByRobots(body, path)).toBe(expected);
  });
});

describe("group selection", () => {
  it("uses a GraftBot group instead of the * group, not merged with it", () => {
    const body = lines("User-agent: GraftBot", "Allow: /", "", "User-agent: *", "Disallow: /");
    expect(isAllowedByRobots(body, "/x")).toBe(true);
    const reversed = lines("User-agent: *", "Disallow: /", "", "User-agent: GraftBot", "Allow: /");
    expect(isAllowedByRobots(reversed, "/x")).toBe(true);
  });

  it("does not let * rules leak into the GraftBot group", () => {
    const body = lines("User-agent: *", "Disallow: /", "", "User-agent: graftbot", "Disallow: /admin");
    expect(isAllowedByRobots(body, "/blog")).toBe(true);
    expect(isAllowedByRobots(body, "/admin")).toBe(false);
  });

  it("combines every group that names GraftBot", () => {
    const body = lines("User-agent: graftbot", "Disallow: /a", "", "User-agent: GRAFTBOT", "Disallow: /b");
    expect(rulesFor(body)).toEqual([
      { allow: false, pattern: "/a" },
      { allow: false, pattern: "/b" },
    ]);
  });

  it("starts a new group at a user-agent line that follows rules", () => {
    const body = lines("User-agent: otherbot", "Disallow: /", "User-agent: *", "Allow: /");
    expect(isAllowedByRobots(body, "/x")).toBe(true);
  });
});

describe("robotsVerdict", () => {
  const body = lines("User-agent: *", "Disallow: /private");

  it("judges a 2xx file by its rules", () => {
    expect(robotsVerdict(200, body, "/private")).toEqual({ allowed: false, reason: "rules" });
    expect(robotsVerdict(200, body, "/public")).toEqual({ allowed: true, reason: "rules" });
  });

  it.each([401, 403, 404, 410])("treats a %i as no restrictions", (status) => {
    expect(robotsVerdict(status, "", "/private")).toEqual({ allowed: true, reason: "no-robots" });
  });

  it.each([500, 502, 503])("treats a %i as disallowing everything", (status) => {
    expect(robotsVerdict(status, "", "/")).toEqual({ allowed: false, reason: "unavailable" });
  });
});
