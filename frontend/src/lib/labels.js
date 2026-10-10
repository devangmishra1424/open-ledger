/** Plain-language wording for the machine's codes. One place, so the whole UI speaks the same way. */

export const STAGE_HELP = {
  extract: 'Reads the invoice',
  validate: 'Basic checks',
  match: 'Compares invoice, purchase order and delivery',
  investigate: 'AI looks into anything unusual',
  verify: 'A second AI double-checks',
  policy: 'Applies the approval rules',
  audit: 'Posts to the ledger and pays',
  human_review: 'A person decided',
};

const ACTION_WORDS = {
  parsed: 'Read structured data',
  extracted: 'Read from the document',
  pass: 'Passed all checks',
  block: 'Blocked',
  block_fraud_flag: 'Blocked: fraud flag',
  escalate_l1: 'Sent to a reviewer',
  escalate_l2: 'Sent to a senior reviewer',
  auto_approve: 'Approved automatically',
  auto_reject: 'Rejected automatically',
  error: 'Failed',
  disagreement: 'Disagreed with the first AI',
  payment_failed: 'Payment did not go out',
  human_approved: 'Approved',
  human_rejected: 'Rejected',
  human_contested: 'Challenged',
};

/** Models write actions as "auto-approve" or with a non-breaking hyphen; the engine writes auto_approve. One spelling for lookups. */
export function normalizeAction(action) {
  return action ? action.trim().toLowerCase().replace(/[-\u2010-\u2015\s]+/g, '_') : action;
}

export function actionWords(action) {
  if (!action) return 'No action recorded';
  const key = normalizeAction(action);
  return ACTION_WORDS[key] ?? key.replace(/_/g, ' ');
}

/** The headline result of one recorded step, worded for what that kind of step does. */
export function outcomeWords(decision) {
  const a = normalizeAction(decision.actionTaken);
  if (a === 'error') return 'Failed';
  if (decision.nodeId === 'audit' && a === 'auto_approve') return 'Posted to the ledger and paid';
  if (decision.nodeId === 'audit' && ['block', 'block_fraud_flag', 'escalate_l1', 'escalate_l2'].includes(a)) return 'Not posted: held for a person';
  if (decision.nodeId === 'audit' && a === 'auto_reject') return 'Not posted: rejected';
  if (decision.nodeId === 'policy') return `Decided: ${actionWords(a).toLowerCase()}`;
  if (decision.nodeId === 'investigate') return `Recommended: ${actionWords(a).toLowerCase()}`;
  if (decision.nodeId === 'verify') return a === 'disagreement' ? 'Disagreed with the first AI' : `Agreed: ${actionWords(a).toLowerCase()}`;
  return actionWords(a);
}

/** Who/what produced a decision, for display: a model id, an engine, or a person. */
export function actorWords(decision) {
  if (decision.actor?.startsWith('human:')) return decision.actor.slice('human:'.length);
  if (decision.model) return decision.model;
  if (decision.actor === 'template-parser') return 'Template parser';
  if (decision.actor === 'deterministic-parser') return 'Structured input';
  if (decision.actor === 'deterministic-validator') return 'Rules engine';
  if (decision.actor === 'deterministic-matching-engine') return 'Matching engine';
  if (decision.actor === 'deterministic-policy-engine') return 'Policy engine';
  return decision.actor || 'System';
}

export const STATE_LABEL = {
  processing: 'Processing',
  needs_attention: 'Needs attention',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};

export function formatMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // An unknown currency code from a document: show the number and the code rather than throwing in render.
    return `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${currency}`;
  }
}

export function timeAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : '';
}
