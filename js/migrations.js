// Historical data-model upgrades extracted from the live app controller for
// integration coverage. Keep these idempotent and never rewrite completed ledgers.
import { getAll, getOne, put } from "./db.js";

async function migrateV182() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 182) return;
  // v1.12 adds a Household flexible cap (laundry, toiletries, cleaning) with no amount: set it in
  // Settings → Budget rules. Skipped if a category with that name already exists. It is also added,
  // at zero, to any open month's plan so Household expenses count there; zero changes no totals.
  const categories = await getAll("categories");
  const stamp = new Date().toISOString();
  if (!categories.some((c) => c.id === "household" || String(c.name || "").trim().toLowerCase() === "household")) {
    const water = categories.find((c) => c.id === "water"),
      misc = categories.find((c) => c.id === "misc");
    const sort = water && misc ? (Number(water.sort) + Number(misc.sort)) / 2 : Number(water?.sort ?? 34) + 0.5;
    const household = {
      id: "household",
      name: "Household",
      group: "Flexible",
      ruleType: "cap",
      defaultAmount: 0,
      active: true,
      sort,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await put("categories", household);
    for (const period of await getAll("periods")) {
      const snap = period.planSnapshot;
      if (period.state === "closed" || !snap || !Array.isArray(snap.lines)) continue;
      if (snap.lines.some((l) => l.id === "household")) continue;
      await put("periods", { ...period, planSnapshot: { ...snap, lines: [...snap.lines, { ...household, budgetAmount: 0 }] } });
    }
  }
  await put("settings", { ...settings, dataModelVersion: 182, appVersion: "1.12.0", updatedAt: stamp });
}

async function migrateV190() {
  const settings = await getOne("settings", "app");
  if (Number(settings?.dataModelVersion || 0) >= 190) return;
  // v1.19 extends the existing Special Project records in-place with optional Special Budget fields.
  // No historical project or expense record is rewritten automatically; legacy projects remain readable
  // and can be deliberately converted from their own detail screen.
  await put("settings", {
    ...settings,
    dataModelVersion: 190,
    appVersion: "1.19.0",
    updatedAt: new Date().toISOString(),
  });
}

