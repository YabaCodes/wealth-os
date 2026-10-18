// Shared, read-only reconciliation projections.
// These are the same date/stamp and physical-ledger rules used by the Wealth
// Overview and wealthMetrics. No browser APIs, writes or mutable app state.

export function latestReconciliationFor(reconciliations, accountId) {
  return (
    [...reconciliations]
      .filter((r) => r.accountId === accountId && !r.deletedAt)
      .sort((a, b) => `${a.date || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.createdAt || ""}`))
      .at(-1) || null
  );
}

export function recordAfterReconciliation(rec, effectiveDate, stamp) {
  const rd = String(rec?.date || ""),
    ed = String(effectiveDate || "");
  if (ed > rd) return true;
  if (ed < rd) return false;
  return String(stamp || "") > String(rec?.createdAt || "");
}

export function physicalDeltaSinceReconciliation(accountId, rec, { incomes = [], expenses = [], transfers = [], adjustments = [] }) {
  let delta = 0;
  for (const x of incomes) {
    if (
      !x.deletedAt &&
      x.accountId === accountId &&
      recordAfterReconciliation(rec, x.dateReceived || x.date, x.createdAt || x.updatedAt)
    )
      delta += Number(x.amount || 0);
  }
  for (const x of expenses) {
    if (
      !x.deletedAt &&
      x.accountId === accountId &&
      recordAfterReconciliation(rec, x.dateReceived || x.date, x.createdAt || x.updatedAt)
    )
      delta -= Number(x.amount || 0);
  }
  for (const t of transfers) {
    if (t.deletedAt || t.status !== "completed") continue;
    const purposeOnly =
      t.affectsPhysicalBalance === false ||
      t.fromAccountId === t.toAccountId ||
      ["bucket_allocation", "reserve_allocation"].includes(t.transferType);
    if (
      purposeOnly ||
      !recordAfterReconciliation(rec, t.completedDate || t.plannedDate, t.completedAt || t.updatedAt || t.createdAt)
    )
      continue;
    if (t.toAccountId === accountId) delta += Number(t.amount || 0);
    if (t.fromAccountId === accountId) delta -= Number(t.amount || 0);
  }
  for (const a of adjustments) {
    if (!a.deletedAt && a.accountId === accountId && recordAfterReconciliation(rec, a.date, a.createdAt || a.updatedAt))
      delta += Number(a.amount || 0);
  }
  return delta;
}

export function accountSnapshotFor(accountId, accountBalances, reconciliations, ledgers) {
  const rawExpected = Number(accountBalances[accountId] || 0);
  const rec = latestReconciliationFor(reconciliations, accountId);
  if (!rec)
    return {
      accountId,
      expected: rawExpected,
      rawExpected,
      actual: rawExpected,
      difference: 0,
      verified: false,
      reconciliation: null,
      isEstimated: false,
      ledgerDeltaSinceCheck: 0,
    };
  // The exact bank check is the baseline. Only physical activity after that
  // check can roll its balance forward; older adjustments must not count twice.
  const ledgerDeltaSinceCheck = physicalDeltaSinceReconciliation(accountId, rec, ledgers);
  const tracked = Number(rec.actualBalance || 0) + ledgerDeltaSinceCheck;
  return {
    accountId,
    expected: tracked,
    rawExpected,
    actual: tracked,
    difference: 0,
    verified: true,
    reconciliation: rec,
    isEstimated: Math.abs(ledgerDeltaSinceCheck) >= 0.5,
    ledgerDeltaSinceCheck,
  };
}

export function esunSnapshotFor(base, buckets, bucketBalances) {
  const virtualTotal = buckets
    .filter((b) => b.accountId === "esun")
    .reduce((sum, b) => sum + Number(bucketBalances[b.id] || 0), 0);
  const unassigned = base.actual - virtualTotal;
  return {
    ...base,
    virtualTotal,
    unassigned,
    allocationOk: Math.abs(unassigned) < 0.5,
    bankOk: Math.abs(base.difference) < 0.5,
  };
}
