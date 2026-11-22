import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import handler from "./fetch.js";
import { assertPublicHost, IntakeError, isHostAllowedForEgress, isPrivateAddress, isObviouslyPrivateHost, readCapped } from "./_net.js";

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
  it("rejects mDNS and home-network special-use names before DNS or fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const host of [
      "printer.local", "local", "device.home.arpa", "home.arpa",
      "printer.LOCAL", "router.HOME.ARPA",
    ]) {
      await expect(assertPublicHost(new URL(`https://${host}/admin`)))
        .rejects.toMatchObject({ status: 403, reason: "private" });
      expect(isObviouslyPrivateHost(host)).toBe(true);
      expect(await isHostAllowedForEgress(host)).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    for (const host of ["locally.example", "home.arpa.example", "public.example"]) {
      expect(isObviouslyPrivateHost(host)).toBe(false);
      await expect(assertPublicHost(new URL(`https://${host}/`))).resolves.toBeUndefined();
    }
  });

  it("recognizes private, link-local and mapped IPv6 addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.2", "::1", "fd00::1", "::ffff:127.0.0.1", "fe80::1", "fe90::1", "fea0::1", "febf::1", "fec0::1", "feff::1", "ff02::1", "ff0e::1", "2001:db8::1", "2001:0db8:1::a"]) {
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

  it("classifies bracketed IPv6 URLs without sending their hostnames to DNS", async () => {
    for (const address of ["::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1"]) {
      await expect(assertPublicHost(new URL(`https://[${address}]/`)))
        .rejects.toMatchObject({ reason: "private" });
      expect(isObviouslyPrivateHost(`[${address}]`)).toBe(true);
    }
    await expect(assertPublicHost(new URL("https://[2606:4700:4700::1111]/")))
      .resolves.toBeUndefined();
    expect(isObviouslyPrivateHost("[2606:4700:4700::1111]")).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
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

  it("revalidates public DNS for each browser egress decision", async () => {
    const resolve = vi.mocked(lookup);
    resolve.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never);
    resolve.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }] as never);
    expect(await isHostAllowedForEgress("changing.example")).toBe(true);
    expect(await isHostAllowedForEgress("changing.example")).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("fails closed for empty, mixed private and public, and failed DNS answers", async () => {
    const resolve = vi.mocked(lookup);
    resolve.mockResolvedValueOnce([] as never);
    resolve.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ] as never);
    resolve.mockRejectedValueOnce(new Error("DNS failure"));
    expect(await isHostAllowedForEgress("empty.example")).toBe(false);
    expect(await isHostAllowedForEgress("mixed.example")).toBe(false);
    expect(await isHostAllowedForEgress("failed.example")).toBe(false);
  });

  it("handles bracketed IPv6 egress literals without DNS resolution", async () => {
    for (const address of ["::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1"]) {
      expect(await isHostAllowedForEgress(`[${address}]`), address).toBe(false);
    }
    expect(await isHostAllowedForEgress("[2606:4700:4700::1111]")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
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

  it("enforces robots rules on a same-origin redirected page before fetching it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "/private/data" },
      }))
      .mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /private", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/allowed" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("https://public.example/robots.txt");
    expect(fetchMock.mock.calls.every(([url]) => String(url) !== "https://public.example/private/data")).toBe(true);
  });

  it("enforces destination-host robots on cross-origin page redirects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://other.example/blocked" },
      }))
      .mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /blocked", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/allowed" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 403, data: { reason: "robots" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("https://other.example/robots.txt");
  });

  it("continues when a redirect destination is allowed by its own robots rules", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://other.example/public" },
      }))
      .mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /private", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html><body><section>Safe</section></body></html>", {
        status: 200, headers: { "content-type": "text/html" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = fakeResponse();
    await handler({ query: { url: "https://public.example/allowed" } }, reply.response);
    expect(reply.result()).toMatchObject({ status: 200, data: { finalUrl: "https://other.example/public" } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
