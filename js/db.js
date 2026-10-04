import { DEFAULTS } from "./defaults.js";

const DB_NAME = "wealth-os-db";
const DB_VERSION = 3;
const STORES = [
  "accounts",
  "buckets",
  "categories",
  "goals",
  "periods",
  "incomes",
  "expenses",
  "transfers",
  "transferAllocations",
  "investmentSnapshots",
  "reconciliations",
  "adjustments",
  "monthlyCloses",
  "projects",
  "projectExpenses",
  "projectSettlements",
  "settings",
];
let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}
export async function getOne(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function put(store, obj) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve(obj);
    tx.onerror = () => reject(tx.error);
  });
}
export async function bulkPut(store, items) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    items.forEach((x) => os.put(x));
    tx.oncomplete = () => resolve(items);
    tx.onerror = () => reject(tx.error);
  });
}
export async function remove(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function clearStore(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export const uid = (prefix = "id") => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function seedIfNeeded() {
  const existing = await getAll("settings");
  if (existing.length) return;
  await bulkPut("accounts", DEFAULTS.accounts);
  await bulkPut("buckets", DEFAULTS.buckets);
  await bulkPut("categories", DEFAULTS.categories);
  await bulkPut("goals", DEFAULTS.goals);
  await put("settings", { id: "app", ...DEFAULTS.settings });
  // Optional starting brokerage value (none in the public template).
  if (DEFAULTS.initialInvestmentSnapshot)
    await put("investmentSnapshots", {
      id: "initial-ibkr",
      fxRate: DEFAULTS.settings.usdTwdRate,
      ...DEFAULTS.initialInvestmentSnapshot,
      createdAt: new Date().toISOString(),
    });
}

export async function exportData() {
  const out = { version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const s of STORES) out.data[s] = await getAll(s);
  return out;
}
// Checks that a file really is a Wealth OS backup before anything on the device is touched.
export function validateBackup(payload) {
  const fail = (reason) => ({ ok: false, reason });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("This file isn't a Wealth OS backup.");
  if (payload.version !== 1 || !payload.data || typeof payload.data !== "object")
    return fail("This file isn't a Wealth OS backup (unsupported format).");
  const d = payload.data;
  for (const s of STORES) {
    if (d[s] != null && !Array.isArray(d[s])) return fail(`The backup's "${s}" section is damaged.`);
    if ((d[s] || []).some((x) => !x || typeof x !== "object" || x.id == null))
      return fail(`The backup's "${s}" section has records without an ID.`);
  }
  if (!(d.settings || []).some((x) => x.id === "app")) return fail("The backup has no app settings, so it can't be a complete Wealth OS backup.");
  if (!(d.accounts || []).length) return fail("The backup has no accounts, so it can't be a complete Wealth OS backup.");
  return { ok: true, summary: backupSummary(payload) };
}
export function backupSummary(payload) {
  const d = payload?.data || {},
    live = (rows) => (rows || []).filter((x) => !x.deletedAt).length;
  return {
    exportedAt: payload?.exportedAt || null,
    months: (d.periods || []).length,
    expenses: live(d.expenses),
    incomes: live(d.incomes),
    transfers: live(d.transfers),
  };
}
// Replaces everything in one transaction: if anything fails, nothing on the device changes.
export async function importData(payload) {
  const check = validateBackup(payload);
  if (!check.ok) throw new Error(check.reason);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, "readwrite");
    for (const s of STORES) {
      const os = tx.objectStore(s);
      os.clear();
      for (const row of payload.data[s] || []) os.put(row);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Restore was cancelled; nothing was changed."));
  });
}

// A copy of your data from just before the last restore, kept in a separate database so a
// restore (which clears the main one) can't remove it. Lets you undo a wrong restore.
const UNDO_DB = "wealth-os-undo";
function openUndoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(UNDO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("snapshots", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function undoStore(mode, fn) {
  const db = await openUndoDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", mode),
        r = fn(tx.objectStore("snapshots"));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const saveUndoSnapshot = (payload) => undoStore("readwrite", (os) => os.put({ id: "pre-restore", savedAt: new Date().toISOString(), payload }));
export const getUndoSnapshot = () => undoStore("readonly", (os) => os.get("pre-restore"));
export const clearUndoSnapshot = () => undoStore("readwrite", (os) => os.delete("pre-restore"));

export async function bucketBalances() {
  const [buckets, allocs, expenses] = await Promise.all([
    getAll("buckets"),
    getAll("transferAllocations"),
    getAll("expenses"),
  ]);
  const out = {};
  buckets.forEach((b) => (out[b.id] = Number(b.openingBalance || 0)));
  const transfers = await getAll("transfers");
  const completed = new Set(transfers.filter((t) => t.status === "completed" && !t.deletedAt).map((t) => t.id));
  for (const a of allocs) {
    if (completed.has(a.transferId)) out[a.bucketId] = (out[a.bucketId] || 0) + Number(a.amount || 0);
  }
  for (const e of expenses) {
    if (!e.deletedAt && e.fundingBucketId)
      out[e.fundingBucketId] = (out[e.fundingBucketId] || 0) - Number(e.amount || 0);
  }
  return out;
}

export async function accountBalances() {
  const [accounts, incomes, expenses, transfers, snaps, adjustments, settings] = await Promise.all([
    getAll("accounts"),
    getAll("incomes"),
    getAll("expenses"),
    getAll("transfers"),
    getAll("investmentSnapshots"),
    getAll("adjustments"),
    getOne("settings", "app"),
  ]);
  const out = {};
  accounts.forEach((a) => (out[a.id] = Number(a.openingBalance || 0)));
  for (const i of incomes) {
    if (!i.deletedAt) out[i.accountId] = (out[i.accountId] || 0) + Number(i.amount || 0);
  }
  for (const e of expenses) {
    if (!e.deletedAt) out[e.accountId] = (out[e.accountId] || 0) - Number(e.amount || 0);
  }
  for (const t of transfers.filter((t) => t.status === "completed" && !t.deletedAt)) {
    // Purpose-only allocations move no money between physical accounts. Historical
    // versions represented them as transfer records for audit/activity purposes, so
    // explicitly exclude them from physical account balances even if old records have
    // malformed from/to account fields.
    const purposeOnly =
      t.affectsPhysicalBalance === false ||
      t.fromAccountId === t.toAccountId ||
      ["bucket_allocation", "reserve_allocation"].includes(t.transferType);
    if (purposeOnly) continue;
    out[t.fromAccountId] = (out[t.fromAccountId] || 0) - Number(t.amount || 0);
    out[t.toAccountId] = (out[t.toAccountId] || 0) + Number(t.amount || 0);
  }
  for (const a of adjustments) {
    if (!a.deletedAt) out[a.accountId] = (out[a.accountId] || 0) + Number(a.amount || 0);
  }
  // Brokerage value is anchored to the latest portfolio snapshot. Completed transfers after that
  // snapshot are layered on top until the next snapshot replaces the estimate.
  const ibkr = accounts.find((a) => a.role === "investment");
  if (ibkr) {
    const relevant = snaps
      .filter((s) => s.accountId === ibkr.id)
      .sort(
        (a, b) =>
          String(a.date).localeCompare(String(b.date)) ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      );
    if (relevant.length) {
      const latest = relevant.at(-1);
      const snapStamp = String(latest.createdAt || `${latest.date || ""}T00:00:00`);
      let value = Number(latest.value || 0);
      for (const t of transfers.filter((t) => t.status === "completed" && !t.deletedAt)) {
        const purposeOnly =
          t.affectsPhysicalBalance === false ||
          t.fromAccountId === t.toAccountId ||
          ["bucket_allocation", "reserve_allocation"].includes(t.transferType);
        if (purposeOnly) continue;
        const stamp = String(t.completedAt || t.updatedAt || t.createdAt || `${t.completedDate || ""}T00:00:00`);
        if (stamp <= snapStamp) continue;
        if (t.toAccountId === ibkr.id)
          value += Number(t.amount || 0) / (ibkr.currency === "USD" ? Number(settings?.usdTwdRate || 1) : 1);
        if (t.fromAccountId === ibkr.id)
          value -= Number(t.amount || 0) / (ibkr.currency === "USD" ? Number(settings?.usdTwdRate || 1) : 1);
      }
      out[ibkr.id] = value;
    }
  }
  return out;
}

function recordAfterReconciliation(rec, effectiveDate, stamp) {
  const rd = String(rec?.date || ""),
    ed = String(effectiveDate || "");
  if (ed > rd) return true;
  if (ed < rd) return false;
  return String(stamp || "") > String(rec?.createdAt || "");
}
function physicalDeltaSinceReconciliation(accountId, rec, { incomes, expenses, transfers, adjustments }) {
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

export async function wealthMetrics() {
  const [accounts, buckets, bb, ab, snaps, settings, reconciliations, incomes, expenses, transfers, adjustments] =
    await Promise.all([
      getAll("accounts"),
      getAll("buckets"),
      bucketBalances(),
      accountBalances(),
      getAll("investmentSnapshots"),
      getOne("settings", "app"),
      getAll("reconciliations"),
      getAll("incomes"),
      getAll("expenses"),
      getAll("transfers"),
      getAll("adjustments"),
    ]);
  const fx = Number(settings?.usdTwdRate || 1);
  const latestActual = {},
    latestReconciliation = {};
  for (const r of [...reconciliations].sort((a, b) =>
    `${a.date || ""}${a.createdAt || ""}`.localeCompare(`${b.date || ""}${b.createdAt || ""}`),
  )) {
    if (!r.deletedAt) {
      latestActual[r.accountId] = Number(r.actualBalance || 0);
      latestReconciliation[r.accountId] = r;
    }
  }
  let financialNetWorth = 0;
  // Reserved E.SUN is classified by virtual purpose buckets so tithe stays excluded.
  // For operating cash, the last exact bank check is rolled forward with recorded ledger
  // activity so balances remain current between manual reconciliations.
  for (const a of accounts) {
    if (a.role === "reserved") continue;
    const expected = Number(ab[a.id] || 0),
      rec = latestReconciliation[a.id];
    // A reconciliation is an authoritative bank baseline. Roll it forward only with
    // physical activity after that check; do not re-apply historical adjustments that
    // were already reflected in the checked balance.
    const raw =
      a.role !== "investment" && rec
        ? Number(rec.actualBalance || 0) +
          physicalDeltaSinceReconciliation(a.id, rec, { incomes, expenses, transfers, adjustments })
        : expected;
    const v = raw * (a.currency === "USD" ? fx : 1);
    financialNetWorth += v;
  }
  for (const b of buckets) {
    if (b.countsTowardNetWorth) financialNetWorth += Number(bb[b.id] || 0);
  }
  let coreWealth = 0;
  for (const b of buckets) {
    if (b.countsTowardCoreWealth) coreWealth += Number(bb[b.id] || 0);
  }
  for (const a of accounts.filter((x) => x.role === "investment"))
    coreWealth += Number(ab[a.id] || 0) * (a.currency === "USD" ? fx : 1);
  return { financialNetWorth, coreWealth, bucketBalances: bb, accountBalances: ab, latestActual };
}
