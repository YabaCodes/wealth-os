// Pure special-project accounting helpers.
// No IndexedDB or DOM dependency: keep project arithmetic directly testable.

export const PROJECT_CATEGORIES = ["Hotel", "Car Rental", "Food", "Gas", "Transport", "Business", "Other"];
export const PROJECT_CURRENCIES = ["EUR", "TWD", "USD", "GBP", "CHF", "JPY"];

export function projectExpensesFor(projectExpenses, projectId) {
  return (projectExpenses || [])
    .filter((x) => x.projectId === projectId && !x.deletedAt)
    .sort(
      (a, b) =>
        String(b.date || "").localeCompare(String(a.date || "")) ||
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    );
}

export function projectKnownTwd(projectExpenses, projectId) {
  return projectExpensesFor(projectExpenses, projectId).reduce(
    (sum, x) => sum + (Number.isFinite(Number(x.twdAmount)) ? Number(x.twdAmount || 0) : 0),
    0,
  );
}

export function projectMissingTwd(projectExpenses, projectId) {
  return projectExpensesFor(projectExpenses, projectId).filter(
    (x) => !Number.isFinite(Number(x.twdAmount)) || Number(x.twdAmount) <= 0,
  );
}

export function projectPaymentTwd(projectExpenses, projectId, method) {
  return projectExpensesFor(projectExpenses, projectId)
    .filter((x) => x.paymentMethod === method && Number(x.twdAmount) > 0)
    .reduce((sum, x) => sum + Number(x.twdAmount || 0), 0);
}

export function projectOriginalTotals(projectExpenses, projectId) {
  const out = {};
  for (const x of projectExpensesFor(projectExpenses, projectId)) {
    const currency = x.currency || "TWD";
    out[currency] = (out[currency] || 0) + Number(x.originalAmount || 0);
  }
  return out;
}

export function formatOriginal(amount, currency) {
  const n = Number(amount || 0);
  return `${currency || "TWD"} ${n.toLocaleString(undefined, {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
