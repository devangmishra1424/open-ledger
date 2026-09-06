import { describe, it, expect } from "vitest";
import { isPlausibleUomConversion } from "@/lib/matching/uom-dimension";

describe("isPlausibleUomConversion", () => {
  it("matches the spec's own worked example: case <-> each is plausible (both count-like)", () => {
    expect(isPlausibleUomConversion("case", "each")).toBe(true);
    expect(isPlausibleUomConversion("each", "case")).toBe(true);
  });

  it("matches the spec's own incompatible example: hours vs each is not plausible", () => {
    expect(isPlausibleUomConversion("hours", "each")).toBe(false);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isPlausibleUomConversion(" Case ", "EACH")).toBe(true);
  });

  it("is conservative about unrecognized units — not plausible, not a guess", () => {
    expect(isPlausibleUomConversion("each", "frobnicate")).toBe(false);
    expect(isPlausibleUomConversion("frobnicate", "each")).toBe(false);
  });

  it("weight and volume units are each internally plausible but not across dimensions", () => {
    expect(isPlausibleUomConversion("kg", "lb")).toBe(true);
    expect(isPlausibleUomConversion("liter", "gallon")).toBe(true);
    expect(isPlausibleUomConversion("kg", "liter")).toBe(false);
  });
});
