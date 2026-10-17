import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("release identity is consistent across runtime, defaults, README and service worker", () => {
  const app = read("js/app.js");
  const defaults = read("js/defaults.js");
  const readme = read("README.md");
  const sw = read("sw.js");

  const appVersion = app.match(/const APP_VERSION = "([^"]+)"/)?.[1];
  const modelVersion = Number(app.match(/const DATA_MODEL_VERSION = (\d+)/)?.[1]);
  const defaultVersion = defaults.match(/appVersion:\s*"([^"]+)"/)?.[1];
  const defaultModel = Number(defaults.match(/dataModelVersion:\s*(\d+)/)?.[1]);
  const readmeVersion = readme.match(/^# Wealth OS — v([^\s]+)$/m)?.[1];
  const cacheVersion = sw.match(/const CACHE = "wealth-os-v([\d-]+)"/)?.[1]?.replaceAll("-", ".");

  assert.ok(appVersion, "APP_VERSION must be present");
  assert.equal(defaultVersion, appVersion);
  assert.equal(readmeVersion, appVersion);
  assert.equal(cacheVersion, appVersion);
  assert.equal(defaultModel, modelVersion);
});

test("every service-worker precache asset exists in the repository", () => {
  const sw = read("sw.js");
  const block = sw.match(/const ASSETS = \[([\s\S]*?)\];/)?.[1];
  assert.ok(block, "ASSETS list must be present");
  const assets = [...block.matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(assets.length > 0, "ASSETS list must not be empty");
  for (const asset of assets) {
    assert.ok(existsSync(join(root, asset)), `Missing precache asset: ${asset}`);
  }
});
