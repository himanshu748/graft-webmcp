import { describe, expect, it } from "vitest";

import {
  assertPublicHost,
  IntakeError,
  isHostAllowedForEgress,
  isObviouslyPrivateHost,
  isPrivateAddress,
  readCapped,
} from "../api/_net";
import { shouldCompileFixtureOnModeSelection } from "./data/sources";

function streamResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

describe("owned fixture mode", () => {
  it("loads the selected fixture when switching from another source", () => {
    expect(shouldCompileFixtureOnModeSelection("fixture", "live")).toBe(true);
    expect(shouldCompileFixtureOnModeSelection("fixture", "paste")).toBe(true);
    expect(shouldCompileFixtureOnModeSelection("fixture")).toBe(true);
    expect(shouldCompileFixtureOnModeSelection("fixture", "fixture")).toBe(false);
    expect(shouldCompileFixtureOnModeSelection("live", "fixture")).toBe(false);
  });
});

describe("private address classification", () => {
  it("rejects every private and link-local range", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("treats malformed input as private rather than guessing", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
  });
});

describe("assertPublicHost", () => {
  it("refuses non-http schemes", async () => {
    await expect(assertPublicHost(new URL("ftp://example.com"))).rejects.toBeInstanceOf(IntakeError);
  });

  it("refuses loopback names", async () => {
    await expect(assertPublicHost(new URL("http://localhost:3000"))).rejects.toMatchObject({
      reason: "private",
    });
  });

  it("refuses literal private addresses, including cloud metadata", async () => {
    await expect(
      assertPublicHost(new URL("http://169.254.169.254/latest/meta-data/")),
    ).rejects.toMatchObject({ reason: "private" });
  });

  it("refuses denylisted categories by policy", async () => {
    for (const url of ["https://login.example.com", "https://paypal.com", "https://mail.example.com"]) {
      await expect(assertPublicHost(new URL(url)), url).rejects.toMatchObject({
        reason: "denylisted",
      });
    }
  });
});

describe("egress guard used by the renderer", () => {
  it("blocks literal private addresses", async () => {
    expect(await isHostAllowedForEgress("169.254.169.254")).toBe(false);
    expect(await isHostAllowedForEgress("127.0.0.1")).toBe(false);
    expect(await isHostAllowedForEgress("localhost")).toBe(false);
  });

  it("blocks a public hostname that resolves to a private address", async () => {
    // localtest.me and its subdomains resolve to 127.0.0.1 by design, which is
    // exactly the shape a pattern match misses and a DNS lookup catches.
    expect(await isHostAllowedForEgress("anything.localtest.me")).toBe(false);
  });

  it("is not fooled by a name that merely looks public", () => {
    expect(isObviouslyPrivateHost("metadata.google.internal")).toBe(true);
    expect(isObviouslyPrivateHost("evil.example.com")).toBe(false);
  });
});

describe("streaming size cap", () => {
  it("rejects a declared length over the limit before reading", async () => {
    const response = streamResponse(["x"], { "content-length": "999999" });
    await expect(readCapped(response, 1000)).rejects.toMatchObject({ reason: "too-large" });
  });

  it("rejects a chunked body that exceeds the limit while reading", async () => {
    // No content-length, so the only defence is the cap inside the read loop.
    const response = streamResponse(["a".repeat(600), "b".repeat(600)]);
    expect(response.headers.get("content-length")).toBeNull();
    await expect(readCapped(response, 1000)).rejects.toMatchObject({ reason: "too-large" });
  });

  it("returns the body when it fits", async () => {
    const response = streamResponse(["hello ", "world"]);
    await expect(readCapped(response, 1000)).resolves.toBe("hello world");
  });
});

describe("stylesheet inlining", () => {
  it("validates the stylesheet host before fetching it", async () => {
    const { inlineStylesheets } = await import("../api/fetch");
    const html =
      '<html><head><link rel="stylesheet" href="http://169.254.169.254/style.css"></head><body><p>hi</p></body></html>';
    const result = await inlineStylesheets(html, new URL("https://example.com/"));
    // A blocked sheet contributes nothing. The link element itself is left for
    // the sanitizer, which removes every link tag before the markup is used.
    expect(result.inlined).toBe(0);
    expect(result.html).not.toContain("data-graft-inlined");
  });

  it("ignores non-http stylesheet schemes", async () => {
    const { inlineStylesheets } = await import("../api/fetch");
    const html = '<html><head><link rel="stylesheet" href="file:///etc/passwd"></head></html>';
    const result = await inlineStylesheets(html, new URL("https://example.com/"));
    expect(result.inlined).toBe(0);
  });
});
