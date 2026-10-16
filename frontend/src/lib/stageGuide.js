/**
 * What each step of the pipeline is, in plain words: whether rules or an AI does it, what it checks,
 * why it is there, and when it runs. One place, so an invoice's trail (components/case/Stages.jsx)
 * and the Pipeline page describe a step the same way. The "when" lines follow
 * lib/pipeline/orchestrator.ts (e.g. the second AI check runs only on tier-2 outcomes).
 */

export const KIND_LABEL = {
  rules: { label: 'Rules', title: 'Fixed, deterministic code: the same invoice always gets the same answer' },
  ai: { label: 'AI', title: 'A language model: it recommends, and can only make a decision stricter' },
  mixed: { label: 'Rules, then AI', title: 'A fixed parser first; an AI only when the parser cannot read the document' },
  person: { label: 'Person', title: 'A human decision, recorded under their name' },
};

export const STAGE_GUIDE = {
  extract: {
    name: 'Read the invoice',
    kind: 'mixed',
    what: 'Pulls the vendor, invoice number, dates, lines and totals off the document. A fixed template parser goes first; an AI reads the document only when the template cannot.',
    why: 'Every later step works from these numbers, so it checks itself: the lines must add up to the subtotal, and subtotal plus tax to the total.',
    when: 'Every invoice.',
  },
  validate: {
    name: 'Basic checks',
    kind: 'rules',
    what: 'Six quick gates before any matching: the document is readable, it is not a duplicate, the vendor is active, the currency is supported, the date is plausible and the required fields are there.',
    why: 'Certain, cheap checks first. A duplicate or an unreadable bill is stopped before anything else runs.',
    when: 'Every invoice.',
  },
  match: {
    name: 'Three-way match',
    kind: 'rules',
    what: 'Pairs each invoice line with a purchase-order line, then compares the price (2% is tolerated), the quantity against what arrived in good condition, and any line nobody ordered. It also checks bank-detail changes, credit memos, currency and blanket-order ceilings.',
    why: 'The core control of accounts payable: pay only for what was ordered, at the agreed price, and actually delivered.',
    when: 'Every invoice that passed the basic checks.',
  },
  investigate: {
    name: 'AI review',
    kind: 'ai',
    what: 'An AI agent looks up the vendor’s history, possible duplicates and past corrections with real tools, then recommends an outcome and gives its reasons.',
    why: 'It sees context the rules cannot, such as a brand-new vendor or a suspicious pattern. It can only make a decision stricter, never looser.',
    when: 'Every invoice the rules did not stop outright.',
  },
  verify: {
    name: 'Second AI check',
    kind: 'ai',
    what: 'A different AI model, from another model family, checks the first AI’s conclusion independently.',
    why: 'Two different models rarely make the same mistake. If they disagree, the stricter view wins.',
    when: 'Only on serious cases: when the outcome would be a senior review or a block.',
  },
  policy: {
    name: 'Approval rules',
    kind: 'rules',
    what: 'Combines every finding into one outcome (the most severe wins), applies the dollar thresholds, then your Settings limits: the largest invoice that may pass on its own, and the minimum AI confidence.',
    why: 'One place decides the route, by fixed rules, so the same invoice always gets the same answer.',
    when: 'Every invoice.',
  },
  audit: {
    name: 'Post and record',
    kind: 'rules',
    what: 'On approval, posts the journal entry and sends the payment (simulated). In every case, writes the final record into the tamper-evident trail.',
    why: 'Nothing is paid without a record, and no record can be changed without it showing.',
    when: 'Every invoice, as its last automatic step.',
  },
  human_review: {
    name: 'A person decided',
    kind: 'person',
    what: 'A reviewer approved, rejected or challenged it. Their name and note go into the same trail as the automatic steps.',
    why: 'The system decides the route; for anything it holds, a person makes the call.',
    when: 'Whenever someone acts on the invoice.',
  },
  audit_assemble: {
    name: 'Handed to an auditor',
    kind: 'person',
    what: 'This invoice was linked to an auditor’s evidence request on the Audit page.',
    why: 'Auditors get the invoice together with its full, verifiable trail.',
    when: 'When someone links it to an auditor request.',
  },
};

/** The six validation gates, as the reviewer would say them. */
export const GATE_WORDS = {
  readability: 'Document readable',
  duplicate: 'Not a duplicate of an earlier invoice',
  vendor_status: 'Vendor active and allowed to bill',
  currency: 'Currency supported',
  invoice_date: 'Invoice date plausible',
  mandatory_fields: 'Required fields present',
};
