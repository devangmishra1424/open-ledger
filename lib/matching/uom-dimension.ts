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
  each: "count", ea: "count", unit: "count", units: "count", pair: "count", pack: "count", packet: "count", set: "count",
  box: "count", boxes: "count", case: "count", cases: "count",
  dozen: "count", pallet: "count", pallets: "count", carton: "count", cartons: "count",

  hour: "time", hours: "time", hr: "time", day: "time", days: "time",

  kg: "weight", g: "weight", gram: "weight", grams: "weight",
  lb: "weight", lbs: "weight", oz: "weight", ton: "weight",

  liter: "volume", liters: "volume", l: "volume", ml: "volume", gallon: "volume", gal: "volume",

  meter: "length", m: "length", ft: "length", foot: "length", feet: "length", in: "length", inch: "length",
};

/**
 * One spelling per unit, so the same unit written two ways is the same unit: an Indian invoice's "Nos" is the PO's
 * "each", "Pairs" is "pair", "BOXES" is "box". Units are stored this way (lib/bills.ts, lib/purchase-orders.ts),
 * so the match compares like with like: before units were kept at all, every invoice line counted in "each" and a
 * PO ordered in boxes read as a 99% undercharge on 100 times the quantity. An unknown unit is kept as written
 * (lower case): two different unknown words are two different units.
 */
const UOM_SYNONYMS: Record<string, string> = {
  each: "each", ea: "each", nos: "each", no: "each", number: "each", numbers: "each", pc: "each", pcs: "each",
  piece: "each", pieces: "each", unit: "each", units: "each", item: "each", items: "each", qty: "each",
  pair: "pair", pairs: "pair", pr: "pair", prs: "pair",
  box: "box", boxes: "box", bx: "box", case: "case", cases: "case", cs: "case",
  pack: "pack", packs: "pack", pk: "pack", pkt: "pack", pkts: "pack", packet: "packet", packets: "packet",
  carton: "carton", cartons: "carton", ctn: "carton", pallet: "pallet", pallets: "pallet",
  dozen: "dozen", doz: "dozen", dz: "dozen", set: "set", sets: "set",
  visit: "visit", visits: "visit",
  hour: "hour", hours: "hour", hr: "hour", hrs: "hour", day: "day", days: "day", month: "month", months: "month",
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg", g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  l: "liter", ltr: "liter", ltrs: "liter", litre: "liter", litres: "liter", liter: "liter", liters: "liter", ml: "ml",
  m: "meter", mtr: "meter", mtrs: "meter", metre: "meter", metres: "meter", meter: "meter", meters: "meter",
};

/** The one spelling of a unit ("Nos" -> "each", "Pairs" -> "pair"); "each" when none is given. */
export function canonicalUom(raw: string | null | undefined): string {
  const key = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!key) return "each";
  return UOM_SYNONYMS[key] ?? key;
}

export function isPlausibleUomConversion(fromUom: string, toUom: string): boolean {
  const dimA = UOM_DIMENSIONS[fromUom.toLowerCase().trim()];
  const dimB = UOM_DIMENSIONS[toUom.toLowerCase().trim()];
  if (!dimA || !dimB) return false;
  return dimA === dimB;
}
