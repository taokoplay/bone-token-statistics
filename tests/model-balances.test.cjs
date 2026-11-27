"use strict";

const assert = require("node:assert/strict");
const { afterEach, beforeEach, test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { onPanelInvoke, onUnload } = require("../main.js");
const manifest = require("../manifest.json");

let directory;
beforeEach(async () => {
  directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "stats-host-fixture-"));
});

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
      getDataPath: async () => directory,
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
  await rm(directory, { recursive: true, force: true });
});

test("empty balance state and historical statistics work together without sending a request", async () => {
  const host = mockHost();
  const initial = await onPanelInvoke("stats.balances");
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.configs, []);
  assert.ok(initial.channels.some(channel => channel.id === "deepseek"));
  const stats = await onPanelInvoke("stats.snapshot", { days: 7 });
  assert.equal(stats.ok, true);
  assert.deepEqual(host.requests, []);
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
  assert.deepEqual(parse("minimax-api-cn", { base_resp: { status_code: 0 }, available_amount: "20.00" }, "sk-api-sample"), {
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

test("MiniMax M Plan accepts the quota shapes used by the official SDK and CLI", () => {
  const { makeRequest } = require("../lib/balance-providers.js");
  const request = makeRequest("minimax-cn", "sk-cp-test-plan");
  const resetsAt = 1893456000000;
  const quota = { model_remains: [
    { model_name: "general", current_interval_remaining_percent: 64, current_weekly_remaining_percent: 82, weekly_end_time: resetsAt },
    { model_name: "video", current_interval_status: 3, current_weekly_status: 3,
      current_interval_total_count: 0, current_weekly_total_count: 0 },
  ] };
  assert.equal(request.url, "https://api.minimax.cn/v1/token_plan/remains");
  assert.deepEqual(request.parse(quota), { scope: "plan", windows: [
    { period: "5h", remainingPercent: 64 },
    { period: "week", remainingPercent: 82, resetsAt },
  ] });
  assert.equal(request.parse({ ...quota, base_resp: { status_code: 1004 } }), undefined);
  assert.equal(request.parse({ model_remains: quota.model_remains.slice(1) }), undefined);
  const validVideo = { model_name: "video", start_time: 1893369600000, end_time: resetsAt,
    current_interval_remaining_percent: 10 };
  const windows = request.parse({ model_remains: [quota.model_remains[0], validVideo] }).windows;
  assert.deepEqual(windows[2], { model: "video", period: "other", remainingPercent: 10, resetsAt });
});

test("MiniMax rejects a key from the other billing mode before starting an upstream request", async () => {
  const host = mockHost();
  assert.deepEqual(await onPanelInvoke("stats.balances.save", { channel: "minimax-cn", apiKey: "sk-api-fixture" }),
    { ok: false, code: "MINIMAX_PLAN_KEY_REQUIRED" });
  assert.deepEqual(await onPanelInvoke("stats.balances.save", { channel: "minimax-api-cn", apiKey: "sk-cp-fixture" }),
    { ok: false, code: "MINIMAX_PAYGO_KEY_REQUIRED" });
  assert.deepEqual(host.requests, []);
});
