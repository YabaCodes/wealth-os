// Pure Activity-domain helpers. No DOM or IndexedDB dependencies.

export function isPurposeOnlyTransfer(t) {
  return (
    !!t &&
    (t.affectsPhysicalBalance === false ||
      t.fromAccountId === t.toAccountId ||
      ["bucket_allocation", "reserve_allocation", "allocation_reversal", "purpose_reallocation"].includes(t.transferType))
  );
}

export function buildActivityRecords({
  expenses = [],
  incomes = [],
  transfers = [],
  categories = [],
  accounts = [],
  incomeTypes = [],
}) {
  const categoryNames = new Map(categories.map((x) => [x.id, x.name]));
  const accountNames = new Map(accounts.map((x) => [x.id, x.name]));
  const incomeTypeNames = new Map(incomeTypes.map((x) => [x[0], x[1]]));
  const accountName = (id) => accountNames.get(id) || "";

  return [
    ...expenses
      .filter((x) => !x.deletedAt)
      .map((x) => ({
        ...x,
        _kind: "expense",
        _date: x.date,
        _amount: -Number(x.amount),
        _title: categoryNames.get(x.categoryId) || "Expense",
        _account: accountName(x.accountId),
        _detail: ["Physical expense", x.description || ""].filter(Boolean).join(" · "),
      })),
    ...incomes
      .filter((x) => !x.deletedAt)
      .map((x) => ({
        ...x,
        _kind: "income",
        _date: x.dateReceived,
        _amount: Number(x.amount),
        _title: incomeTypeNames.get(x.incomeType) || "Income",
        _account: accountName(x.accountId),
        _detail: ["Physical income", x.description || ""].filter(Boolean).join(" · "),
      })),
    ...transfers
      .filter((x) => !x.deletedAt && ["planned", "completed"].includes(x.status))
      .map((x) => {
        const virtualOnly = isPurposeOnlyTransfer(x);
        const internalName = accountName(x.fromAccountId) || "Account";
        return {
          ...x,
          _kind: "transfer",
          _date: x.completedDate || x.plannedDate,
          _amount: Number(x.amount || 0),
          _title: virtualOnly
            ? `${internalName} purpose allocation`
            : `${accountName(x.fromAccountId) || x.fromAccountId} → ${accountName(x.toAccountId) || x.toAccountId}`,
          _account: virtualOnly ? "Virtual purpose ledger" : "Physical bank transfer",
          _detail: `${virtualOnly ? "Virtual only · bank impact NT$0" : "Physical transfer · spending impact NT$0"} · ${x.status}`,
        };
      }),
  ].sort(
    (a, b) =>
      String(b._date).localeCompare(String(a._date)) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
}

export function filterActivityRecords(records, { kind = "all", query = "", categories = [] } = {}) {
  const categoryNames = new Map(categories.map((x) => [x.id, x.name]));
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const byKind = kind === "all" ? records : records.filter((x) => x._kind === kind);
  if (!normalizedQuery) return byKind;
  return byKind.filter((x) =>
    [x._title, x._detail, x._account, x._date, x.description, categoryNames.get(x.categoryId)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export function groupActivityByDay(list) {
  const days = [];
  for (const x of list || []) {
    const key = String(x._date || "").slice(0, 10);
    const last = days.at(-1);
    if (last && last.key === key) last.items.push(x);
    else days.push({ key, items: [x] });
  }
  return days.map(({ key, items }) => ({
    key,
    items,
    spent: items
      .filter((x) => x._kind === "expense")
      .reduce((sum, x) => sum + Math.abs(Number(x._amount || 0)), 0),
    earned: items
      .filter((x) => x._kind === "income")
      .reduce((sum, x) => sum + Number(x._amount || 0), 0),
  }));
}

function previousIsoDay(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayHeading(iso, currentDate) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso || "")) return iso || "No date";
  const now = currentDate || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const d = iso.slice(0, 10);
  if (d === now) return "Today";
  if (d === previousIsoDay(now)) return "Yesterday";
  const [yy, mm, dd] = d.split("-").map(Number);
  const currentYear = Number(now.slice(0, 4));
  const opts = { weekday: "short", month: "short", day: "numeric", ...(yy !== currentYear ? { year: "numeric" } : {}) };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(yy, mm - 1, dd));
}
