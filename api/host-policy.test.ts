import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { assertPublicHost, isObviouslyPrivateHost, isHostAllowedForEgress } from "./_net.js";

describe("absolute DNS hostname policy", () => {
  beforeEach(() => {
    vi.mocked(lookup).mockClear();
  });

  it("rejects denylisted hosts even when written with a DNS root dot", async () => {
    for (const host of ["paypal.com.", "stripe.com.", "wise.com.", "login.example.com."]) {
      await expect(assertPublicHost(new URL(`https://${host}/`))).rejects.toMatchObject({
        status: 403,
        reason: "denylisted",
      });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("recognizes root-dot local domains before issuing DNS requests", async () => {
    for (const host of ["localhost.", "service.localhost.", "admin.internal."]) {
      expect(isObviouslyPrivateHost(host)).toBe(true);
      await expect(assertPublicHost(new URL(`https://${host}/`))).rejects.toMatchObject({
        status: 403,
        reason: "private",
      });
      expect(await isHostAllowedForEgress(host)).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves public absolute names without their root dot", async () => {
    await expect(assertPublicHost(new URL("https://safe.example./"))).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("safe.example", { all: true });
  });
});
