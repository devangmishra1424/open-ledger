import type { ToolDef } from "@/lib/agent/tools";

/**
 * The AI document reader's one tool: its structured answer. Kept apart from lib/agent/tools.ts, whose evidence
 * tools query the database, so reading a document never needs a database connection (the scorer in
 * eval/documents/ and the unit tests run without one).
 */
function submissionTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { type: "function", name, description, strict: true, parameters: { type: "object", properties, required, additionalProperties: false } };
}

/** The document path's richer reading (lib/documents/invoice.ts): tax lines, charges, discount, round off. */
export const SUBMIT_INVOICE_READING: ToolDef = submissionTool(
  "submit_invoice_reading",
  "Submit what the invoice says. This must be your last action in this turn.",
  {
    vendor_name: { type: ["string", "null"] },
    vendor_tax_id: { type: ["string", "null"] },
    invoice_number: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    po_reference: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" }, quantity: { type: "number" }, unit_price: { type: "number" }, amount: { type: ["number", "null"] } },
        required: ["description", "quantity", "unit_price", "amount"],
        additionalProperties: false,
      },
    },
    subtotal: { type: ["number", "null"] },
    tax_lines: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, amount: { type: "number" } }, required: ["label", "amount"], additionalProperties: false },
    },
    other_charges: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, amount: { type: "number" } }, required: ["label", "amount"], additionalProperties: false },
    },
    discount: { type: ["number", "null"] },
    round_off: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    uncertain_fields: { type: "array", items: { type: "string" } },
  },
  [
    "vendor_name", "vendor_tax_id", "invoice_number", "invoice_date", "due_date", "po_reference", "currency", "line_items",
    "subtotal", "tax_lines", "other_charges", "discount", "round_off", "total", "uncertain_fields",
  ],
);
