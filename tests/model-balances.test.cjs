"use strict";

const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { onPanelInvoke, onUnload } = require("../main.js");
const manifest = require("../manifest.json");

const fixtureKey = "sk-test-query-key-never-stored";
const success = { status: 200, bodyText: JSON.stringify({
  is_available: false,
  balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
}) };

function mockHost({ fetch = async () => success, redirects = ["error"] } = {}) {
  let settings = { defaultDays: 7 };
  const requests = [];
  global.pi = {
    plugin: {
      getSettings: async () => structuredClone(settings),
      setSettings: async (patch) => { settings = { ...settings, ...structuredClone(patch) }; },
    },
    net: {
      getCapabilities: async () => ({ fetchRedirectModes: redirects }),
      fetch: async (request) => {
        requests.push(request);
        return fetch(request);
      },
    },
    commands: { unregister: async () => {} },
    usage: { listTurns: async () => ({ turns: [] }) },
  };
  return { requests, settings: () => settings };
}

afterEach(async () => {
  await onUnload();
  delete global.pi;
});

test("adding a channel queries its official endpoint and persists only the non-secret configuration", async () => {
  const host = mockHost();
  const initial = await onPanelInvoke("stats.balances");
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.configs, []);
  assert.ok(initial.channels.some(channel => channel.id === "deepseek"));
  assert.deepEqual(host.requests, []);

  const saved = await onPanelInvoke("stats.balances.save", { channel: "deepseek", apiKey: fixtureKey });
  assert.equal(saved.ok, true);
  const [row] = saved.snapshot.configs;
  assert.equal(row.status, "available");
  assert.deepEqual(row.balance, { scope: "account", amounts: [{ currency: "CNY", amount: 0 }] });
  assert.deepEqual(host.settings().balanceConfigs, [{ id: row.id, channel: "deepseek" }]);
  assert.doesNotMatch(JSON.stringify([saved, host.settings()]), /sk-test-query-key/);
  assert.deepEqual(host.requests.map(request => [request.method, request.url, request.redirect, request.headers.Authorization]), [
    ["GET", "https://api.deepseek.com/user/balance", "error", `Bearer ${fixtureKey}`],
  ]);

  await onPanelInvoke("stats.snapshot", { days: 7 });
  await onPanelInvoke("stats.balances");
  assert.equal(host.requests.length, 1);
  assert.equal((await onPanelInvoke("stats.balances", { refresh: true })).configs[0].status, "available");
  assert.equal(host.requests.length, 2);

  await onUnload();
  const restored = await onPanelInvoke("stats.balances", { refresh: true });
  assert.equal(restored.configs[0].id, row.id);
  assert.equal(restored.configs[0].status, "missing-credential");
  assert.equal(host.requests.length, 2);
  const unlocked = await onPanelInvoke("stats.balances.save", { id: row.id, channel: "deepseek", apiKey: fixtureKey });
  assert.equal(unlocked.snapshot.configs[0].status, "available");
  const removed = await onPanelInvoke("stats.balances.remove", { id: row.id });
  assert.deepEqual(removed.snapshot.configs, []);
  assert.deepEqual(host.settings().balanceConfigs, []);
});

test("invalid channels and hosts without redirect protection never receive a Key", async () => {
  const host = mockHost({ redirects: ["follow"] });
  assert.deepEqual(await onPanelInvoke("stats.balances.save", { channel: "https://example.com", apiKey: fixtureKey }),
    { ok: false, code: "INVALID_CHANNEL" });
  assert.deepEqual(await onPanelInvoke("stats.balances.save", { channel: "deepseek", apiKey: "one\r\ntwo" }),
    { ok: false, code: "INVALID_KEY" });
  assert.deepEqual(await onPanelInvoke("stats.balances.save", { channel: "deepseek", apiKey: fixtureKey }),
    { ok: false, code: "UNSUPPORTED" });
  assert.deepEqual(host.requests, []);
  assert.equal(host.settings().balanceConfigs, undefined);
});

test("failed authentication does not create a configuration and provider errors are sanitized", async () => {
  const host = mockHost({ fetch: async () => ({ status: 401, bodyText: fixtureKey }) });
  const result = await onPanelInvoke("stats.balances.save", { channel: "deepseek", apiKey: fixtureKey });
  assert.deepEqual(result, { ok: false, code: "UNAUTHORIZED" });
  assert.equal(host.settings().balanceConfigs, undefined);
  global.pi.net.fetch = async () => { throw new Error(fixtureKey); };
  assert.deepEqual(await onPanelInvoke("stats.balances.save", { channel: "deepseek", apiKey: fixtureKey }),
    { ok: false, code: "UNAVAILABLE" });
});

test("the plugin network manifest matches its fixed channel destinations", () => {
  const { channels, makeRequest } = require("../lib/balance-providers.js");
  const hosts = channels.map(({ id }) => new URL(makeRequest(id, fixtureKey).url).hostname);
  assert.deepEqual([...new Set(hosts)].sort(), [...manifest.net.domains].sort());
  assert.ok(manifest.permissions.includes("net.fetch"));
  assert.ok(!manifest.permissions.includes("models.balance.read"));
  assert.equal(manifest.engines.piDesktop, ">=0.21.0");
});

test("a key stays bound to its original channel and an older refresh cannot overwrite a new key", async () => {
  let releaseRefresh;
  let refreshStarted;
  const waitRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  const started = new Promise(resolve => { refreshStarted = resolve; });
  let shouldWait = false;
  const host = mockHost({ fetch: async request => {
    if (request.headers.Authorization.endsWith("-replacement")) {
      return { ...success, bodyText: JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "14.30" }] }) };
    }
    if (shouldWait) {
      refreshStarted();
      await waitRefresh;
    }
    return success;
  } });
  const saved = await onPanelInvoke("stats.balances.save", { channel: "deepseek", apiKey: fixtureKey });
  const [{ id }] = saved.snapshot.configs;
  shouldWait = true;
  const inFlight = onPanelInvoke("stats.balances", { refresh: true });
  await started;
  const updated = await onPanelInvoke("stats.balances.save", { id, channel: "deepseek", apiKey: `${fixtureKey}-replacement` });
  releaseRefresh();
  assert.equal(updated.snapshot.configs[0].balance.amounts[0].amount, 14.3);
  assert.equal((await inFlight).configs[0].balance.amounts[0].amount, 14.3);

  await global.pi.plugin.setSettings({ balanceConfigs: [{ id, channel: "bigmodel" }] });
  const list = await onPanelInvoke("stats.balances", { refresh: true });
  assert.deepEqual(list.configs, [{ id, channel: "bigmodel", status: "missing-credential" }]);
  assert.equal(host.requests.length, 3);
});

test("the adapters keep the upstream amounts, denominations, and reset periods", () => {
  const { makeRequest } = require("../lib/balance-providers.js");
  const reset = 1893456000000;
  const parse = (channel, data, key = fixtureKey) => makeRequest(channel, key).parse(data);
  const glm = { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 75, nextResetTime: reset }] } };
  for (const channel of ["bigmodel", "z-ai"]) {
    assert.equal(makeRequest(channel, fixtureKey).authorization, fixtureKey);
    assert.deepEqual(parse(channel, glm), {
      scope: "plan", windows: [{ period: "5h", remainingPercent: 25, resetsAt: reset }],
    });
  }
  assert.deepEqual(parse("minimax-cn", { base_resp: { status_code: 0 }, available_amount: "20.00" }, "sk-api-sample"), {
    scope: "account", amounts: [{ amount: 20, currency: "CNY" }],
  });
  assert.deepEqual(parse("minimax", { base_resp: { status_code: 0 }, model_remains: [
    { model_name: "MiniMax-M*", current_interval_remaining_percent: 0, current_weekly_status: 3 },
  ] }), { scope: "plan", windows: [{ period: "5h", remainingPercent: 0 }, { period: "week", remainingPercent: null }] });
  assert.deepEqual(parse("moonshot", { code: 0, status: true, data: { available_balance: 10 } }),
    { scope: "account", amounts: [{ amount: 10, currency: "USD" }] });
  assert.deepEqual(parse("kimi-code", { usage: { limit: 20, used: 5 } }),
    { scope: "plan", windows: [{ period: "week", remainingPercent: 75 }] });
  assert.deepEqual(parse("openrouter", { data: { limit: null, limit_remaining: null } }),
    { scope: "key", currency: "USD", remaining: null });
  assert.deepEqual(parse("mimo", { object: "balance", balance_infos: [{ currency: "CNY", total_available: "12.50", frozen_balance: "2.00" }] }),
    { scope: "account", amounts: [{ currency: "CNY", amount: 10.5 }] });
  assert.deepEqual(parse("mimo-plan-cn", { object: "token_plan", quota: { remaining_credits: 450 }, period: { end_at: "2030-01-01 00:00:00" } }),
    { scope: "credits", account: false, remaining: 450, resetsAt: reset });
  assert.deepEqual(parse("siliconflow", { code: 20000, status: true, data: { totalBalance: "30.001" } }),
    { scope: "account", amounts: [{ amount: 30.001 }] });
  assert.deepEqual(parse("vercel", { balance: "12.50" }), { scope: "credits", account: true, remaining: 12.5 });
});
