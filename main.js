"use strict";

/**
 * BoneTokenStatistics — plugin process (`bone.token.statistics`).
 *
 * The host hands out one shape for this job: read-only, completed-turn token
 * counters (`pi.usage.listTurns`, permission `usage.read`). Everything the view
 * draws is computed here, in the plugin process, and shipped as one payload —
 * the renderer never pages, never aggregates and never talks to the host but
 * through `stats.*` channels.
 *
 * Nothing is invented: no rates means no cost, an unknown project id stays
 * `项目 #id`, and a capped read is reported as truncated instead of silently
 * pretending the numbers cover the whole window.
 */

const { summarize } = require("./lib/aggregate");
const { estimateCost, normalizeRates } = require("./lib/cost");

const DAY_MS = 86_400_000;
/** Host page size ceiling is 500. */
const PAGE_LIMIT = 500;
/** Hard stop so a broken cursor cannot spin forever. */
const MAX_PAGES = 400;
/** How many times the window start may move forward before giving up on a clean fit. */
const MAX_NARROWING = 4;
const SNAPSHOT_TTL_MS = 60_000;

const DEFAULTS = {
  defaultDays: 30,
  maxTurns: 20_000,
  rates: {},
  currency: "CNY",
  projectNames: {},
};

let snapshotCache = null;

// ── 设置 ────────────────────────────────────────────────────────────────────

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return DEFAULTS.defaultDays;
  return Math.min(365, Math.max(1, Math.round(days)));
}

function clampMaxTurns(value) {
  const turns = Number(value);
  if (!Number.isFinite(turns) || turns <= 0) return DEFAULTS.maxTurns;
  return Math.min(200_000, Math.max(PAGE_LIMIT, Math.round(turns)));
}

async function readSettings() {
  let raw = {};
  try {
    raw = (await pi.plugin.getSettings()) ?? {};
  } catch {
    raw = {};
  }
  const rates = parseJson(raw.rates, {});
  const names = parseJson(raw.projectNames, {});
  return {
    defaultDays: clampDays(raw.defaultDays),
    maxTurns: clampMaxTurns(raw.maxTurns),
    rates: rates && typeof rates === "object" && !Array.isArray(rates) ? rates : {},
    currency: raw.currency === "USD" ? "USD" : "CNY",
    projectNames: names && typeof names === "object" && !Array.isArray(names) ? names : {},
  };
}

// ── 读取轮次 ────────────────────────────────────────────────────────────────

/**
 * One ascending pass over a window. `rows` is only kept by the caller's final
 * pass; probes pass `keep: false` so a truncated window costs pages, not memory.
 *
 * The host orders rows by `endedAt` ascending, so hitting the cap keeps the
 * OLDEST rows of the window. That is why the caller narrows `fromMs` instead of
 * simply slicing: a dashboard must show the newest data, never the oldest.
 */
async function readWindow({ fromMs, toMs, maxTurns, keep }) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let count = 0;
  let complete = false;

  for (;;) {
    const page = await pi.usage.listTurns({
      fromMs,
      toMs,
      ...(cursor ? { cursor } : {}),
      limit: PAGE_LIMIT,
    });
    const batch = Array.isArray(page?.turns) ? page.turns : [];
    count += batch.length;
    pages += 1;
    if (keep) rows.push(...batch);
    cursor = page?.nextCursor ?? null;
    if (!cursor) {
      complete = true;
      break;
    }
    if (count >= maxTurns || pages >= MAX_PAGES) break;
  }

  return { rows, count, pages, complete };
}

/**
 * Reads the newest `maxTurns` turns inside the requested span by moving the
 * window start forward until the span fits. Reports how it had to cheat.
 */
async function collectTurns({ fromMs, toMs, maxTurns }) {
  let from = fromMs;
  let narrowed = 0;
  let probe = null;

  for (let attempt = 0; attempt <= MAX_NARROWING; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    probe = await readWindow({ fromMs: from, toMs, maxTurns, keep: false });
    if (probe.complete) break;
    if (attempt === MAX_NARROWING) break;
    const span = toMs - from;
    if (span <= DAY_MS) break;
    from = toMs - Math.round(span / 2);
    narrowed += 1;
  }

  const final = await readWindow({ fromMs: from, toMs, maxTurns, keep: true });
  const rows = final.rows.length > maxTurns ? final.rows.slice(-maxTurns) : final.rows;
  return {
    rows,
    pages: final.pages + (narrowed > 0 ? 1 : 0),
    truncated: !final.complete || narrowed > 0,
    fromMs: from,
    requestedFromMs: fromMs,
    narrowed,
  };
}

// ── 项目名 ──────────────────────────────────────────────────────────────────

/** Resolve current host project metadata without reading any session transcript. */
async function resolveProjectNames(projects, settings) {
  const names = {};
  const catalog = new Map();
  let issue = null;
  if (projects.some(project => !(typeof settings.projectNames?.[String(project.id)] === "string" && settings.projectNames[String(project.id)].trim()))) {
    try {
      const result = await pi.desktop.invoke({ operation: "project/list", args: [] });
      if (!Array.isArray(result?.projects)) throw Object.assign(new Error("Invalid project catalog"), { code: "INVALID_RESPONSE" });
      for (const project of result.projects) {
        if (!project || project.id === null || project.id === undefined || !Number.isSafeInteger(Number(project.id))) continue;
        const name = typeof project.name === "string" ? project.name.trim() : "";
        const directory = typeof project.path === "string" ? project.path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() : "";
        if (name || directory) catalog.set(Number(project.id), name || directory);
      }
    } catch (error) {
      const denied = /PERMISSION|permission|权限/.test(String(error?.code || error?.errorCode || "") + String(error?.message || ""));
      issue = denied
        ? "无法读取项目名称：请在插件页面重新加载或升级插件，并授权 desktop.control 权限。统计数据不受影响。"
        : "宿主项目列表暂不可用，请刷新重试，并确认当前宿主支持 project/list 与 desktop.control。统计数据不受影响。";
    }
  }
  let unresolved = 0;
  for (const project of projects) {
    const override = settings.projectNames?.[String(project.id)];
    const name = typeof override === "string" && override.trim() ? override.trim() : catalog.get(project.id);
    if (name) names[project.id] = name;
    else unresolved += 1;
  }
  return { names, unresolved, issue };
}

// ── 快照 ────────────────────────────────────────────────────────────────────

function cacheKey(params) {
  return JSON.stringify(params);
}

/**
 * @param {{ days?: number, fromMs?: number, toMs?: number,
 *           projectId?: number|null, modelId?: string|null,
 *           force?: boolean }} input
 */
async function buildSnapshot(input = {}) {
  const settings = await readSettings();
  const now = Date.now();
  const toMs = Number.isFinite(Number(input.toMs)) ? Number(input.toMs) : now;
  const days = clampDays(input.days ?? settings.defaultDays);
  const requestedFromMs = Number.isFinite(Number(input.fromMs))
    ? Number(input.fromMs)
    : toMs - days * DAY_MS;
  // `Number(null)` is 0: a missing filter must not become "project 0".
  const requestedProjectId = input.projectId;
  const projectId =
    requestedProjectId === null || requestedProjectId === undefined || requestedProjectId === ""
      ? null
      : Number.isFinite(Number(requestedProjectId))
        ? Number(requestedProjectId)
        : null;
  const modelId = typeof input.modelId === "string" && input.modelId ? input.modelId : null;

  // The key carries the settings the payload depends on: changing a rate or a
  // project label must not be answered from a snapshot computed without it.
  const key = cacheKey({
    toMs,
    requestedFromMs,
    projectId,
    modelId,
    maxTurns: settings.maxTurns,
    currency: settings.currency,
    rates: settings.rates,
    projectNames: settings.projectNames,
  });
  if (input.force !== true && snapshotCache && snapshotCache.key === key &&
      Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return { ...snapshotCache.payload, cached: true };
  }

  const read = await collectTurns({ fromMs: requestedFromMs, toMs, maxTurns: settings.maxTurns });

  // Filtering happens here, not at the host, so every panel of the payload
  // respects the same selection.
  const rows = read.rows.filter((row) => {
    if (projectId !== null && Number(row?.projectId) !== projectId) return false;
    if (modelId !== null && String(row?.modelId ?? "") !== modelId) return false;
    return true;
  });

  const summary = summarize(rows, { now, fromMs: read.fromMs, toMs });

  const { names, unresolved, issue } = await resolveProjectNames(summary.projects, settings);
  for (const project of summary.projects) {
    if (names[project.id]) project.name = names[project.id];
    else project.label = `项目 #${project.id}`;
  }
  for (const session of summary.sessions) {
    if (session.projectId !== null && names[session.projectId]) session.projectName = names[session.projectId];
  }

  const cost = estimateCost(summary, settings.rates, settings.currency);
  const rates = normalizeRates(settings.rates);

  const notes = [];
  if (issue) notes.push(issue);
  if (read.truncated) {
    notes.push(
      `数据量超过上限：只统计了最近 ${settings.maxTurns} 轮（窗口起点已前移到 ${new Date(read.fromMs).toLocaleString()}）。可在插件设置里调大「最多读取的轮次数」。`,
    );
  }
  if (unresolved > 0) {
    notes.push(`${unresolved} 个项目未找到可用名称，已显示为「项目 #id」；可在设置里手工命名。`);
  }
  if (Object.keys(rates).length === 0) {
    notes.push("未配置单价，因此不显示金额。");
  } else if (cost && cost.unpricedModels.length > 0) {
    notes.push(`成本只包含已配置单价的模型；未配置：${cost.unpricedModels.slice(0, 6).join("、")}${cost.unpricedModels.length > 6 ? " 等" : ""}。`);
  }
  if (summary.totals.turns === 0) {
    notes.push("这个时间范围内没有已完成的轮次。");
  }

  const payload = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    window: {
      ...summary.window,
      requestedFromMs,
      fromMs: read.fromMs,
      toMs,
      days,
    },
    truncated: {
      hits: read.truncated,
      limit: settings.maxTurns,
      pages: read.pages,
    },
    filters: { projectId, modelId },
    settings: {
      currency: settings.currency,
      defaultDays: settings.defaultDays,
      maxTurns: settings.maxTurns,
      ratesConfigured: Object.keys(rates).length,
    },
    totals: summary.totals,
    days: summary.days,
    heat: summary.heat,
    projects: summary.projects,
    models: summary.models,
    providers: summary.providers,
    sessions: summary.sessions,
    cost,
    notes,
  };

  snapshotCache = { at: Date.now(), key, payload };
  return { ...payload, cached: false };
}

// ── 通道 ────────────────────────────────────────────────────────────────────

const CHANNELS = {
  /** The whole dashboard in one answer. */
  "stats.snapshot": (payload) => buildSnapshot(payload ?? {}),
  /** Cheap identity check for the view header. */
  "stats.ping": async () => {
    const settings = await readSettings();
    return { ok: true, version: "0.1.2", defaultDays: settings.defaultDays, currency: settings.currency };
  },
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return { ok: false, code: error?.code ?? "ERROR", message: error?.message ?? String(error) };
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onLoad() {
  try {
    await pi.commands.register({
      id: "bone.stats.open",
      title: "BoneTokenStatistics: 打开统计",
      keywords: ["token", "usage", "统计", "用量"],
      run: async () => {
        await pi.ui.revealView({ viewId: "stats" });
      },
    });
  } catch {
    /* 命令注册失败不影响视图 */
  }
}

async function onUnload() {
  snapshotCache = null;
  try {
    await pi.commands.unregister("bone.stats.open");
  } catch {
    /* 尽力而为 */
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
