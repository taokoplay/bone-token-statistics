"use strict";

const { randomUUID } = require("node:crypto");
const { channels, makeRequest } = require("./balance-providers");

const CHANNEL_IDS = new Set(channels.map(({ id }) => id));
const MAX_CONFIGS = 16;
const MAX_BODY_BYTES = 256 * 1024;
const QUERY_TIMEOUT_MS = 8_000;
const REFRESH_CONCURRENCY = 6;
const CONFIG_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => ({ ok: false, code });

async function readConfigs(api) {
  const configured = (await api.getSettings())?.balanceConfigs;
  if (!Array.isArray(configured)) return [];
  const configs = new Map();
  for (const item of configured) {
    if (typeof item?.id !== "string" || !CONFIG_ID.test(item.id) || !CHANNEL_IDS.has(item.channel)) continue;
    configs.set(item.id, { id: item.id, channel: item.channel });
    if (configs.size >= MAX_CONFIGS) break;
  }
  return [...configs.values()];
}

async function query(api, channel, key, isCurrent) {
  try {
    const capabilities = await api.getCapabilities();
    if (!Array.isArray(capabilities?.fetchRedirectModes) || !capabilities.fetchRedirectModes.includes("error")) {
      return fail("UNSUPPORTED");
    }
    if (!isCurrent()) return fail("UNAVAILABLE");
    const request = makeRequest(channel, key);
    const response = await api.fetch({
      url: request.url,
      method: "GET",
      headers: { Authorization: request.authorization, Accept: "application/json" },
      timeoutMs: QUERY_TIMEOUT_MS,
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return fail("UNAUTHORIZED");
    if (response.status !== 200 || typeof response.bodyText !== "string" ||
        Buffer.byteLength(response.bodyText) > MAX_BODY_BYTES) return fail("UNAVAILABLE");
    const balance = request.parse(JSON.parse(response.bodyText));
    return balance ? { ok: true, balance } : fail("UNAVAILABLE");
  } catch (error) {
    // Raw transport errors can include credentials or response bodies.
    return fail(error?.code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "UNAVAILABLE");
  }
}

function rowResult(result) {
  if (result.ok) return { status: "available", balance: result.balance };
  const statuses = { UNAUTHORIZED: "unauthorized", PERMISSION_DENIED: "permission-denied", UNSUPPORTED: "unsupported" };
  return { status: statuses[result.code] ?? "unavailable" };
}

function createBalances(api) {
  const makeState = () => ({ entries: new Map(), refreshing: null, editing: false, checkedAt: null });
  let current = makeState();

  function matchingEntry(state, config) {
    const entry = state.entries.get(config.id);
    return entry?.channel === config.channel ? entry : undefined;
  }

  function snapshot(configs, state) {
    return {
      ok: true,
      channels,
      checkedAt: state.checkedAt,
      configs: configs.map(config => ({
        ...config,
        ...(matchingEntry(state, config)?.result ?? { status: "missing-credential" }),
      })),
    };
  }

  async function refresh(configs, state) {
    const active = configs.filter(config => matchingEntry(state, config));
    for (let start = 0; start < active.length && state === current; start += REFRESH_CONCURRENCY) {
      await Promise.all(active.slice(start, start + REFRESH_CONCURRENCY).map(async config => {
        const session = matchingEntry(state, config);
        if (!session) return;
        const isCurrent = () => state === current && matchingEntry(state, config) === session;
        const result = await query(api, config.channel, session.key, isCurrent);
        if (isCurrent()) session.result = rowResult(result);
      }));
    }
    if (active.length && state === current) state.checkedAt = Date.now();
  }

  async function list(input) {
    const state = current;
    try {
      const configs = await readConfigs(api);
      if (input?.refresh === true && state === current && state.entries.size) {
        if (!state.refreshing) state.refreshing = refresh(configs, state).finally(() => { state.refreshing = null; });
        await state.refreshing;
        // Saving or removing a config while refreshing may change what should be displayed.
        const latest = await readConfigs(api);
        return state === current ? snapshot(latest, state) : fail("UNAVAILABLE");
      }
      return state === current ? snapshot(configs, state) : fail("UNAVAILABLE");
    } catch {
      return fail("UNAVAILABLE");
    }
  }

  async function edit(action) {
    const state = current;
    if (state.editing) return fail("BUSY");
    state.editing = true;
    try {
      const configs = await readConfigs(api);
      if (state !== current) return fail("UNAVAILABLE");
      return await action({ configs, state });
    } catch {
      return fail("UNAVAILABLE");
    } finally {
      state.editing = false;
    }
  }

  function save(input) {
    const { id, channel, apiKey } = input ?? {};
    if (!CHANNEL_IDS.has(channel)) return fail("INVALID_CHANNEL");
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key || key.length > 4096 || !/^[\x21-\x7E]+$/.test(key)) return fail("INVALID_KEY");
    return edit(async ({ configs, state }) => {
      const existing = id === undefined ? undefined : configs.find(config => config.id === id);
      if (id !== undefined && existing?.channel !== channel) return fail("NOT_FOUND");
      if (!existing && configs.length >= MAX_CONFIGS) return fail("LIMIT_EXCEEDED");
      const result = await query(api, channel, key, () => state === current);
      if (!result.ok) return result;
      if (state !== current) return fail("UNAVAILABLE");
      const config = existing ?? { id: randomUUID(), channel };
      const next = existing ? configs : [...configs, config];
      if (!existing) await api.setSettings({ balanceConfigs: next });
      if (state !== current) return fail("UNAVAILABLE");
      state.entries.set(config.id, { channel, key, result: rowResult(result) });
      state.checkedAt = Date.now();
      return { ok: true, snapshot: snapshot(next, state) };
    });
  }

  function remove(input) {
    return edit(async ({ configs, state }) => {
      const next = configs.filter(config => config.id !== input?.id);
      if (next.length === configs.length) return fail("NOT_FOUND");
      await api.setSettings({ balanceConfigs: next });
      if (state !== current) return fail("UNAVAILABLE");
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
