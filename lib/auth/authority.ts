import type { Account } from "@/lib/auth/accounts";

/**
 * Who may approve which invoice, when people sign in (VERIBOOK_USERS). An auditor checks exactly this: that payments
 * were approved by someone allowed to, within their limit, and never by the person who entered the invoice
 * (segregation of duties). In open mode (no sign-in) there are no accounts and this is not applied: names are typed.
 * Pure: the caller passes the account, the invoice's amount and currency, and who entered it.
 */
export function approvalRefusal(account: Pick<Account, "name" | "role" | "approvalLimits">, invoice: { amount: number; currency: string; enteredBy: string | null }): string | null {
  if (account.role === "clerk") return `${account.name} is a clerk: clerks enter and challenge invoices, an approver approves them`;
  if (invoice.enteredBy && invoice.enteredBy.trim().toLowerCase() === account.name.trim().toLowerCase()) {
    return `${account.name} entered this invoice, so a different person must approve it (segregation of duties)`;
  }
  const limit = account.role === "admin" ? undefined : account.approvalLimits[invoice.currency];
  if (limit !== undefined && invoice.amount > limit) {
    return `${invoice.currency} ${invoice.amount.toFixed(2)} is over ${account.name}'s approval limit of ${invoice.currency} ${limit.toFixed(2)}; someone with a higher limit must approve it`;
  }
  return null;
}
