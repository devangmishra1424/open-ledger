import { randomUUID } from "node:crypto";
import { getSql } from "@/db/client";
import { runInBackground } from "@/lib/background";
import { HttpError } from "@/lib/http";
import { getDecisionsForInvoice, markSuperseded } from "@/lib/ledger/decisions";
import { rerunFromValidate, type ReconsiderationInput } from "@/lib/pipeline/orchestrator";
import type { Claim, Decision } from "@/lib/types";

/**
 * Re-checking an invoice when the facts it was checked against change.
 *
 * An invoice is matched once, when it is saved. Two things could leave it stuck after that:
 *  1. It was saved before its purchase order existed: it became a non-PO invoice, and adding the PO later did not
 *     link it. Now the invoice keeps the PO number it cites (vendor_bills.po_reference), and adding a PO with that
 *     number for the same vendor links it and checks it again.
 *  2. It was stopped because the goods had not arrived (or not all of them): recording the receipt later did not
 *     check it again. Now it does, for invoices stopped for a receiving reason.
 * A person can also ask for a re-check on the invoice page (and type the PO number when the invoice did not print it).
 *
 * What a re-check does: validate -> match -> investigate -> verify -> policy -> audit again, against the current
 * PO and receipts, exactly as if the invoice had been saved now. The run it replaces is marked superseded, never
 * deleted (the hash chain keeps every record). A person's decision and an auditor hand-over are never superseded.
 * The reason is the first claim of the new run, and who caused it is recorded on every new decision. The agents
 * are not told the reason as if it were a person's question (askAgents: false): they look at the facts afresh.
 *
 * Only an invoice waiting for a person (status 'exception') is re-checked. One that is approved, posted, paid or
 * rejected has been decided; one still 'processing' is being checked already. Claiming the invoice (exception ->
 * processing, under a row lock) is what stops two re-checks from running at once.
 */

export const AUTOMATIC = "VeriBook (automatic)";
/** The exceptions a newly recorded receipt can clear. */
const RECEIVING_CODES = ["EXC-BEFORE_RCV", "EXC-QTY_VAR", "EXC-PARTIAL"];
/** Stages a re-check replaces. extract (the reading), human_review and audit_assemble are never superseded. */
const RERUN_NODES = new Set(["validate", "match", "investigate", "verify", "policy", "audit"]);
/** At most this many invoices are re-checked for one new PO or receipt (each re-check can call the AI). */
const MAX_PER_TRIGGER = 50;

export type RecheckReason =
  | { kind: "po_added"; poNumber: string; by: string }
  | { kind: "goods_received"; poNumber: string; receiptDate: string; by: string }
  | { kind: "manual"; by: string };

export interface RecheckStarted {
  invoiceId: string;
  /** The PO this re-check linked the invoice to (null when it was already linked, or no PO is on file). */
  linkedPo: { id: string; poNumber: string } | null;
  message: string;
}

function why(reason: RecheckReason): string {
  switch (reason.kind) {
    case "po_added": return `because purchase order ${reason.poNumber} was added`;
    case "goods_received": return `because goods were received against purchase order ${reason.poNumber} (receipt dated ${reason.receiptDate})`;
    case "manual": return `at ${reason.by}'s request`;
  }
}

const NOT_WAITING: Record<string, string> = {
  processing: "this invoice is being checked right now; wait for that to finish",
  approved: "this invoice has been approved; a decided invoice is not re-checked",
  posted: "this invoice has been approved and posted to the ledger; a decided invoice is not re-checked",
  paid: "this invoice has been paid; a decided invoice is not re-checked",
  void: "this invoice was rejected; a decided invoice is not re-checked",
  matched: "this invoice is being finalised; it does not need a re-check",
};

/**
 * Claims the invoice, links the PO it cites if that PO is now on file for the same vendor, and starts the re-run in
 * the background. `poNumber` (from a person) replaces the number the invoice cites when it is not linked yet; it
 * must then name a PO on file for the same vendor, or nothing changes (422).
 * Throws HttpError: 404 no such invoice, 409 not waiting for a person, 422 the typed PO is not on file for the vendor.
 */
export async function startRecheck(invoiceId: string, reason: RecheckReason, opts: { poNumber?: string | null } = {}): Promise<RecheckStarted> {
  const sql = getSql();
  const claimed = await sql.begin(async (tx) => {
    const [bill] = await tx`
      SELECT b.id, b.status, b.vendor_id, b.po_id, b.po_reference, v.name AS vendor_name
      FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ${invoiceId} FOR UPDATE OF b`;
    if (!bill) throw new HttpError(404, `no invoice found with id '${invoiceId}'`);
    if (bill.status !== "exception") throw new HttpError(409, NOT_WAITING[bill.status] ?? `this invoice is ${bill.status}; only an invoice waiting for a person can be re-checked`);

    const typed = opts.poNumber?.trim() || null;
    if (typed && bill.po_id) {
      const [linked] = await tx`SELECT po_number FROM purchase_orders WHERE id = ${bill.po_id}`;
      if (linked && linked.po_number !== typed) {
        throw new HttpError(409, `this invoice is already linked to purchase order ${linked.po_number}; it cannot be moved to another PO`);
      }
    }
    const poReference: string | null = bill.po_id ? bill.po_reference : typed ?? bill.po_reference;
    let linkedPo: RecheckStarted["linkedPo"] = null;
    if (!bill.po_id && poReference) {
      const [po] = await tx`SELECT id, po_number FROM purchase_orders WHERE po_number = ${poReference} AND vendor_id = ${bill.vendor_id}`;
      if (po) linkedPo = { id: po.id, poNumber: po.po_number };
      else if (typed) {
        throw new HttpError(422, `no purchase order ${typed} is on file for ${bill.vendor_name}. Add it on the Orders page first; its vendor name must match the invoice's.`);
      }
    }

    const [extract] = await tx`
      SELECT id FROM decisions WHERE invoice_id = ${invoiceId} AND node_id = 'extract' AND superseded_by_id IS NULL ORDER BY seq DESC LIMIT 1`;
    if (!extract) throw new HttpError(409, "this invoice has no reading on its trail to re-check from");

    await tx`
      UPDATE vendor_bills SET status = 'processing', po_reference = ${poReference}, po_id = COALESCE(${linkedPo?.id ?? null}, po_id)
      WHERE id = ${invoiceId}`;
    return { linkedPo, extractId: extract.id as string, poReference, vendorName: bill.vendor_name as string, wasLinked: Boolean(bill.po_id) };
  });

  const reasonText = why(reason);
  const recon: ReconsiderationInput = {
    attemptTag: `recheck:${randomUUID()}`,
    directlyReconsidered: false,
    triggeredByActor: reason.by,
    triggeredByQuestion: `Re-checked ${reasonText}.`,
    askAgents: false,
  };
  const leadClaims: Claim[] = [{ text: `Re-checked ${reasonText}.`, tag: "grounded" }];
  if (claimed.linkedPo) {
    leadClaims.push({ text: `Linked to purchase order ${claimed.linkedPo.poNumber}: the PO number the invoice cites, from the same vendor.`, tag: "grounded" });
  }
  console.info(`recheck: invoice ${invoiceId} ${reasonText} (by ${reason.by})${claimed.linkedPo ? `; linked to PO ${claimed.linkedPo.poNumber}` : ""}`);

  runInBackground(`recheck(${invoiceId})`, () => rerunFromValidate(invoiceId, claimed.extractId, {
    recon,
    leadClaims,
    onFirstDecision: (first) => supersedePreviousRun(invoiceId, first),
  }));

  const message = claimed.linkedPo
    ? `Linked to purchase order ${claimed.linkedPo.poNumber} and checking it again.`
    : claimed.wasLinked
      ? "Checking it again against its purchase order and what has been received."
      : claimed.poReference
        ? `Checking it again. No purchase order ${claimed.poReference} is on file for ${claimed.vendorName} yet, so it is still a non-PO invoice.`
        : "Checking it again. It cites no PO number, so it is still a non-PO invoice; type the PO number to link one.";
  return { invoiceId, linkedPo: claimed.linkedPo, message };
}

/** Marks the stages of the run being replaced as superseded by the new run's first decision. */
async function supersedePreviousRun(invoiceId: string, first: Decision): Promise<void> {
  const all = await getDecisionsForInvoice(invoiceId);
  const firstIndex = all.findIndex((d) => d.id === first.id);
  for (const d of all.slice(0, firstIndex)) {
    if (!d.supersededById && RERUN_NODES.has(d.nodeId)) await markSuperseded(d.id, first.id);
  }
}

/**
 * A PO was just added: re-check the waiting non-PO invoices from the same vendor that cite its number. Returns the
 * invoices re-checked. One that cannot be (it changed state meanwhile) is skipped and logged, never fails the PO.
 */
export async function recheckWaitingForNewPo(po: { poNumber: string; vendorId: string }): Promise<Array<{ id: string; invoiceNumber: string }>> {
  const rows = await getSql()`
    SELECT id, invoice_number FROM vendor_bills
    WHERE status = 'exception' AND po_id IS NULL AND vendor_id = ${po.vendorId} AND po_reference = ${po.poNumber}
    ORDER BY received_at LIMIT ${MAX_PER_TRIGGER + 1}`;
  return startEach(rows as unknown as Array<{ id: string; invoice_number: string }>, { kind: "po_added", poNumber: po.poNumber, by: AUTOMATIC }, `PO ${po.poNumber}`);
}

/**
 * Goods were just received against a PO: re-check its waiting invoices that were stopped for a receiving reason
 * (goods not received yet, received after the invoice, or fewer received than billed). An invoice stopped for
 * something a receipt cannot change (a price difference, say) is left as it is.
 */
export async function recheckWaitingForReceipt(po: { id: string; poNumber: string }, receiptDate: string): Promise<Array<{ id: string; invoiceNumber: string }>> {
  const rows = await getSql()`
    SELECT id, invoice_number FROM vendor_bills WHERE status = 'exception' AND po_id = ${po.id} ORDER BY received_at LIMIT ${MAX_PER_TRIGGER + 1}`;
  const stoppedForReceiving: Array<{ id: string; invoice_number: string }> = [];
  for (const row of rows) {
    const live = (await getDecisionsForInvoice(row.id)).filter((d) => !d.supersededById);
    const match = live.filter((d) => d.nodeId === "match").at(-1);
    const codes = [match?.reasonCode, ...(match?.claims ?? []).map((c) => c.text)].join(" ");
    if (RECEIVING_CODES.some((code) => codes.includes(code))) stoppedForReceiving.push(row as { id: string; invoice_number: string });
  }
  return startEach(stoppedForReceiving, { kind: "goods_received", poNumber: po.poNumber, receiptDate, by: AUTOMATIC }, `the receipt for PO ${po.poNumber}`);
}

async function startEach(rows: Array<{ id: string; invoice_number: string }>, reason: RecheckReason, what: string): Promise<Array<{ id: string; invoiceNumber: string }>> {
  if (rows.length > MAX_PER_TRIGGER) {
    console.warn(`recheck: more than ${MAX_PER_TRIGGER} invoices wait on ${what}; re-checking the oldest ${MAX_PER_TRIGGER}. The rest can be re-checked from each invoice's page.`);
  }
  const started: Array<{ id: string; invoiceNumber: string }> = [];
  for (const row of rows.slice(0, MAX_PER_TRIGGER)) {
    try {
      await startRecheck(row.id, reason);
      started.push({ id: row.id, invoiceNumber: row.invoice_number });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      console.info(`recheck: invoice ${row.id} not re-checked after ${what}: ${e.message}`);
    }
  }
  return started;
}
