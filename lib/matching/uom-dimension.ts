/**
 * Classifies whether a unit-of-measure conversion is physically plausible, for
 * EXC-UOM_MISMATCH's severity rule (ALGORITHMS.md §14): "a plausible conversion exists but
 * isn't on file" (e.g. case <-> each, both counting the same kind of thing) escalates L1,
 * while "fundamentally incompatible" units (e.g. hours vs each — time can't convert to count)
 * block outright. This is a physical-dimension question, independent of whether an actual
 * conversion FACTOR happens to be on file (that's a separate, vendor-specific lookup in
 * vendor_corrections — see match-stage.ts) — two units can be the same dimension and still
 * have no stored factor yet, which is exactly the "plausible but not on file" case.
 *
 * Deliberately a small, hardcoded, honestly-scoped table, not a real units-of-measure library —
 * hackathon scope covers the unit strings the demo data actually uses. An unrecognized unit is
 * conservatively NOT plausible (a real financial control shouldn't guess that an unfamiliar
 * unit is safely convertible).
 */

const UOM_DIMENSIONS: Record<string, string> = {
  each: "count", ea: "count", unit: "count", units: "count",
  box: "count", boxes: "count", case: "count", cases: "count",
  dozen: "count", pallet: "count", pallets: "count", carton: "count", cartons: "count",

  hour: "time", hours: "time", hr: "time", day: "time", days: "time",

  kg: "weight", g: "weight", gram: "weight", grams: "weight",
  lb: "weight", lbs: "weight", oz: "weight", ton: "weight",

  liter: "volume", liters: "volume", l: "volume", ml: "volume", gallon: "volume", gal: "volume",

  meter: "length", m: "length", ft: "length", foot: "length", feet: "length", in: "length", inch: "length",
};

export function isPlausibleUomConversion(fromUom: string, toUom: string): boolean {
  const dimA = UOM_DIMENSIONS[fromUom.toLowerCase().trim()];
  const dimB = UOM_DIMENSIONS[toUom.toLowerCase().trim()];
  if (!dimA || !dimB) return false;
  return dimA === dimB;
}
