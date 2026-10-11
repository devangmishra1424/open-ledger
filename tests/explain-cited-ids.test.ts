import { describe, expect, it } from "vitest";
import { citedIds } from "@/lib/explain";

/**
 * `grounded` on an explained answer is true only if the answer quotes a real decision id. A live answer wrote the hyphens of a
 * correct id as non-breaking hyphens (U+2011), so a correctly cited answer was reported as "did not cite a recorded decision".
 * That wording is also read aloud, so it has to be right.
 */
const A = "16b5038e-fa23-47b2-bf34-212b0e62bc2a";
const B = "9f8993d7-0e57-481f-a7ab-ee829daae41a";
const swapHyphens = (id: string, code: number) => id.replace(/-/g, String.fromCharCode(code));

describe("citedIds", () => {
  it("finds an id quoted exactly", () => {
    expect(citedIds(`Because of X (see decision ${A}).`, [A, B])).toEqual([A]);
  });

  it("finds an id whose hyphens the model wrote as other Unicode hyphens", () => {
    for (const code of [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212]) {
      expect(citedIds(`(see decision ${swapHyphens(A, code)})`, [A, B])).toEqual([A]);
    }
  });

  it("returns every cited id, in the order the records were given, and none that were not quoted", () => {
    expect(citedIds(`First ${B}, then ${A}.`, [A, B])).toEqual([A, B]);
    expect(citedIds("No ids here.", [A, B])).toEqual([]);
  });

  it("does not accept a shortened or altered id as a citation", () => {
    expect(citedIds(`see decision ${A.slice(0, 18)}...`, [A])).toEqual([]);
    expect(citedIds(`see decision ${A.replace("b2", "b3")}`, [A])).toEqual([]);
  });
});
