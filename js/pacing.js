import { money } from "./calc.js";

function localToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthPaceContext(periodId, currentDate = localToday()) {
  if (!periodId) return { days: 30, elapsed: 0, remaining: 30, isCurrent: false, isPast: false, isFuture: false };
  const [year, month] = periodId.split("-").map(Number),
    days = new Date(year, month, 0).getDate(),
    currentMonth = currentDate.slice(0, 7);
  let elapsed = 0;
  if (periodId < currentMonth) elapsed = days;
  else if (periodId === currentMonth) elapsed = Math.min(days, Number(currentDate.slice(8, 10)) || 1);
  const remaining = Math.max(0, days - elapsed);
  return {
    days,
    elapsed,
    remaining,
    isCurrent: periodId === currentMonth,
    isPast: periodId < currentMonth,
    isFuture: periodId > currentMonth,
  };
}

export function flexPace(period, plan, totals, currentDate) {
  const ctx = monthPaceContext(period.id, currentDate);
  const capLines = plan.lines.filter((x) => x.ruleType === "cap"),
    capsBudget = capLines.reduce((sum, x) => sum + Number(x.budgetAmount || 0), 0),
    capsSpent = capLines.reduce((sum, x) => sum + Number(totals[x.id] || 0), 0),
    todaysMark = capsBudget * (ctx.days ? ctx.elapsed / ctx.days : 0);
  let tone = "good",
    text = "";
  if (capsBudget <= 0) {
    tone = "muted";
    text = "No flexible caps yet. Add them in Settings → Budget rules.";
  } else if (capsSpent > capsBudget + 0.5) {
    tone = "bad";
    text = `<strong>Over</strong> · ${money(capsSpent - capsBudget)} above your flexible caps`;
  } else if (!ctx.isCurrent) {
    tone = ctx.isFuture ? "muted" : "good";
    text = ctx.isFuture
      ? "This month hasn't started yet."
      : `<strong>Finished</strong> · ${money(capsBudget - capsSpent)} of the caps unspent`;
  } else if (capsSpent <= todaysMark + 0.5) {
    text = `<strong>On pace</strong> · ${money(todaysMark - capsSpent)} under today's mark`;
  } else {
    tone = "warn";
    text = `<strong>Ahead of pace</strong> · ${money(capsSpent - todaysMark)} over today's mark`;
  }
  return {
    ctx,
    capLines,
    capsBudget,
    capsSpent,
    todaysMark,
    fillPct: capsBudget > 0 ? Math.min(100, (capsSpent / capsBudget) * 100) : 0,
    markPct: ctx.days ? Math.min(100, (ctx.elapsed / ctx.days) * 100) : 0,
    tone,
    text,
  };
}

export function isIrregularCap(line) {
  return ["gas", "water"].includes(line.id) || /\b(gas|water|electric)/i.test(line.name || "");
}

export function capPace(line, spent, ctx) {
  const budget = Number(line.budgetAmount || 0);
  if (budget <= 0) return spent > 0.5 ? { tone: "bad", text: `${money(spent)} with no cap set` } : { tone: "muted", text: "No cap set" };
  if (spent > budget + 0.5) return { tone: "bad", text: `Over by ${money(spent - budget)}` };
  if (isIrregularCap(line)) return { tone: "muted", text: "Billed irregularly", noMark: true };
  if (!ctx.isCurrent) return { tone: "muted", text: ctx.isPast ? `${money(budget - spent)} unspent` : "Not started", noMark: true };
  const mark = (budget * ctx.elapsed) / ctx.days;
  if (spent <= mark + 0.5) return { tone: "muted", text: "On pace" };
  return { tone: "warn", text: `${money(spent - mark)} ahead of today's mark` };
}

export function spendingPaceStatus({ spent, budget, elapsed, days }) {
  if (budget <= 0) return { key: "neutral", label: "No cap", detail: "No monthly cap is set." };
  if (spent > budget + 0.5)
    return { key: "bad", label: "Over budget", detail: `Already ${money(spent - budget)} above the monthly cap.` };
  if (elapsed <= 0) return { key: "neutral", label: "Not started", detail: "This funding month has not started yet." };
  const used = spent / budget,
    elapsedPct = elapsed / days,
    pace = elapsedPct > 0 ? used / elapsedPct : 0;
  if (elapsed <= 5) {
    if (pace <= 0.75)
      return { key: "good", label: "Under pace", detail: "Spending is comfortably below the calendar pace." };
    if (pace <= 1.3)
      return { key: "neutral", label: "On track", detail: "Early-month pace is close to the budget path." };
    if (pace <= 1.7)
      return { key: "warn", label: "Ahead of pace", detail: "A little fast, but confidence is still low this early." };
    return { key: "warn", label: "Watch pace", detail: "Spending is running fast; early-month confidence is still low." };
  }
  if (pace <= 0.85)
    return { key: "good", label: "Under pace", detail: "Current spending is below the calendar budget pace." };
  if (pace <= 1.1)
    return { key: "neutral", label: "On track", detail: "Current spending is close to the calendar budget pace." };
  if (pace <= 1.3)
    return { key: "warn", label: "Ahead of pace", detail: "Spending is running ahead of the budget path." };
  return { key: "bad", label: "Likely over", detail: "At the current pace, this category is likely to finish over budget." };
}

export function spendingPaceFor(periodId, line, allExpenses, currentDate) {
  const ctx = monthPaceContext(periodId, currentDate),
    budget = Number(line?.budgetAmount || 0);
  const cutoff = ctx.elapsed ? `${periodId}-${String(ctx.elapsed).padStart(2, "0")}` : `${periodId}-00`;
  const expenses = (allExpenses || []).filter(
    (e) => !e.deletedAt && e.budgetPeriodId === periodId && e.categoryId === line.id && String(e.date || "") <= cutoff,
  );
  const spent = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0),
    expected = ctx.days ? budget * (ctx.elapsed / ctx.days) : 0;
  const projected = ctx.elapsed > 0 ? (spent / ctx.elapsed) * ctx.days : 0,
    remainingBudget = Math.max(0, budget - spent),
    safeDaily = ctx.remaining > 0 ? remainingBudget / ctx.remaining : remainingBudget;
  const status = spendingPaceStatus({ spent, budget, elapsed: ctx.elapsed, days: ctx.days });
  const confidence =
    ctx.elapsed <= 5 ? "Low" : ctx.elapsed <= 12 ? "Developing" : ctx.elapsed < ctx.days ? "Moderate" : "Final";
  return { ...ctx, budget, spent, expected, projected, remainingBudget, safeDaily, status, confidence, expenses };
}
