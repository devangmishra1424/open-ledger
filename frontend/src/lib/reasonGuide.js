/**
 * Plain-language guide to each reason an invoice can be held. Written for the person deciding, to sit
 * next to the recorded facts: what the code means, why the system cares, what to look at, and how
 * these usually end. It explains the rule; it never decides anything.
 *
 * Wording follows the matching spec (docs/ap-three-way-match-spec.md) and what the engine actually
 * does (lib/matching/decision-matrix.ts). Nothing here is company policy.
 */

export const REASON_GUIDE = {
  'EXC-NO_PO': {
    means: 'The invoice points at a purchase order that does not exist, is not open, or is not approved for this vendor.',
    why: 'Without an approved purchase order there is no agreed price or quantity to check the bill against.',
    check: [
      'Is the PO number a typo, or missing from the invoice?',
      'Was this spend approved some other way (a contract, an email)?',
      'Does the vendor’s order exist under a different number?',
    ],
    usually: 'Ask the vendor for the right PO, or approve it as an unplanned (non-PO) purchase if it was legitimately authorised.',
    engine: 'Always goes to a senior reviewer.',
  },
  'EXC-NON_PO': {
    means: 'The invoice has no purchase order. It cannot be three-way matched, so it is routed for a person to confirm and code it.',
    why: 'No purchase order means nobody has yet confirmed the price, the quantity, or that it was ordered.',
    check: [
      'Who asked for this, and was it budgeted?',
      'Which expense account should it be coded to?',
      'Is the vendor one you expect to bill without a PO (rent, utilities, subscriptions)?',
    ],
    usually: 'Approve with the right coding if the spend was authorised; otherwise reject.',
    engine: 'Always reviewed by a person; the one exception is a small invoice (up to $100) from a whitelisted vendor. Over $1,000 goes to a senior reviewer, and over $10,000 is blocked.',
  },
  'EXC-BEFORE_RCV': {
    means: 'The invoice arrived before the goods or services were recorded as received.',
    why: 'Paying before delivery risks paying for something that never arrives.',
    check: [
      'Has the delivery actually happened but not been recorded yet?',
      'Does the vendor invoice in advance by agreement?',
    ],
    usually: 'Wait for the receiving record, then re-check. Pay in advance only if that was agreed.',
    engine: 'With no receipt on file it is blocked; with a receipt it goes to a reviewer.',
  },
  'EXC-PRICE_VAR': {
    means: 'A unit price on the invoice differs from the purchase-order price by more than the allowed tolerance (2% on the line).',
    why: 'Overbilling most often shows up as price drift. Small drift is normal and tolerated; larger drift needs an explanation.',
    check: [
      'Was a price change agreed in writing?',
      'Is it a currency or unit-of-measure issue rather than a real price change?',
      'Compare the Ordered and Invoiced columns in the table below.',
    ],
    usually: 'Approve if the new price was agreed; otherwise reject, or ask the vendor for a credit note.',
    engine: 'A difference of 5% or more, or more than $500, is blocked; a smaller one goes to a reviewer.',
  },
  'EXC-QTY_VAR': {
    means: 'The quantity invoiced differs from the quantity received.',
    why: 'Billing for more than was delivered means paying for goods you do not have.',
    check: [
      'Compare Received and Invoiced in the table below. Damaged or rejected deliveries are not counted as received.',
      'Is the rest of the delivery still on its way?',
    ],
    usually: 'Pay what was received and ask for a corrected invoice, or approve once the remaining delivery is recorded.',
    engine: 'More than 5% over, or more than 2 units, is blocked; a smaller difference goes to a reviewer.',
  },
  'EXC-DUPLICATE': {
    means: 'This looks like an invoice you have already received: the same number, or a near-identical number, amount and date.',
    why: 'Paying the same invoice twice is one of the most common accounts-payable losses.',
    check: [
      'Open the earlier invoice and compare number, date and amount.',
      'Is this a genuine second bill for a repeat order?',
    ],
    usually: 'Reject the duplicate.',
    engine: 'Rejected automatically, every time. It is checked before any matching.',
  },
  'EXC-CREDIT_MEMO': {
    means: 'This is a credit memo: money the vendor owes you, which has to be netted against an open or future invoice from the same vendor.',
    why: 'A credit that is not applied is money left on the table, and applying it to the wrong invoice hides the real balance.',
    check: [
      'Which invoice does it relate to?',
      'Does the credit amount match what the vendor agreed?',
    ],
    usually: 'Apply it against the related invoice and approve.',
    engine: 'Approved automatically when the credit fits inside the invoice it nets against; a credit larger than that goes to a reviewer.',
  },
  'EXC-PARTIAL': {
    means: 'The invoice covers only part of the purchase order: a partial shipment, or an explicit partial payment.',
    why: 'A partial bill is normal, but the rest of the order needs tracking so it is neither forgotten nor billed twice.',
    check: [
      'How much of the order is still to come?',
      'Is this marked as the final delivery?',
    ],
    usually: 'Approve the part that was delivered.',
    engine: 'Partial billing is expected, so on its own it is approved automatically. It reaches you only alongside another finding.',
  },
  'EXC-CURRENCY': {
    means: 'The invoice currency differs from the purchase order or the receipt, or is a currency this system cannot handle.',
    why: 'Amounts in different currencies cannot be compared directly, and this system does not convert.',
    check: [
      'Was the order placed in a different currency from the one billed?',
      'What exchange rate applies, and who agreed it?',
    ],
    usually: 'Ask the vendor to reissue in the order currency, or have finance handle the conversion.',
    engine: 'An unsupported currency is blocked; otherwise a reviewer decides, and a senior reviewer if the exchange rate differs by more than 1%.',
  },
  'EXC-TAX_VAR': {
    means: 'The tax charged does not match the expected rate for this jurisdiction.',
    why: 'Wrong tax is either an overpayment or a compliance problem.',
    check: [
      'Is the vendor charging the right rate for the place and the goods?',
      'Is the vendor tax-exempt or a reseller?',
    ],
    usually: 'Ask the vendor to correct the tax, or approve if the different rate is right.',
    engine: 'A rate difference over 2%, or more than $100 of tax, is blocked; a smaller one goes to a reviewer.',
  },
  'EXC-LAYOUT': {
    means: 'The document could not be read with enough confidence (below 85%).',
    why: 'A misread amount would be paid as it was misread.',
    check: [
      'Compare the fields in the table below with the original document.',
      'Look at the “Uncertain” notes in the extraction step.',
    ],
    usually: 'Ask for a cleaner copy, or correct and re-submit it.',
    engine: 'Always blocked: a document that cannot be read cannot be processed.',
  },
  'EXC-FRAUD_BANK': {
    means: 'The vendor’s bank account details changed recently.',
    why: 'Redirecting payments to a new account is the most common way payment fraud works. A real vendor will not mind a phone call.',
    check: [
      'Phone the vendor on a number from your own records, not from the invoice or the change request.',
      'Ask them to confirm they asked for the change.',
    ],
    usually: 'After a confirmed call and a second person’s sign-off, approve. If they do not confirm, the vendor is flagged and the invoice stays blocked.',
    engine: 'Outranks every other reason and is never auto-approved, whatever the amount. Nothing is paid until the check is complete.',
  },
  'EXC-BLANKET_EXCEEDED': {
    means: 'Total billed against a blanket purchase order is above its agreed ceiling.',
    why: 'A blanket order lets a vendor bill repeatedly up to a limit; going over means spend nobody approved.',
    check: [
      'How much has already been billed against this order?',
      'Was the ceiling raised and not updated?',
    ],
    usually: 'Approve only with the extension authorised, otherwise reject the excess.',
    engine: 'Over the ceiling by up to 10%: a senior reviewer decides. By more than 10%: blocked.',
  },
  'EXC-UOM_MISMATCH': {
    means: 'The invoice and the purchase order disagree on the unit of measure (for example boxes against single items) and there is no conversion on file.',
    why: 'The numbers look wrong or right by accident: ten boxes of twelve is not ten items.',
    check: [
      'What unit does the vendor mean on the invoice?',
      'Is there a known conversion (12 per box)?',
    ],
    usually: 'Confirm the conversion, record it, then approve.',
    engine: 'A line with a different unit is never matched automatically. If a conversion looks plausible a reviewer decides; if not, it is blocked.',
  },
  R99_AGENT_ERROR: {
    means: 'An automated step failed, so the system could not finish checking this invoice.',
    why: 'The system holds it rather than guessing. The invoice itself may be perfectly fine.',
    check: [
      'Read the reason in the trail below (a provider limit, a timeout, an unreadable response).',
      'Try Retry AI review once the cause has passed.',
    ],
    usually: 'Retry the automated review, or decide it yourself.',
    engine: 'Always held for a person.',
  },
  POLICY_LIMIT: {
    means: 'This invoice matched cleanly but was held because of a limit set on the Settings page: its amount, or how sure the AI reviewer was.',
    why: 'You asked for a person to look at anything above that line.',
    check: [
      'The specific limit that was hit is stated above.',
    ],
    usually: 'Approve if you are comfortable, or change the limit in Settings for the future.',
    engine: 'Only ever turns an automatic approval into a review. It never approves anything.',
  },
};

/** Why an invoice that went through on its own did so. */
export const AUTO_APPROVED_GUIDE = {
  means: 'Every automatic check passed, so no person was needed.',
  checks: [
    'The vendor is in good standing and this is not a duplicate.',
    'The invoice was read with enough confidence (85% or more).',
    'Each line matched a purchase-order line, with price and quantity inside tolerance.',
    'What is billed does not exceed what was received.',
    'The AI reviewer found nothing to flag, and the amount and confidence were within your Settings limits.',
  ],
};
