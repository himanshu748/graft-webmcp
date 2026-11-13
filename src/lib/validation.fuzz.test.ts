import { describe, expect, it } from "vitest";
import { ToolArgumentValidationError, validateToolArguments } from "./validation";

describe("security boundary: reproducible argument fuzzing", () => {
  it("either validates the full schema or raises only a typed validation error", () => {
    const tool = {
      name: "set_quantity",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["product", "quantity"],
        properties: {
          product: { type: "string" as const, pattern: "^item-[0-9]{1,3}$", maxLength: 8 },
          quantity: { type: "integer" as const, minimum: 1, maximum: 5 },
          confirmed: { type: "boolean" as const },
        },
      },
    };
    const candidates: unknown[] = [
      undefined, null, false, true, -1, 0, 1, 5, 6, 1.5, Number.NaN,
      Number.POSITIVE_INFINITY, "", "1", "item-1", "item-999", "item-1000",
      "javascript:alert(1)", "<svg/onload=alert(1)>", [], [1], {}, { a: 1 },
    ];
    const keys = ["product", "quantity", "confirmed", "extra", "__proto__", "constructor"];
    let seed = 0x5a17e11;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    let accepted = 0;
    let rejected = 0;

    for (let attempt = 0; attempt < 512; attempt += 1) {
      const entries: Array<[string, unknown]> = [];
      for (const key of keys) {
        if (next() % 3 === 0) entries.push([key, candidates[next() % candidates.length]]);
      }
      // Object.fromEntries keeps even '__proto__' as an own input key.
      const args = Object.fromEntries(entries);
      try {
        validateToolArguments(tool, args);
        accepted += 1;
        expect(Object.keys(args).every((key) => ["product", "quantity", "confirmed"].includes(key)))
          .toBe(true);
        expect(typeof args.product).toBe("string");
        expect(args.product).toMatch(/^item-[0-9]{1,3}$/);
        expect((args.product as string).length).toBeLessThanOrEqual(8);
        expect(typeof args.quantity).toBe("number");
        expect(Number.isInteger(args.quantity)).toBe(true);
        expect(args.quantity as number).toBeGreaterThanOrEqual(1);
        expect(args.quantity as number).toBeLessThanOrEqual(5);
        if ("confirmed" in args) expect(typeof args.confirmed).toBe("boolean");
      } catch (error) {
        // Assertions are not validation errors: let them surface as failures.
        if (!(error instanceof ToolArgumentValidationError)) throw error;
        rejected += 1;
        expect(error.issues.length).toBeGreaterThan(0);
      }
    }
    expect(rejected).toBeGreaterThan(0);
    // A well-formed control ensures the accepted path is also checked.
    expect(() => validateToolArguments(tool, { product: "item-1", quantity: 3 }))
      .not.toThrow();
    expect(accepted + rejected).toBe(512);
  });
});
