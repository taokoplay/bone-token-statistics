"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { createBalances } = require("../lib/model-balances");
const { createBalanceVault, VAULT_FILE } = require("../lib/balance-vault");
const { createCredentialProtector } = require("../lib/credential-protection");

const sampleKey = "fixture-api-key-checked-for-plaintext";
const legacyId = "76f944fb-d83d-4130-83a6-3871bfdec589";
const service = "bone.token.statistics.balance-configs.v1";
const response = amount => ({ status: 200, bodyText: JSON.stringify({
  balance_infos: [{ currency: "CNY", total_balance: amount }],
}) });

async function setup(t, { metadata, fetch = async () => response(0) } = {}) {
  const directory = await fs.mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "balance-fixture-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const masterKeys = new Map();
  const savedRequests = [];
  let unavailable = false;
  const run = async (command, args, input) => {
    assert.equal(command, "/usr/bin/security");
    assert.ok(!args.join(" ").includes(sampleKey));
    assert.ok(!input.includes(sampleKey));
    if (unavailable) return { code: 1, stdout: "" };
    if (args[0] === "find-generic-password") {
      assert.deepEqual(args.slice(3), ["-s", service, "-w"]);
      const key = masterKeys.get(args[2]);
      return key ? { code: 0, stdout: key } : { code: 1, stdout: "" };
    }
    assert.deepEqual(args, ["-q", "-i"]);
    const match = input.match(/^add-generic-password -a ([a-f0-9]{64}) -s ([\w.-]+) -w ([a-f0-9]{64})\n$/);
    assert.ok(match);
    assert.equal(match[2], service);
    masterKeys.set(match[1], match[3]);
    return { code: 0, stdout: "" };
  };
  const api = {
    getDataPath: async () => directory,
    getSettings: async () => ({ balanceConfigs: metadata }),
    setSettings: async (patch) => { metadata = patch.balanceConfigs; },
    getCapabilities: async () => ({ fetchRedirectModes: ["error"] }),
    fetch: async (request) => {
      savedRequests.push(request);
      return fetch(request);
    },
  };
  const createVault = () => createBalanceVault({
    getDataPath: api.getDataPath,
    protector: createCredentialProtector({ platform: "darwin", run }),
  });
  const reboot = () => createBalances(api, createVault());
  return { reboot, createVault, path: join(directory, VAULT_FILE), masterKeys, savedRequests,
    setUnavailable(value) { unavailable = value; } };
}

test("a restarted balance service loads locally encrypted configurations and queries the original channel", async (t) => {
  const fixture = await setup(t);
  let balances = fixture.reboot();
  assert.deepEqual((await balances.list()).configs, []);
  const saved = await balances.save({ channel: "deepseek", apiKey: sampleKey });
  assert.equal(saved.ok, true);
  const [configuration] = saved.snapshot.configs;
  assert.equal(configuration.status, "available");
  assert.equal(configuration.balance.amounts[0].amount, 0);
  const contents = await fs.readFile(fixture.path, "utf8");
  assert.doesNotMatch(contents, /fixture-api-key|deepseek|apiKey/);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-api-key|apiKey/);
  assert.equal(JSON.parse(contents).encrypted.method, "aes-256-gcm");
  assert.equal((await fs.stat(fixture.path)).mode & 0o777, 0o600);
  assert.equal(fixture.masterKeys.size, 1);

  balances.clear();
  balances = fixture.reboot();
  const restored = await balances.list();
  assert.equal(restored.configs[0].id, configuration.id);
  assert.equal(restored.configs[0].balance.amounts[0].amount, 0);
  assert.deepEqual(fixture.savedRequests.map(({ url, method, headers, redirect }) => [url, method, headers.Authorization, redirect]),
    Array.from({ length: 2 }, () => ["https://api.deepseek.com/user/balance", "GET", `Bearer ${sampleKey}`, "error"]));
  assert.equal((await balances.remove({ id: configuration.id })).ok, true);
  assert.deepEqual((await fixture.reboot().list()).configs, []);
  assert.equal(fixture.savedRequests.length, 2);
});

test("named accounts on the same channel remain distinct across edits and restarts", async (t) => {
  const personalKey = `${sampleKey}-personal`;
  const fixture = await setup(t, { fetch: async ({ headers: { Authorization } }) =>
    response(Authorization.endsWith("-personal") ? 31.5 : 12.34),
  });
  const balances = fixture.reboot();
  const work = await balances.save({ channel: "deepseek", apiKey: sampleKey, name: "  工作账号  " });
  const personal = await balances.save({ channel: "deepseek", apiKey: personalKey, name: "个人账号" });
  assert.equal(work.ok, true);
  assert.equal(personal.ok, true);
  const [first, second] = personal.snapshot.configs;
  assert.notEqual(first.id, second.id);
  assert.deepEqual([first.name, second.name], ["工作账号", "个人账号"]);
  const renamed = await balances.save({ id: first.id, channel: "deepseek", name: "团队账号", apiKey: "" });
  assert.equal(renamed.ok, true);
  assert.deepEqual(renamed.snapshot.configs, [{ ...first, name: "团队账号" }, second]);
  assert.equal(fixture.savedRequests.length, 2);
  assert.doesNotMatch(await fs.readFile(fixture.path, "utf8"), /团队账号|个人账号|fixture-api-key/);
  assert.doesNotMatch(JSON.stringify(renamed), /fixture-api-key|apiKey/);
  assert.deepEqual((await fixture.reboot().list()).configs, renamed.snapshot.configs);
  assert.deepEqual(fixture.savedRequests.slice(2).map(req => req.headers.Authorization).sort(),
    [`Bearer ${sampleKey}`, `Bearer ${personalKey}`].sort());

  const replacement = await balances.save({ id: first.id, channel: "deepseek", apiKey: sampleKey });
  assert.equal(replacement.snapshot.configs[0].name, "团队账号");
  const cleared = await balances.save({ id: first.id, channel: "deepseek", name: "  " });
  assert.equal(cleared.snapshot.configs[0].name, undefined);
  assert.equal(cleared.snapshot.configs[1].name, "个人账号");
});

test("out-of-range configuration names are refused before querying the provider", async (t) => {
  const fixture = await setup(t);
  const balances = fixture.reboot();
  for (const name of [null, "a".repeat(65), "first\nsecond"]) {
    assert.deepEqual(await balances.save({ channel: "deepseek", name, apiKey: sampleKey }),
      { ok: false, code: "INVALID_NAME" });
  }
  assert.equal(fixture.savedRequests.length, 0);
  assert.deepEqual((await balances.list()).configs, []);
});

test("MiniMax M Plan uses the selected region, reports quota failures, and reloads the saved key", async (t) => {
  let upstreamStatus = 401;
  const planKey = "sk-cp-fixture-minimax";
  const fixture = await setup(t, { fetch: async request => {
    assert.equal(request.url, "https://api.minimax.io/v1/token_plan/remains");
    assert.equal(request.headers.Authorization, `Bearer ${planKey}`);
    return { status: upstreamStatus, bodyText: JSON.stringify({ model_remains: [
      { model_name: "general", current_interval_remaining_percent: 64, current_weekly_remaining_percent: 82 },
    ] }) };
  } });
  const balances = fixture.reboot();
  assert.deepEqual(await balances.save({ channel: "minimax", apiKey: planKey }),
    { ok: false, code: "MINIMAX_PLAN_UNAVAILABLE" });
  assert.deepEqual((await balances.list()).configs, []);
  upstreamStatus = 200;
  const saved = await balances.save({ channel: "minimax", apiKey: planKey });
  assert.equal(saved.ok, true);
  const restored = (await fixture.reboot().list()).configs[0];
  assert.deepEqual(restored, saved.snapshot.configs[0]);
  assert.deepEqual(restored.balance.windows, [
    { period: "5h", remainingPercent: 64 }, { period: "week", remainingPercent: 82 },
  ]);
  assert.equal(fixture.savedRequests.length, 3);
});

test("old encrypted MiniMax pay-as-you-go keys use the corresponding billing channel", async (t) => {
  const fixture = await setup(t, { fetch: async request => {
    assert.equal(request.url, "https://api.minimax.cn/account/query_balance");
    assert.equal(request.headers.Authorization, "Bearer sk-api-fixture-old");
    return { status: 200, bodyText: '{"base_resp":{"status_code":0},"available_amount":"12.34"}' };
  } });
  const vault = fixture.createVault();
  await vault.write(await vault.read(), [{ id: legacyId, channel: "minimax-cn", apiKey: "sk-api-fixture-old" }]);
  const balances = fixture.reboot();
  const row = (await balances.list()).configs[0];
  assert.deepEqual(row, { id: legacyId, channel: "minimax-api-cn", status: "available",
    balance: { scope: "account", amounts: [{ amount: 12.34, currency: "CNY" }] } });
  const removed = await balances.remove({ id: legacyId });
  assert.deepEqual(removed.snapshot.configs, []);
});

test("metadata from old versions survives migration and becomes usable after a one-time key entry", async (t) => {
  const fixture = await setup(t, { metadata: [{ id: legacyId, channel: "deepseek" }] });
  const balances = fixture.reboot();
  assert.deepEqual((await balances.list()).configs, [{ id: legacyId, channel: "deepseek", status: "missing-credential" }]);
  assert.equal(fixture.savedRequests.length, 0);
  const saved = await balances.save({ id: legacyId, channel: "deepseek", apiKey: sampleKey });
  assert.equal(saved.snapshot.configs[0].id, legacyId);
  assert.equal((await fixture.reboot().list()).configs[0].status, "available");
  await balances.remove({ id: legacyId });
  assert.deepEqual((await fixture.reboot().list()).configs, []);
});

test("inaccessible or tampered encrypted files are never rewritten", async (t) => {
  const fixture = await setup(t);
  const balances = fixture.reboot();
  assert.equal((await balances.save({ channel: "deepseek", apiKey: sampleKey })).ok, true);
  const before = await fs.readFile(fixture.path, "utf8");
  fixture.setUnavailable(true);
  assert.deepEqual(await balances.list(), { ok: false, code: "STORAGE_UNAVAILABLE" });
  assert.deepEqual(await balances.save({ channel: "deepseek", apiKey: sampleKey }), { ok: false, code: "STORAGE_UNAVAILABLE" });
  assert.equal(await fs.readFile(fixture.path, "utf8"), before);
  fixture.setUnavailable(false);
  const edited = JSON.parse(before);
  const tag = Buffer.from(edited.encrypted.tag, "base64");
  tag[0] ^= 1;
  edited.encrypted.tag = tag.toString("base64");
  const corrupt = JSON.stringify(edited);
  await fs.writeFile(fixture.path, corrupt, "utf8");
  assert.deepEqual(await fixture.reboot().list(), { ok: false, code: "STORAGE_DAMAGED" });
  assert.deepEqual(await fixture.reboot().save({ channel: "deepseek", apiKey: sampleKey }), { ok: false, code: "STORAGE_DAMAGED" });
  assert.equal(await fs.readFile(fixture.path, "utf8"), corrupt);
  assert.equal(fixture.savedRequests.length, 1);
});

test("a failed save never replaces the previous secret and an earlier response cannot overwrite its replacement", async (t) => {
  let pending;
  let begin;
  let pause = false;
  const entered = new Promise(resolve => { begin = resolve; });
  const finished = new Promise(resolve => { pending = resolve; });
  const fixture = await setup(t, { fetch: async ({ headers: { Authorization } }) => {
    if (Authorization.endsWith("-invalid")) return { status: 401 };
    if (Authorization.endsWith("-replacement")) return response(8.2);
    if (pause) { begin(); await finished; }
    return response(0);
  } });
  const balances = fixture.reboot();
  const saved = await balances.save({ channel: "deepseek", apiKey: sampleKey });
  const { id } = saved.snapshot.configs[0];
  const before = await fs.readFile(fixture.path, "utf8");
  assert.deepEqual(await balances.save({ id, channel: "deepseek", apiKey: `${sampleKey}-invalid` }), { ok: false, code: "UNAUTHORIZED" });
  assert.equal(await fs.readFile(fixture.path, "utf8"), before);
  assert.deepEqual(await balances.save({ id, channel: "bigmodel", apiKey: sampleKey }), { ok: false, code: "NOT_FOUND" });
  pause = true;
  const refresh = balances.list({ refresh: true });
  await entered;
  try {
    const replaced = await balances.save({ id, channel: "deepseek", apiKey: `${sampleKey}-replacement` });
    assert.equal(replaced.snapshot.configs[0].balance.amounts[0].amount, 8.2);
  } finally {
    pending();
  }
  assert.equal((await refresh).configs[0].balance.amounts[0].amount, 8.2);
  assert.equal((await fixture.reboot().list()).configs[0].balance.amounts[0].amount, 8.2);
});

test("Windows DPAPI uses the current user and transfers data through stdin", async () => {
  const directory = "C:\\profile\\balance-test";
  const plain = Buffer.from(sampleKey);
  const sealed = Buffer.from("opaque-platform-protected-fixture");
  const calls = [];
  const protector = createCredentialProtector({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    run: async (command, args, input) => {
      assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.equal(args[3], "-EncodedCommand");
      const script = Buffer.from(args[4], "base64").toString("utf16le");
      assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/);
      assert.match(script, /DataProtectionScope\]::CurrentUser/);
      assert.doesNotMatch(script, /fixture-api-key/);
      const protect = script.includes("::Protect(");
      calls.push(protect);
      assert.equal(input, (protect ? plain : sealed).toString("base64"));
      return { code: 0, stdout: (protect ? sealed : plain).toString("base64") };
    },
  });
  const blob = await protector.seal(directory, plain);
  assert.deepEqual(blob, { method: "dpapi", data: sealed.toString("base64") });
  assert.deepEqual(await protector.open(directory, blob), plain);
  assert.deepEqual(calls, [true, false]);
});

test("Linux uses the selected Secret Service with a scoped generated key", async () => {
  const plain = Buffer.from(sampleKey);
  const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus" };
  let stored;
  let account;
  const run = async (command, args, input, processEnv) => {
    assert.equal(command, "/usr/bin/secret-tool");
    assert.equal(processEnv.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
    if (args[0] === "store") {
      assert.deepEqual(args.slice(1, 5), ["--label=Token Statistics", "service", service, "account"]);
      assert.match(input, /^[a-f0-9]{64}$/);
      stored = input;
      account = args[5];
      return { code: 0, stdout: "" };
    }
    assert.deepEqual(args, ["lookup", "service", service, "account", account]);
    assert.equal(input, "");
    return { code: 0, stdout: stored };
  };
  const protector = createCredentialProtector({ platform: "linux", run, env });
  const blob = await protector.seal("/profile/balance-test", plain);
  assert.equal(blob.method, "aes-256-gcm");
  assert.deepEqual(await protector.open("/profile/balance-test", blob), plain);
});
