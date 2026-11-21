import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import handler from "./fetch.js";
import { assertPublicHost, IntakeError, isPrivateAddress, readCapped } from "./_net.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("./_render.js", () => ({ renderWithBrowser: vi.fn() }));

function fakeResponse() {
  let status = 200;
  let data: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  return {
    response: {
      setHeader(name: string, value: string) { headers[name] = value; },
      status(code: number) { status = code; return this; },
      json(body: Record<string, unknown>) { data = body; },
    },
    result() { return { status, data, headers }; },
  };
}

beforeEach(() => {
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("untrusted URL and DNS boundaries", () => {
  it("recognizes private, link-local and mapped IPv6 addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.2", "::1", "fd00::1", "::ffff:127.0.0.1", "fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("blocks special-use IPv4 addresses and DNS results", async () => {
    for (const address of ["192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.254", "198.51.100.7", "203.0.113.5", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["192.0.0.9", "192.0.0.10", "192.1.0.1", "198.20.0.1", "203.0.114.1", "223.255.255.254"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "198.18.0.1", family: 4 }] as never);
    await expect(assertPublicHost(new URL("https://benchmark.example/resource"))).rejects.toMatchObject({ reason: "private" });
  });

  it("rejects local hosts and hostnames whose DNS resolves to private space", async () => {
    await expect(assertPublicHost(new URL("https://localhost/admin"))).rejects.toMatchObject({ reason: "private" });
    await expect(assertPublicHost(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toMatchObject({ reason: "private" });
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.0.0.3", family: 4 }] as never);
    await expect(assertPublicHost(new URL("https://host.example/resource"))).rejects.toMatchObject({ reason: "private" });
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "fe9f::1", family: 6 }] as never);
    await expect(assertPublicHost(new URL("https://ipv6.example/resource"))).rejects.toMatchObject({ reason: "private" });
    await expect(assertPublicHost(new URL("https://public.example/resource"))).resolves.toBeUndefined();
  });

  it("rejects non-HTTP schemes and prohibited authentication hosts", async () => {
    await expect(assertPublicHost(new URL("file:///etc/passwd"))).rejects.toMatchObject({ reason: "scheme" });
    await expect(assertPublicHost(new URL("https://login.example.com/"))).rejects.toMatchObject({ reason: "denylisted" });
  });

  it("rejects URL-embedded credentials before DNS or network requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const url of ["https://user:pass@public.example/", "https://user@public.example/"]) {
      const reply = fakeResponse();
      await handler({ query: { url } }, reply.response);
      expect(reply.result()).toMatchObject({ status: 400, data: { reason: "credentials" } });
      expect(JSON.stringify(reply.result().data)).not.toContain("pass");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("response size ceilings", () => {
  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const response = new Response("abc", { headers: { "content-length": "900" } });
    await expect(readCapped(response, 4)).rejects.toMatchObject({ status: 413, reason: "too-large" });
  });

  it("rejects a chunked response that exceeds the actual byte limit", async () => {
    const response = new Response("abcdef");
    await expect(readCapped(response, 5)).rejects.toBeInstanceOf(IntakeError);
    await expect(readCapped(new Response("abcde"), 5)).resolves.toBe("abcde");
  });
});

describe("fetch endpoint SSRF and robots enforcement", () => {
  it("refuses a robots.txt redirect to a private address without fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/page" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://public.example/robots.txt");
  });

  it("revalidates public robots redirects and applies their rules to the original path", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://robots-cdn.example/policy.txt" },
      }))
      .mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /secret", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/secret/data" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://robots-cdn.example/policy.txt");
    expect(vi.mocked(lookup)).toHaveBeenCalledWith("robots-cdn.example", { all: true });
  });

  it("fails closed when robots.txt exceeds its redirect limit", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(null, { status: 302, headers: { location: "/robots.txt" } }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("re-validates redirected hosts before contacting them", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/" } }, reply.response);
    expect(reply.result().status).toBe(403);
    expect(reply.result().data.reason).toBe("private");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("127.0.0.1"))).toBe(true);
  });

  it("refuses robots.txt disallowed paths without requesting page content", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /private", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/private/notes" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an oversized robots.txt without requesting the page", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("x".repeat(512_001), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/resource" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces a received HTML byte limit without a Content-Length header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("x".repeat(3_000_001), { status: 200, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 413, data: { reason: "too-large" } });
  });
});

describe("network error disclosure", () => {
  it("never returns upstream exception text containing credentials", async () => {
    const secret = "synthetic-not-a-real-credential";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockRejectedValueOnce(new Error(`fetch https://public.example/?token=${secret} failed`));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/page" } }, reply.response);
    expect(reply.result()).toMatchObject({
      status: 502,
      data: { reason: "network", detail: "The remote request failed." },
    });
    expect(JSON.stringify(reply.result().data)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the fixed timeout diagnostic without returning exception text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockRejectedValueOnce(new Error("The operation was aborted; token=synthetic-private-data"));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/page" } }, reply.response);
    expect(reply.result()).toMatchObject({
      status: 502,
      data: { reason: "network", detail: "The request timed out after 12 seconds." },
    });
    expect(JSON.stringify(reply.result().data)).not.toContain("synthetic-private-data");
  });
});
