import { HttpError } from "@/lib/http";
import { BankChangeConflict, BankChangeNotFound } from "@/lib/ledger/bank-change-review";

/** Runs a bank-change-review operation and maps its typed domain errors to HTTP 404 / 409; anything else propagates (-> 500, logged). */
export async function bankChangeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BankChangeNotFound) throw new HttpError(404, e.message);
    if (e instanceof BankChangeConflict) throw new HttpError(409, e.message);
    throw e;
  }
}
