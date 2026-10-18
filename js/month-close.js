// Close-readiness calculations and fail-atomic month-close/reopen persistence.
// Shared by the live controller and synthetic IndexedDB regression tests.
import { atomicStoreUpdate } from "./db.js";
import { money } from "./calc.js";

/** Preserve the original month-close decision matrix and its exact blocker text. */
export function assessMonthClose({
  p, plan, totals, sweep, pending, missingFixed, ct, es,
  reserveFunded, titheAllocated, titheExpected, payday,
}) {
  const fundingOk = reserveFunded + 0.5 >= plan.sinking && payday.totalOutstanding <= 0.5;
  const bankOk = ct.verified && Math.abs(ct.difference) < 0.5 && es.verified && es.bankOk && es.allocationOk;
  const hardBlockers = [];
  if (pending.length)
    hardBlockers.push(`${pending.length} planned transfer${pending.length === 1 ? "" : "s"} still pending`);
  if (sweep.available > 0.5) hardBlockers.push(`${money(sweep.available)} still available to sweep`);
  if (sweep.overSwept > 0.5)
    hardBlockers.push(`${money(sweep.overSwept)} was swept beyond the current available amount`);
  if (!fundingOk) hardBlockers.push("payday allocations are incomplete");
  if (titheAllocated + 0.5 < titheExpected)
    hardBlockers.push(`${money(titheExpected - titheAllocated)} of tithe is not yet allocated`);
  if (!bankOk) hardBlockers.push("bank reconciliation or E.SUN purpose allocation is incomplete");
  return {
    p, plan, totals, sweep, pending, missingFixed, ct, es,
    reserveFunded, titheAllocated, titheExpected, payday,
    fundingOk, bankOk, hardBlockers, ready: hardBlockers.length === 0,
  };
}

/**
 * Persist the period close flag and the full month-end snapshot together.
 * Reject stale dialogs and duplicate closes; no partial period/snapshot pair.
 * Re-closing a deliberately reopened month replaces that month's old snapshot.
 */
export async function closeMonthAtomic({ period, snapshot, stamp }) {
  if (!period?.id || !snapshot || snapshot.id !== period.id ||
      snapshot.budgetPeriodId !== period.id || snapshot.status !== "closed")
    throw new Error("Invalid month-close snapshot.");
  await atomicStoreUpdate(["periods", "monthlyCloses"], (data, store) => {
    const current = data.periods.find((row) => row.id === period.id);
    if (!current) throw new Error("Funding month no longer exists.");
    if (current.state === "closed")
      throw new Error("Funding month is already closed.");
    if (JSON.stringify(current) !== JSON.stringify(period))
      throw new Error("Funding month changed. Reopen the close preview.");
    const prior = data.monthlyCloses.find((row) => row.id === period.id);
    if (prior && prior.status === "closed")
      throw new Error("A closed month-end snapshot already exists.");
    store("periods").put({
      ...current, state: "closed", closedAt: stamp, updatedAt: stamp,
      sweepRules: snapshot.sweepRules,
    });
    store("monthlyCloses").put(snapshot);
  });
}

/**
 * Reactivate a closed funding month and update the existing close-record status
 * in the same transaction. Keep its financial snapshot frozen for audit history.
 */
export async function reopenMonthAtomic(periodId, stamp) {
  if (!periodId) throw new Error("Funding month ID is required.");
  await atomicStoreUpdate(["periods", "monthlyCloses"], (data, store) => {
    const current = data.periods.find((row) => row.id === periodId);
    if (!current || current.state !== "closed")
      throw new Error("Funding month is not closed.");
    const snapshot = data.monthlyCloses.find(
      (row) => row.budgetPeriodId === periodId || row.id === periodId
    );
    store("periods").put({ ...current, state: "reopened", reopenedAt: stamp, updatedAt: stamp });
    if (snapshot)
      store("monthlyCloses").put({ ...snapshot, status: "reopened", reopenedAt: stamp });
  });
}
