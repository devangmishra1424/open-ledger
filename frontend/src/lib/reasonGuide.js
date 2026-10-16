/**
 * Plain-language guide to each reason an invoice can be held. Written for the person deciding, to sit
 * next to the recorded facts: what the code means, why the system cares, what to look at, and how
 * these usually end. It explains the rule; it never decides anything.
 *
 * Wording follows the matching spec (docs/ap-three-way-match-spec.md) and what the engine actually
 * does (lib/matching/decision-matrix.ts). Nothing here is company policy.
 *
 * Every "check" and "usually" names only something a person can do or see inside VeriBook (the
 * tables and the original document on this page, the Orders page, Settings, and the Approve /
 * Reject / Challenge / Check it again actions), never a step VeriBook has no screen for. "Level 2"
 * is the route's own name: there are no reviewer roles, so any reviewer can decide either level.
 */

export const REASON_GUIDE = {
  'EXC-NO_PO': {
    means: 'The invoice names a purchase order that is not on file for this vendor, or one that is closed.',
    why: 'Without an open purchase order there is no agreed price or quantity to check the bill against.',
    check: [
      'Open the original under Source document: is the PO number printed correctly?',
      'Is the order on the Orders page under a slightly different number?',
    ],
    usually: 'If the order exists, add it on Orders or link it with "Check it again", and the whole match runs again. Otherwise approve it as spend authorised without an order, or reject it.',
    engine: 'Always held for a person at level 2.',
  },
  'EXC-NON_PO': {
    means: 'The invoice has no purchase order, so there is nothing to three-way match it against and a person decides it.',
    why: 'No purchase order means nobody has yet confirmed the price, the quantity, or that it was ordered.',
    check: [
      'Read the billed lines and the original under Source document.',
      'Is there an order on the Orders page that this invoice should have quoted?',
    ],
    usually: 'If an order exists, link it with "Check it again" and the match runs. Otherwise approve it if the spend was authorised, or reject it.',
    engine: 'Always held for a person, except a small invoice (up to $100) from a trusted vendor. Over $1,000 it is held at level 2, and over $10,000 it is blocked.',
  },
  'EXC-BEFORE_RCV': {
    means: 'The invoice arrived before the goods or services were recorded as received.',
    why: 'Paying before delivery risks paying for something that never arrives.',
    check: [
      'Look at the Received column in the table below.',
      'On the Orders page, is a delivery against this order recorded yet?',
    ],
    usually: 'Record the delivery on the Orders page when it arrives: the invoice is checked again on its own. Or decide it now: approve to pay in advance, or reject.',
    engine: 'With no receipt on file it is blocked; with a receipt a person decides (level 2 above $1,000, blocked above $10,000).',
  },
  'EXC-PRICE_VAR': {
    means: 'A unit price on the invoice differs from the purchase-order price by more than the allowed tolerance (2% on the line).',
    why: 'Overbilling most often shows up as price drift. Small drift is normal and tolerated; larger drift needs an explanation.',
    check: [
      'Compare the Ordered and Invoiced columns in the table below.',
      'Is it a unit-of-measure difference rather than a real price change?',
    ],
    usually: 'Approve if the new price was agreed, otherwise reject. If you have a reason the AI should weigh, challenge it with that note.',
    engine: 'A difference of 5% or more, or more than $500, is blocked; a smaller one goes to a reviewer.',
  },
  'EXC-QTY_VAR': {
    means: 'The quantity invoiced is more than the quantity received.',
    why: 'Billing for more than was delivered means paying for goods you do not have.',
    check: [
      'Compare Received and Invoiced in the table below. Damaged or rejected deliveries are not counted as received.',
      'On the Orders page, is a later delivery against this order still to be recorded?',
    ],
    usually: 'If the rest has arrived, record it on Orders: the invoice is checked again on its own. Otherwise reject it, or approve it if you accept paying for the full quantity.',
    engine: 'More than 5% over, or more than 2 units, is blocked; a smaller difference goes to a reviewer.',
  },
  'EXC-DUPLICATE': {
    means: 'An invoice with the same vendor and invoice number is already on file.',
    why: 'Paying the same invoice twice is one of the most common accounts-payable losses.',
    check: [
      'Search the inbox for the invoice number and compare the date and amount.',
    ],
    usually: 'Reject the duplicate.',
    engine: 'Saving the same invoice number twice from one vendor is refused when it is entered, so a repeat never reaches matching.',
  },
  'EXC-CREDIT_MEMO': {
    means: 'This is a credit memo: money the vendor owes you, measured against what is still open on the invoice it relates to.',
    why: 'A credit larger than what is left open on the related invoice cannot simply be taken off it.',
    check: [
      'Which invoice does it relate to, and how much of that invoice is still open?',
      'Does the credit amount match the original invoice it corrects?',
    ],
    usually: 'Approve it if the credit is right: it is posted as a reduction of what you owe the vendor, and nothing is paid. Reject it if the credit is wrong.',
    engine: 'Routed as approved when the credit fits inside what is still open on the related invoice (its total less credits already approved against it); a larger credit goes to a reviewer, and so does any credit against an invoice that was rejected. An approved credit is never paid out. It comes off the related invoice’s payment while that invoice is unpaid; what is left over comes off the vendor’s next approved invoices in the same currency, oldest credit first, and the trail says which credit each invoice used.',
  },
  'EXC-PARTIAL': {
    means: 'The invoice covers only part of the purchase order, for example a partial shipment.',
    why: 'A partial bill is normal; what matters is that each line bills no more than arrived.',
    check: [
      'How much of the order is still to come (Ordered against Received in the table below)?',
    ],
    usually: 'Approve it: it bills only what it covers.',
    engine: 'Partial billing is expected, so on its own it is approved automatically. It reaches you only alongside another finding.',
  },
  'EXC-CURRENCY': {
    means: 'The invoice currency differs from the purchase order, or is a currency this system cannot handle.',
    why: 'Amounts in different currencies cannot be compared directly, and this system does not convert between them.',
    check: [
      'Compare the invoice currency with the order currency shown on this page.',
    ],
    usually: 'Approve only if the amount is right in the billed currency; otherwise reject it.',
    engine: 'An unsupported currency is blocked; otherwise a reviewer decides, at level 2 if the exchange rate differs by more than 1%.',
  },
  'EXC-TAX_VAR': {
    means: 'The tax charged on a line does not match the rate of the tax code on that line.',
    why: 'Wrong tax is either an overpayment or a compliance problem.',
    check: [
      'Compare the tax on the invoice (Source document) with the expected rate stated above.',
    ],
    usually: 'Approve if the charged rate is right, otherwise reject.',
    engine: 'A rate difference over 2%, or more than $100 of tax, is blocked; a smaller one goes to a reviewer.',
  },
  'EXC-LAYOUT': {
    means: 'The document could not be read with enough confidence (below 85%).',
    why: 'A misread amount would be paid as it was misread.',
    check: [
      'Compare the billed lines and totals on this page with the original under Source document.',
      'Look at the “Uncertain” notes in the reading step.',
    ],
    usually: 'Approve if every field matches the original; otherwise reject it.',
    engine: 'Always blocked: nothing read with low confidence is paid without a person.',
  },
  'EXC-FRAUD_BANK': {
    means: 'The vendor’s bank account details changed recently.',
    why: 'Redirecting payments to a new account is the most common way payment fraud works. A real vendor will not mind a phone call.',
    check: [
      'Phone the vendor on a number from your own records, not from the invoice or the change request, and record what they said (steps on the right).',
    ],
    usually: 'After a confirmed call and a second person’s sign-off, approve. If they do not confirm, the vendor is flagged and the invoice stays blocked.',
    engine: 'Outranks every other reason and is never auto-approved, whatever the amount. Approval stays locked until the callback is confirmed and signed off.',
  },
  'EXC-BLANKET_EXCEEDED': {
    means: 'Total billed against a blanket purchase order is above its agreed ceiling.',
    why: 'A blanket order lets a vendor bill repeatedly up to a limit; going over means spend nobody approved.',
    check: [
      'How much has already been billed against this order (the Orders page lists its invoices)?',
    ],
    usually: 'Approve it if the higher spend was authorised, otherwise reject it.',
    engine: 'Over the ceiling by up to 10%: held at level 2. By more than 10%: blocked.',
  },
  'EXC-UOM_MISMATCH': {
    means: 'The invoice and the purchase order disagree on the unit of measure (for example boxes against single items) and no conversion is on file for this vendor.',
    why: 'The numbers look wrong or right by accident: ten boxes of twelve is not ten items.',
    check: [
      'Compare the units in the table below with the original under Source document.',
    ],
    usually: 'Approve it if you have confirmed the quantities match, otherwise reject it.',
    engine: 'A line with a different unit is never matched automatically. If a conversion looks plausible a reviewer decides; if not, it is blocked.',
  },
  'EXC-UNMATCHED_LINE': {
    means: 'One or more lines on the invoice are not on the purchase order at all, for example an added fee or an item nobody ordered.',
    why: 'The purchase order is what was agreed. A line outside it is spend nobody approved, even when every other line matches perfectly.',
    check: [
      'Read the extra lines listed in the matching table below.',
      'Is it a line the vendor described differently from the purchase order?',
    ],
    usually: 'Approve if the charge was agreed, otherwise reject it.',
    engine: 'Never approved automatically. Up to $1,000 a reviewer decides; up to $10,000 it is held at level 2; above that it is blocked.',
  },
  INVESTIGATOR_HOLD: {
    means: 'Every rule passed, but the AI reviewer held the invoice for a person: it recommended a stricter outcome, or wrote advice instead of one of the system’s routes.',
    why: 'The AI can only make a decision stricter, never looser. When it raises a concern the rules did not, a person looks before any money moves.',
    check: [
      'Read the AI reviewer’s reasoning in the trail below.',
      'Check the specific concern it names against the invoice and the purchase order.',
    ],
    usually: 'Approve if the concern does not hold up; reject it if it does, or challenge it with a note for the AI.',
    engine: 'Only ever turns an automatic approval into a review. It never approves or rejects anything on its own.',
  },
  R99_AGENT_ERROR: {
    means: 'An automated step failed, so the system could not finish checking this invoice.',
    why: 'The system holds it rather than guessing. The invoice itself may be perfectly fine.',
    check: [
      'Read the reason in the trail below (a provider limit, a timeout, an unreadable response).',
    ],
    usually: 'Use Retry AI review once the cause has passed, or decide it yourself.',
    engine: 'Always held for a person.',
  },
  POLICY_LIMIT: {
    means: 'This invoice matched cleanly but was held because of a limit set on the Settings page: its amount, or how sure the AI reviewer was.',
    why: 'The limit asks for a person to look at anything above that line.',
    check: [
      'The specific limit that was hit is stated above.',
    ],
    usually: 'Approve if you are comfortable, or change the limit in Settings for invoices checked from now on.',
    engine: 'Only ever turns an automatic approval into a review. It never approves anything.',
  },
};

/** Why an invoice that went through on its own did so. */
export const AUTO_APPROVED_GUIDE = {
  means: 'Every automatic check passed, so no person was needed.',
  checks: [
    'The vendor is not flagged and the invoice number is not already on file.',
    'The invoice was read with enough confidence (85% or more).',
    'Each line matched a purchase-order line, with price and quantity inside tolerance.',
    'What is billed does not exceed what was received.',
    'The AI reviewer found nothing to flag, and the amount and confidence were within your Settings limits.',
  ],
};
