// Pure Special Budget / Business Trip helpers.
// No DOM or IndexedDB dependencies.

export const BUSINESS_TRIP_EXACT_CATEGORIES = [
  ["visa_application_fee", "VISA Application Fee"],
  ["visa_delivery_fee", "Visa Delivery Fee"],
  ["car_rental", "Car Rental"],
  ["hotel_rental", "Hotel Rental"],
  ["sim_card", "SIM Card"],
  ["foreign_exchange_fee", "Foreign Exchange Fee"],
  ["train_ticket", "Train Ticket"],
  ["uber_fee", "Uber Fee"],
  ["city_tax", "City Tax"],
  ["parking_ticket", "Parking Ticket"],
  ["gas_refill", "Gas Refill"],
];

export const BUSINESS_TRIP_FLEXIBLE_CATEGORIES = [
  ["personal_expenses", "Personal Expenses"],
  ["food", "Food"],
  ["shopping", "Shopping"],
  ["others", "Others"],
];

export function businessTripCategoryRules() {
  return [
    ...BUSINESS_TRIP_EXACT_CATEGORIES.map(([id, name]) => ({ id, name, treatment: "exact" })),
    ...BUSINESS_TRIP_FLEXIBLE_CATEGORIES.map(([id, name]) => ({ id, name, treatment: "flexible" })),
  ];
}

/**
 * Choose the initial category for a Special Budget entry.
 * New entries prefer Food when that category is configured. Existing entries
 * keep their recorded category, and projects without Food use their first rule.
 * This is a form-only preference: it never rewrites stored transactions.
 */
export function preferredProjectEntryCategoryId(rules, expense = null) {
  const available = Array.isArray(rules) ? rules : [];
  if (expense) {
    return expense.categoryId ||
      available.find((rule) => rule.name === expense.category)?.id ||
      available[0]?.id || "other";
  }
  const food = available.find((rule) =>
    String(rule.id || "").trim().toLowerCase() === "food" ||
    String(rule.name || "").trim().toLowerCase() === "food"
  );
  return food?.id || available[0]?.id || "other";
}

export function categoryRuleFor(project, expense) {
  const rules = Array.isArray(project?.categoryRules)
    ? project.categoryRules
    : project?.type === "business_trip"
      ? businessTripCategoryRules()
      : [];
  const byId = rules.find((x) => x.id === expense?.categoryId);
  if (byId) return byId;
  const byName = rules.find((x) => String(x.name || "").toLowerCase() === String(expense?.category || "").toLowerCase());
  return byName || null;
}

function parseIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayDiff(a, b) {
  const x = parseIsoDate(a), y = parseIsoDate(b);
  if (!x || !y) return null;
  return Math.round((y - x) / 86400000);
}

export function allowanceDays(startDate, endDate) {
  const diff = dayDiff(startDate, endDate);
  if (diff === null || diff < 0) return 0;
  return Math.max(1, diff);
}

export function totalFlexibleAllowance(project) {
  if (project?.type === "business_trip") {
    return allowanceDays(project.startDate, project.endDate) * Number(project.dailyAllowanceTwd || 0);
  }
  return Math.max(0, Number(project?.flexibleCapTwd || 0));
}

export function elapsedAllowanceDays(project, currentDate) {
  if (!project?.startDate || !project?.endDate) return 0;
  const total = allowanceDays(project.startDate, project.endDate);
  if (!total) return 0;
  const current = currentDate || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const fromStart = dayDiff(project.startDate, current);
  const toEnd = dayDiff(current, project.endDate);
  if (fromStart === null || toEnd === null) return 0;
  if (fromStart < 0) return 0;
  if (toEnd < 0) return total;
  if (current === project.startDate && current === project.endDate) return total;
  if (current === project.startDate) return Math.min(total, 0.5);
  if (current === project.endDate) return total;
  return Math.min(total, Math.max(0, fromStart + 0.5));
}

export function isRefundableDeposit(expense) {
  return expense?.recordType === "refundable_deposit";
}

export function depositResolved(expense) {
  if (!isRefundableDeposit(expense)) return true;
  return ["refunded", "partial", "retained"].includes(expense.depositStatus);
}

export function effectiveTwd(expense) {
  if (!expense || expense.deletedAt) return 0;
  if (!isRefundableDeposit(expense)) {
    const n = Number(expense.twdAmount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (!depositResolved(expense) || expense.depositStatus === "refunded") return 0;
  const n = Number(expense.retainedTwd);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function missingTwd(expense) {
  if (!expense || expense.deletedAt) return false;
  if (isRefundableDeposit(expense)) {
    if (!depositResolved(expense)) return false;
    if (expense.depositStatus === "refunded") return false;
    const n = Number(expense.retainedTwd);
    return !(Number.isFinite(n) && n > 0);
  }
  const n = Number(expense.twdAmount);
  return !(Number.isFinite(n) && n > 0);
}

export function unresolvedDeposits(expenses) {
  return (expenses || []).filter((x) => !x.deletedAt && isRefundableDeposit(x) && !depositResolved(x));
}

export function projectCategoryBreakdown(project, expenses, treatment) {
  const rules = (Array.isArray(project?.categoryRules) && project.categoryRules.length
    ? project.categoryRules
    : project?.type === "business_trip"
      ? businessTripCategoryRules()
      : []
  ).filter((rule) => rule.treatment === treatment);

  const totals = new Map(rules.map((rule) => [rule.id, { ...rule, amount: 0, count: 0 }]));
  for (const expense of expenses || []) {
    if (!expense || expense.deletedAt) continue;
    if (isRefundableDeposit(expense) && !depositResolved(expense)) continue;
    const rule = categoryRuleFor(project, expense);
    const rowTreatment = expense.reimbursementType || rule?.treatment || "tracking";
    if (rowTreatment !== treatment) continue;
    const id = rule?.id || expense.categoryId || String(expense.category || "other").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const current = totals.get(id) || {
      id,
      name: rule?.name || expense.category || "Other",
      treatment,
      amount: 0,
      count: 0,
    };
    current.amount += effectiveTwd(expense);
    current.count += 1;
    totals.set(id, current);
  }
  return [...totals.values()];
}


/**
 * Composition-only presentation data. Exact claims use the sum of confirmed category
 * expenses (100% of claims); flexible spending uses the fixed shared allowance as
 * capacity and adds the unspent remainder. If spending exceeds the allowance the bar
 * is normalized to actual spend, while the overage remains available separately.
 *
 * Pending refundable holds are excluded upstream by projectCategoryBreakdown.
 */
export function projectCompositionBreakdown(rows, allowance = null) {
  const used = (rows || [])
    .filter((row) => Number.isFinite(Number(row?.amount)) && Number(row.amount) > 0)
    .map((row) => ({ ...row, amount: Number(row.amount) }));
  const spent = used.reduce((sum, row) => sum + row.amount, 0);
  const isAllowance = typeof allowance === "number" && Number.isFinite(allowance) && allowance >= 0;
  const cap = isAllowance ? allowance : null;
  const remaining = isAllowance ? Math.max(0, cap - spent) : 0;
  const over = isAllowance ? Math.max(0, spent - cap) : 0;
  const visualTotal = isAllowance ? Math.max(cap, spent) : spent;
  const segments = used.map((row) => ({
    ...row,
    barPct: visualTotal > 0 ? (row.amount / visualTotal) * 100 : 0,
    claimPct: spent > 0 ? (row.amount / spent) * 100 : 0,
    allowancePct: isAllowance && cap > 0 ? (row.amount / cap) * 100 : null,
    isRemaining: false,
  }));
  if (remaining > 0) {
    segments.push({
      id: "__remaining",
      name: "Remaining",
      amount: remaining,
      count: 0,
      barPct: visualTotal > 0 ? (remaining / visualTotal) * 100 : 0,
      claimPct: 0,
      allowancePct: cap > 0 ? (remaining / cap) * 100 : 0,
      isRemaining: true,
    });
  }
  return { spent, cap, remaining, over, visualTotal, segments };
}

export function projectBudgetSummary(project, expenses, currentDate) {
  const rows = (expenses || []).filter((x) => !x.deletedAt);
  let exact = 0, flexible = 0, tracking = 0, depositsPending = 0, depositsPendingTwd = 0;
  for (const x of rows) {
    if (isRefundableDeposit(x) && !depositResolved(x)) {
      depositsPending += 1;
      const hold = Number(x.twdAmount);
      if (Number.isFinite(hold) && hold > 0) depositsPendingTwd += hold;
      continue;
    }
    const amount = effectiveTwd(x);
    const rule = categoryRuleFor(project, x);
    const treatment = x.reimbursementType || rule?.treatment || "tracking";
    if (treatment === "exact") exact += amount;
    else if (treatment === "flexible") flexible += amount;
    else tracking += amount;
  }
  const allowance = totalFlexibleAllowance(project);
  const totalSpend = exact + flexible + tracking;
  const expectedReimbursement =
    project?.type === "business_trip"
      ? exact + allowance
      : exact + Math.min(flexible, allowance || flexible);
  const expectedResult = expectedReimbursement - totalSpend;
  const elapsed = elapsedAllowanceDays(project, currentDate);
  const totalDays = project?.type === "business_trip" ? allowanceDays(project.startDate, project.endDate) : 0;
  const remainingDays = Math.max(0, totalDays - elapsed);
  const remainingAllowance = Math.max(0, allowance - flexible);
  const projectedFlexible = elapsed > 0 && totalDays > 0 ? (flexible / elapsed) * totalDays : flexible;
  const safeDaily = remainingDays > 0 ? remainingAllowance / remainingDays : remainingAllowance;
  const paceRatio = allowance > 0 && totalDays > 0 && elapsed > 0
    ? (flexible / allowance) / (elapsed / totalDays)
    : 0;
  let paceKey = "neutral", paceLabel = "Not started";
  if (allowance > 0 && totalDays > 0 && elapsed > 0) {
    if (flexible > allowance + 0.5) {
      paceKey = "bad"; paceLabel = "Over allowance";
    } else if (paceRatio <= 0.85) {
      paceKey = "good"; paceLabel = "Under pace";
    } else if (paceRatio <= 1.1) {
      paceKey = "neutral"; paceLabel = "On track";
    } else if (paceRatio <= 1.3) {
      paceKey = "warn"; paceLabel = "Ahead of pace";
    } else {
      paceKey = "bad"; paceLabel = "Likely over";
    }
  }
  const walletAllocated = Math.max(0, Number(project?.tripWalletAllocatedTwd || 0));
  const walletRemaining = Math.max(0, walletAllocated - totalSpend);
  return {
    exact,
    flexible,
    tracking,
    totalSpend,
    allowance,
    expectedReimbursement,
    expectedResult,
    elapsedAllowanceDays: elapsed,
    totalAllowanceDays: totalDays,
    remainingAllowanceDays: remainingDays,
    remainingAllowance,
    projectedFlexible,
    safeDaily,
    paceRatio,
    paceKey,
    paceLabel,
    depositsPending,
    depositsPendingTwd,
    walletAllocated,
    walletRemaining,
    walletOverspend: Math.max(0, totalSpend - walletAllocated),
  };
}

export function mapLegacyBusinessExpense(expense) {
  const category = String(expense?.category || "").trim().toLowerCase();
  const description = String(expense?.description || "").trim().toLowerCase();
  const text = `${category} ${description}`;

  if (/deposit|collateral|hold/.test(text)) {
    return {
      categoryId: "car_rental",
      category: "Car Rental",
      reimbursementType: "exact",
      recordType: "refundable_deposit",
      depositStatus: "pending",
      retainedTwd: null,
    };
  }
  const mappings = [
    [/\bvisa delivery\b/, "visa_delivery_fee"],
    [/\bvisa\b/, "visa_application_fee"],
    [/hotel|accommodation/, "hotel_rental"],
    [/\bsim\b|mobile data/, "sim_card"],
    [/foreign exchange|fx fee|currency fee/, "foreign_exchange_fee"],
    [/train|rail/, "train_ticket"],
    [/uber|taxi|ride.?share/, "uber_fee"],
    [/city tax|tourist tax/, "city_tax"],
    [/parking/, "parking_ticket"],
    [/gas refill|fuel|petrol|diesel/, "gas_refill"],
    [/car rental|rental car/, "car_rental"],
    [/starbucks|breakfast|lunch|dinner|meal|food|restaurant|cafe|coffee/, "food"],
    [/power bank|shopping|shop|purchase/, "shopping"],
    [/haircut|gym|personal/, "personal_expenses"],
  ];
  const rules = businessTripCategoryRules();
  for (const [pattern, id] of mappings) {
    if (pattern.test(text)) {
      const rule = rules.find((x) => x.id === id);
      return {
        categoryId: rule.id,
        category: rule.name,
        reimbursementType: rule.treatment,
        recordType: "expense",
      };
    }
  }
  const fallback = rules.find((x) => x.id === "others");
  return {
    categoryId: fallback.id,
    category: fallback.name,
    reimbursementType: fallback.treatment,
    recordType: "expense",
  };
}

export function parseCustomCategoryRules({ exact = "", flexible = "", tracking = "" } = {}) {
  const out = [];
  const add = (source, treatment) => {
    for (const raw of String(source || "").split(/\r?\n/)) {
      const name = raw.trim();
      if (!name) continue;
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `category_${out.length + 1}`;
      if (!out.some((x) => x.id === id)) out.push({ id, name, treatment });
    }
  };
  add(exact, "exact");
  add(flexible, "flexible");
  add(tracking, "tracking");
  return out;
}

/**
 * Payment SOURCE view of the final counted Special Budget spending.
 * The exposure is distinct from reimbursement entitlement and bank/card debt.
 * Pending refundable card holds are NOT posted spending and are shown separately.
 * Partial deposits contribute only their recorded retained NTD amount.
 */
export function businessTripPaymentSourcesFor(expenses = [], settlement = null) {
  const methods = [
    { id: "esun_card", name: "E.SUN Credit Card" },
    { id: "ctbc", name: "CTBC Operating" },
    { id: "cash", name: "Cash" },
    { id: "other", name: "Other" },
    { id: "trip_wallet", name: "Trip Wallet" },
  ];
  const rows = methods.map((method) => ({
    ...method, amount: 0, count: 0, unknownTwdCount: 0,
    pendingHoldTwd: 0, pendingHoldCount: 0, percentage: 0,
  }));
  const byMethod = new Map(rows.map((x) => [x.id, x]));
  let unvalued = 0, pendingHolds = 0, pendingHoldTwd = 0;
  for (const entry of expenses || []) {
    if (!entry || entry.deletedAt) continue;
    const row = byMethod.get(entry.paymentMethod) || byMethod.get("other");
    if (isRefundableDeposit(entry) && !depositResolved(entry)) {
      pendingHolds++;
      row.pendingHoldCount++;
      const value = Number(entry.twdAmount);
      if (Number.isFinite(value) && value > 0) {
        row.pendingHoldTwd += value;
        pendingHoldTwd += value;
      }
      continue;
    }
    if (isRefundableDeposit(entry) && entry.depositStatus === "refunded") continue;
    if (missingTwd(entry)) {
      row.unknownTwdCount++;
      unvalued++;
      continue;
    }
    const amount = effectiveTwd(entry);
    if (amount <= 0) continue;
    row.amount += amount;
    row.count++;
  }
  const total = rows.reduce((sum, x) => sum + x.amount, 0);
  for (const row of rows) row.percentage = total > 0 ? row.amount / total * 100 : 0;
  // The settlement freezes what was counted on the E.SUN card at the time
  // it was finalized. A manual "funded" mark is not bank confirmation.
  const card = Number.isFinite(Number(settlement?.cardPaidTwd))
    ? Math.max(0, Number(settlement.cardPaidTwd))
    : byMethod.get("esun_card").amount;
  return {
    rows: rows.filter((x) => x.id !== "trip_wallet" ||
      x.amount > 0 || x.unknownTwdCount > 0 || x.pendingHoldCount > 0),
    total, unvalued, pendingHolds, pendingHoldTwd,
    cardKnownTwd: card,
    cardFundingMarked: !!settlement?.cardClearingConfirmed,
  };
}
