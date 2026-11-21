import { describe, expect, it } from "vitest";
import { formatCredits, formatSignedCredits } from "./format-credits.ts";

describe("formatCredits", () => {
  it("formats the starting grant", () => {
    expect(formatCredits("10000.000000")).toBe("10,000.00");
  });

  it("stays exact beyond what a JavaScript number can hold", () => {
    expect(formatCredits("99999999999999.500000")).toBe("99,999,999,999,999.50");
    expect(Number("99999999999999.500000").toFixed(2)).toBe("99999999999999.50"); // a float is borderline here already
    expect(formatCredits("12345678901234.560000")).toBe("12,345,678,901,234.56");
  });

  it("handles zero and small amounts", () => {
    expect(formatCredits("0.000000")).toBe("0.00");
    expect(formatCredits("0.300000")).toBe("0.30");
  });
});

describe("formatSignedCredits", () => {
  it("always shows the direction of the movement", () => {
    expect(formatSignedCredits("10000.000000")).toBe("+10,000.00");
    expect(formatSignedCredits("-12.500000")).toBe("-12.50");
  });
});
