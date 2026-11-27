"use strict";

const { randomUUID } = require("node:crypto");
const { channels, makeRequest, migrateStoredChannel } = require("./balance-providers");
const { createBalanceVault } = require("./balance-vault");
const { storageError } = require("./credential-protection");

const CHANNEL_IDS = new Set(channels.map(({ id }) => id));
const MAX_CONFIGS = 16;
const MAX_CONFIG_NAME_LENGTH = 64;
const MAX_BODY_BYTES = 256 * 1024;
const QUERY_TIMEOUT_MS = 8_000;
const REFRESH_CONCURRENCY = 8;
const CONFIG_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => ({ ok: false, code });

function isValidKey(key) {
  return typeof key === "string" && key.length <= 4096 && /^[\x21-\x7E]+$/.test(key);
}

function normalizeConfigName(value) {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length > MAX_CONFIG_NAME_LENGTH || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return undefined;
  return name;
}

function validConfig(config) {
  return typeof config?.id === "string" && CONFIG_ID.test(config.id) && CHANNEL_IDS.has(config.channel);
}

async function readConfigs(api, vault) {
  const stored = await vault.read();
  if (stored.raw === null) {
    // Older releases saved channel metadata only.
    const legacy = (await api.getSettings())?.balanceConfigs;
    const configs = new Map();
    for (const item of Array.isArray(legacy) ? legacy : []) {
      if (!validConfig(item)) continue;
      configs.set(item.id, { id: item.id, channel: item.channel });
      if (configs.size === MAX_CONFIGS) break;
    }
    return { stored, configs: [...configs.values()] };
  }
  const configs = stored.configs;
  if (!Array.isArray(configs) || configs.length > MAX_CONFIGS ||
      configs.some(config => !validConfig(config) || (config.apiKey !== undefined && !isValidKey(config.apiKey))) ||
      new Set(configs.map(config => config.id)).size !== configs.length) {
    throw storageError("STORAGE_DAMAGED");
  }
  return { stored, configs: configs.map(config => ({ ...config, channel: migrateStoredChannel(config.channel, config.apiKey) })) };
}

async function query(api, channel, key, isCurrent) {
  try {
    const request = makeRequest(channel, key);
    if (!request) return fail("INVALID_CHANNEL");
    if (request.error) return fail(request.error);
    const capabilities = await api.getCapabilities();
    if (!Array.isArray(capabilities?.fetchRedirectModes) || !capabilities.fetchRedirectModes.includes("error")) {
      return fail("UNSUPPORTED");
    }
    if (!isCurrent()) return fail("UNAVAILABLE");
    const response = await api.fetch({
      url: request.url,
      method: "GET",
      headers: { Authorization: request.authorization, Accept: "application/json" },
      timeoutMs: QUERY_TIMEOUT_MS,
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return fail(request.queryFailure ?? "UNAUTHORIZED");
    if (response.status !== 200 || typeof response.bodyText !== "string" ||
        Buffer.byteLength(response.bodyText) > MAX_BODY_BYTES) return fail("UNAVAILABLE");
    const balance = request.parse(JSON.parse(response.bodyText));
    return balance ? { ok: true, balance } : fail(request.queryFailure ?? "UNAVAILABLE");
  } catch (error) {
    // Raw transport errors can include credentials or response bodies.
    return fail(error?.code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "UNAVAILABLE");
  }
}

function rowResult(result) {
  if (result.ok) return { status: "available", balance: result.balance };
  const statuses = {
    UNAUTHORIZED: "unauthorized", PERMISSION_DENIED: "permission-denied", UNSUPPORTED: "unsupported",
    MINIMAX_PLAN_UNAVAILABLE: "minimax-plan-unavailable", MINIMAX_PAYGO_KEY_REQUIRED: "unauthorized",
  };
  return { status: statuses[result.code] ?? "unavailable" };
}

function storageFailure(error) {
  if (error?.code === "BUSY" || error?.code === "STORAGE_DAMAGED") return fail(error.code);
  return fail("STORAGE_UNAVAILABLE");
}

function createBalances(api, vault = createBalanceVault({ getDataPath: api.getDataPath })) {
  const makeState = () => ({ entries: new Map(), refreshing: null, editing: false, revision: 0, checkedAt: null });
  let current = makeState();

  function matchingEntry(state, config) {
    const entry = state.entries.get(config.id);
    return entry?.channel === config.channel && entry.key === config.apiKey ? entry : undefined;
  }

  function snapshot(configs, state) {
    return {
      ok: true,
      channels,
      checkedAt: state.checkedAt,
      configs: configs.map(config => {
        const name = normalizeConfigName(config.name);
        return {
          id: config.id,
          channel: config.channel,
          ...(name ? { name } : {}),
          ...(matchingEntry(state, config)?.result ?? { status: config.apiKey ? "unavailable" : "missing-credential" }),
        };
      }),
    };
  }

  async function refresh(configs, state, revision) {
    const isCurrent = () => state === current && state.revision === revision;
    for (let start = 0; start < configs.length && isCurrent(); start += REFRESH_CONCURRENCY) {
      await Promise.all(configs.slice(start, start + REFRESH_CONCURRENCY).map(async config => {
        const result = await query(api, config.channel, config.apiKey, isCurrent);
        if (isCurrent()) state.entries.set(config.id, { channel: config.channel, key: config.apiKey, result: rowResult(result) });
      }));
    }
    if (isCurrent()) state.checkedAt = Date.now();
  }

  async function list(input) {
    const state = current;
    const revision = state.revision;
    try {
      let { configs } = await readConfigs(api, vault);
      if (state !== current) return fail("UNAVAILABLE");
      if (revision === state.revision) {
        const targets = configs.filter(config => config.apiKey && (input?.refresh === true || !matchingEntry(state, config)));
        if (targets.length) {
          if (!state.refreshing) state.refreshing = refresh(targets, state, revision).finally(() => { state.refreshing = null; });
          await state.refreshing;
        }
      }
      if (revision !== state.revision) ({ configs } = await readConfigs(api, vault));
      return state === current ? snapshot(configs, state) : fail("UNAVAILABLE");
    } catch (error) {
      return storageFailure(error);
    }
  }

  async function edit(action) {
    const state = current;
    if (state.editing) return fail("BUSY");
    state.editing = true;
    try {
      const { stored, configs } = await readConfigs(api, vault);
      if (state !== current) return fail("UNAVAILABLE");
      return await action({ stored, configs, state });
    } catch (error) {
      return storageFailure(error);
    } finally {
      state.editing = false;
    }
  }

  function save(input) {
    const { id, channel, apiKey, name } = input ?? {};
    if (!CHANNEL_IDS.has(channel)) return fail("INVALID_CHANNEL");
    const label = normalizeConfigName(name);
    if (name !== undefined && label === undefined) return fail("INVALID_NAME");
    if (apiKey !== undefined && typeof apiKey !== "string") return fail("INVALID_KEY");
    const key = apiKey?.trim() ?? "";
    if (key && !isValidKey(key)) return fail("INVALID_KEY");
    return edit(async ({ stored, configs, state }) => {
      const existing = id === undefined ? undefined : configs.find(config => config.id === id);
      if (id !== undefined && existing?.channel !== channel) return fail("NOT_FOUND");
      if (!key && !existing?.apiKey) return fail("INVALID_KEY");
      if (!existing && configs.length >= MAX_CONFIGS) return fail("LIMIT_EXCEEDED");
      const result = key ? await query(api, channel, key, () => state === current) : null;
      if (result && !result.ok) return result;
      if (state !== current) return fail("UNAVAILABLE");
      const configName = label ?? normalizeConfigName(existing?.name);
      const config = {
        id: existing?.id ?? randomUUID(),
        channel,
        apiKey: key || existing.apiKey,
        ...(configName ? { name: configName } : {}),
      };
      const next = existing ? configs.map(item => item.id === config.id ? config : item) : [...configs, config];
      await vault.write(stored, next);
      if (state !== current) return fail("UNAVAILABLE");
      state.revision += 1;
      if (result) {
        state.entries.set(config.id, { channel, key, result: rowResult(result) });
        state.checkedAt = Date.now();
      }
      return { ok: true, snapshot: snapshot(next, state) };
    });
  }

  function remove(input) {
    return edit(async ({ stored, configs, state }) => {
      const next = configs.filter(config => config.id !== input?.id);
      if (next.length === configs.length) return fail("NOT_FOUND");
      if (stored.raw === null) await api.setSettings({ balanceConfigs: next });
      else await vault.write(stored, next);
      if (state !== current) return fail("UNAVAILABLE");
      state.revision += 1;
      state.entries.delete(input.id);
      if (!state.entries.size) state.checkedAt = null;
      return { ok: true, snapshot: snapshot(next, state) };
    });
  }

  return {
    list,
    save,
    remove,
    clear() {
      current.entries.clear();
      current = makeState();
    },
  };
}

module.exports = { createBalances };
