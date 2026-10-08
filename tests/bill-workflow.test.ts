import { describe, it, expect } from "vitest";
import { allowedActions, checkHumanAction, type HumanAction } from "@/lib/bill-workflow";
import type { BillStatus } from "@/lib/types";

// Pure logic -- no database. Pins the rules that stop a human action leaving the system in a
// state no screen can explain (approving a rejected invoice, rejecting one already in the ledger).

const ALL_STATUSES: BillStatus[] = ["processing", "matched", "exception", "approved", "posted", "paid", "void"];

describe("checkHumanAction: the full status x action table", () => {
  // [status, approve, reject, contest, mark_reviewed] -- "ok" = allowed, "done" = already in that state, "no" = refused
  const table: Array<[BillStatus, string, string, string, string]> = [
    ["processing", "no", "no", "no", "no"],
    ["matched", "ok", "ok", "ok", "no"],
    ["exception", "ok", "ok", "ok", "ok"],
    ["approved", "done", "no", "no", "no"],
    ["posted", "done", "no", "no", "no"],
    ["paid", "done", "no", "no", "no"],
    ["void", "no", "done", "ok", "no"],
  ];
  const actions: HumanAction[] = ["approve", "reject", "contest", "mark_reviewed"];

  for (const [status, ...expected] of table) {
    it(`${status}: ${expected.join(" / ")}`, () => {
      actions.forEach((action, i) => {
        const r = checkHumanAction(status, action);
        const got = !r.allowed ? "no" : r.alreadyDone ? "done" : "ok";
        expect(got, `${action} on ${status}`).toBe(expected[i]);
      });
    });
  }

  it("covers every status in the schema's CHECK constraint (a new status must be added to this table)", () => {
    expect(table.map((r) => r[0]).sort()).toEqual([...ALL_STATUSES].sort());
  });
});

describe("the specific mistakes this prevents", () => {
  it("cannot approve a rejected invoice, and says why in plain words", () => {
    const r = checkHumanAction("void", "approve");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/rejected/i);
  });

  it("cannot reject an invoice that is already posted to the ledger (its journal entry would be left behind)", () => {
    const r = checkHumanAction("posted", "reject");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/ledger/i);
  });

  it("cannot act on an invoice the pipeline is still processing (the pipeline would overwrite the result)", () => {
    for (const a of ["approve", "reject", "contest"] as const) {
      expect(checkHumanAction("processing", a).allowed, a).toBe(false);
    }
  });

  it("approving an already-posted invoice is a safe no-op, so a double click or a retry does nothing twice", () => {
    expect(checkHumanAction("posted", "approve")).toEqual({ allowed: true, alreadyDone: true });
    expect(checkHumanAction("paid", "approve")).toEqual({ allowed: true, alreadyDone: true });
  });

  it("rejecting an already-rejected invoice is likewise an idempotent no-op", () => {
    expect(checkHumanAction("void", "reject")).toEqual({ allowed: true, alreadyDone: true });
  });
});

describe("bank-change fraud hold", () => {
  it("blocks approval while the vendor's changed bank details are unverified", () => {
    const r = checkHumanAction("exception", "approve", { bankChangeHold: true });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/bank/i);
  });

  it("does not block rejecting or contesting while the hold is active -- only moving money is held", () => {
    expect(checkHumanAction("exception", "reject", { bankChangeHold: true }).allowed).toBe(true);
    expect(checkHumanAction("exception", "contest", { bankChangeHold: true }).allowed).toBe(true);
  });

  it("does not turn an already-posted approval into a refusal", () => {
    expect(checkHumanAction("posted", "approve", { bankChangeHold: true })).toEqual({ allowed: true, alreadyDone: true });
  });
});

describe("allowedActions: what the case card should offer", () => {
  it("offers all three on an open exception", () => {
    expect(allowedActions("exception")).toEqual(["approve", "reject", "contest"]);
  });

  it("offers only 'contest' on a rejected invoice", () => {
    expect(allowedActions("void")).toEqual(["contest"]);
  });

  it("offers nothing on a posted or paid invoice, and nothing while processing", () => {
    expect(allowedActions("posted")).toEqual([]);
    expect(allowedActions("paid")).toEqual([]);
    expect(allowedActions("processing")).toEqual([]);
  });

  it("drops 'approve' while a bank-change hold is active", () => {
    expect(allowedActions("exception", { bankChangeHold: true })).toEqual(["reject", "contest"]);
  });

  it("never offers an action that checkHumanAction would refuse", () => {
    for (const status of ALL_STATUSES) {
      for (const hold of [false, true]) {
        for (const a of allowedActions(status, { bankChangeHold: hold })) {
          const r = checkHumanAction(status, a, { bankChangeHold: hold });
          expect(r.allowed, `${a} on ${status} hold=${hold}`).toBe(true);
        }
      }
    }
  });
});
