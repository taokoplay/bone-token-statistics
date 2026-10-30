// Backend contract harness for bone.token.statistics.
// Drives the real plugin module against a stubbed host `pi` with a synthetic
// turn universe, so paging, aggregation, naming, truncation and cost are all
// checked against known-good numbers.
const path = require("node:path");

const PLUGIN = process.env.PLUGIN_DIR || path.resolve(__dirname, "..");
const DAY = 86_400_000;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

// ── fixture: 3 projects, 4 models (one unnamed), 10 days of turns ────────────
function makeUniverse({ now, days = 10, perDay = 6 }) {
  const turns = [];
  const projects = [
    { id: 12, path: "/Users/me/Code/Framecraft" },
    { id: 7, path: "/Users/me/Code/PI-Desktop" },
    { id: 31, path: null }, // no resolvable path → must fall back to 项目 #31
  ];
  const models = [
    { id: "deepseek-v4-flash", provider: "deepseek" },
    { id: "claude-sonnet-4", provider: "anthropic" },
    { id: "gpt-5-codex", provider: "openai-codex" },
    { id: "mystery-model", provider: "custom" },
  ];
  let n = 0;
  for (let d = days - 1; d >= 0; d -= 1) {
    for (let i = 0; i < perDay; i += 1) {
      const startedAt = now - d * DAY - (perDay - i) * 60_000;
      const project = projects[n % projects.length];
      const model = models[n % models.length];
      turns.push({
        turnId: `t${n}`,
        sessionId: `s-${project.id}-${Math.floor(n / 6)}`,
        sessionTitle: `会话 ${project.id}-${Math.floor(n / 6)}`,
        projectId: project.id,
        providerId: model.provider,
        modelId: model.id,
        startedAt,
        endedAt: startedAt + 30_000,
        inputTokens: 1000 + n,
        outputTokens: 200 + (n % 7),
        cacheReadTokens: 500,
        cacheWriteTokens: 50,
        reasoningTokens: 10,
      });
      n += 1;
    }
  }
  return { turns, projects, models };
}

function makePi({ settings = {}, universe, pageSize = 7, getTimesOut = false }) {
  const calls = { listTurns: [], sessionGet: [] };
  const sorted = universe.turns.slice().sort((a, b) => a.endedAt - b.endedAt);
  return {
    calls,
    api: {
      plugin: {
        getSettings: async () => JSON.parse(JSON.stringify(settings)),
        setSettings: async () => {},
        getDataPath: async () => "/tmp/bone-stats",
      },
      app: { getLocale: async () => "zh-CN", getVersion: async () => "0.21.0" },
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { revealView: async () => {} },
      usage: {
        listTurns: async (input) => {
          calls.listTurns.push(input);
          const from = Number(input?.fromMs ?? 0);
          const to = Number(input?.toMs ?? now);
          let rows = sorted.filter((row) => row.startedAt >= from && row.startedAt <= to);
          const start = input?.cursor ? Number(input.cursor) : 0;
          const slice = rows.slice(start, start + pageSize);
          return { turns: slice, nextCursor: start + pageSize < rows.length ? String(start + pageSize) : null };
        },
      },
      desktop: {
        invoke: async (input) => {
          if (input.operation !== "project/list") throw new Error("Unexpected operation");
          if (getTimesOut) throw new Error("Catalog unavailable");
          return { projects: universe.projects.map(project => ({ id: project.id, name: "", path: project.path })) };
        },
      },
      session: {
        get: async ({ sessionId }) => {
          calls.sessionGet.push(sessionId);
          if (getTimesOut) throw new Error("boom");
          const projectId = Number(String(sessionId).split("-")[1]);
          const project = universe.projects.find((p) => p.id === projectId);
          return { sessionId, title: "x", projectPath: project?.path ?? null };
        },
      },
    },
  };
}

const now = Date.UTC(2026, 9, 29, 12, 0, 0);
const universe = makeUniverse({ now });

let mod = null;

function freshModule() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PLUGIN)) delete require.cache[key];
  }
  mod = require(path.join(PLUGIN, "main.js"));
  return mod;
}

async function snapshot(payload) {
  if (!mod) freshModule();
  return mod.onPanelInvoke("stats.snapshot", payload ?? {});
}

function expectedTotals(universe, { fromMs, toMs }) {
  const rows = universe.turns.filter((t) => t.startedAt >= fromMs && t.startedAt <= toMs);
  const tokens = rows.reduce((sum, t) => sum + t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.reasoningTokens, 0);
  return {
    turns: rows.length,
    tokens,
    input: rows.reduce((s, t) => s + t.inputTokens, 0),
    output: rows.reduce((s, t) => s + t.outputTokens, 0),
    cacheRead: rows.reduce((s, t) => s + t.cacheReadTokens, 0),
  };
}

async function main() {
  // 1. full window, paging, aggregation
  {
    freshModule();
    const env = makePi({ settings: { defaultDays: 30, maxTurns: 20000 }, universe });
    global.pi = env.api;
    const fromMs = now - 10 * DAY;
    const answer = await snapshot({ days: 10, toMs: now });
    check("snapshot ok", answer.ok === true, JSON.stringify(answer).slice(0, 160));
    const want = expectedTotals(universe, { fromMs, toMs: now });
    check("turn count matches the fixture", answer.totals.turns === want.turns, `${answer.totals.turns} vs ${want.turns}`);
    check("tokens match the fixture", answer.totals.tokens === want.tokens, `${answer.totals.tokens} vs ${want.tokens}`);
    check("input tokens match", answer.totals.input === want.input, `${answer.totals.input} vs ${want.input}`);
    check("output tokens match", answer.totals.output === want.output);
    check("cache reads are reported separately", answer.totals.cacheRead === want.cacheRead);
    check("headline excludes cache reads", answer.totals.tokensWithCacheRead === want.tokens + want.cacheRead);
    check("paging happened", env.calls.listTurns.length > 1, String(env.calls.listTurns.length));
    check("paging passes a cursor", env.calls.listTurns.some((c) => typeof c.cursor === "string"));
    check("page size is the host ceiling", env.calls.listTurns.every((c) => c.limit === 500));
    check("projects counted", answer.totals.projects === 3, String(answer.totals.projects));
    check("models counted", answer.totals.models === 4, String(answer.totals.models));
    check("providers reported", answer.providers.length === 4, JSON.stringify(answer.providers.map((p) => p.id)));
    check("ten days bucketed", answer.days.length === 10, String(answer.days.length));
    check("day buckets are ascending", answer.days.every((d, i, arr) => i === 0 || arr[i - 1].date < d.date));
    check("heat grid is 7x24", answer.heat.length === 7 && answer.heat.every((row) => row.length === 24));
    check("per-turn average", answer.totals.avgPerTurn > 0);
    check("throughput computed", answer.totals.tokensPerSecond > 0, String(answer.totals.tokensPerSecond));
    check("cache hit rate computed", typeof answer.totals.cacheHitRate === "number", String(answer.totals.cacheHitRate));
    check("no truncation on a small window", answer.truncated.hits === false);
  }

  // 2. project names : resolved from project/list, override wins, unresolved falls back
  {
    freshModule();
    const env = makePi({ settings: { defaultDays: 30, projectNames: { "7": "PI-Desktop（自定义）" } }, universe });
    global.pi = env.api;
    const answer = await snapshot({ days: 10, toMs: now });
    const byId = new Map(answer.projects.map((p) => [p.id, p]));
    check("project name resolved from the directory", byId.get(12)?.name === "Framecraft", JSON.stringify(byId.get(12)));
    check("settings override wins", byId.get(7)?.name === "PI-Desktop（自定义）", JSON.stringify(byId.get(7)));
    const orphan = byId.get(31) || {};
    check("unresolved project is labelled by id", orphan.name === null && orphan.label === "项目 #31", JSON.stringify(orphan));
    check("unresolved is disclosed in notes", answer.notes.some((n) => n.includes("项目名") || n.includes("项目 #")), JSON.stringify(answer.notes));
    check("overridden project costs no session.get", !env.calls.sessionGet.includes("s-7-1"), JSON.stringify(env.calls.sessionGet));
    check("session rows carry the project name", answer.sessions.some((s) => s.projectName === "Framecraft"));
  }

  // 3. project/list failure must not break the snapshot
  {
    freshModule();
    global.pi = makePi({ settings: { defaultDays: 30 }, universe, getTimesOut: true }).api;
    const answer = await snapshot({ days: 10, toMs: now });
    check("a failing project/list still returns numbers", answer.ok === true && answer.totals.turns > 0);
    check("names degrade to ids", answer.projects.every((p) => p.name === null && p.label === `项目 #${p.id}`));
  }

  // 4. filters : project and model narrow every panel
  {
    freshModule();
    global.pi = makePi({ settings: { defaultDays: 30 }, universe }).api;
    const answer = await snapshot({ days: 10, toMs: now, projectId: 12 });
    const want = universe.turns.filter((t) => t.projectId === 12).length;
    check("project filter applies to totals", answer.totals.turns === want, `${answer.totals.turns} vs ${want}`);
    check("project filter leaves one project", answer.projects.length === 1 && answer.projects[0].id === 12);
    check("project filter keeps other panels consistent", answer.days.reduce((s, d) => s + d.turns, 0) === want);

    const byModel = await snapshot({ days: 10, toMs: now, modelId: "claude-sonnet-4" });
    const wantModel = universe.turns.filter((t) => t.modelId === "claude-sonnet-4").length;
    check("model filter applies to totals", byModel.totals.turns === wantModel, `${byModel.totals.turns} vs ${wantModel}`);
    check("model filter leaves one model", byModel.models.length === 1 && byModel.models[0].id === "claude-sonnet-4");
    check("filter echo in payload", byModel.filters.modelId === "claude-sonnet-4");
  }

  // 5. cap + narrowing: the newest turns survive, and it says so
  {
    freshModule();
    const bigUniverse = makeUniverse({ now, days: 10, perDay: 120 }); // 1200 turns; the cap floor is one page
    const env = makePi({ settings: { defaultDays: 30, maxTurns: 500 }, universe: bigUniverse, pageSize: 100 });
    global.pi = env.api;
    const answer = await snapshot({ days: 10, toMs: now, force: true });
    check("cap is respected", answer.totals.turns <= 500, String(answer.totals.turns));
    check("truncation is reported", answer.truncated.hits === true);
    check("truncation explains itself", answer.notes.some((n) => n.includes("最近") && n.includes("轮")), JSON.stringify(answer.notes).slice(0, 160));
    const oldest = answer.totals.firstAt;
    const newest = answer.totals.lastAt;
    const fullOldest = Math.min(...bigUniverse.turns.map((t) => t.startedAt));
    check("it kept the recent end, not the oldest", oldest > fullOldest, `${oldest} vs ${fullOldest}`);
    check("the newest turn is inside the result", newest >= Math.max(...bigUniverse.turns.map((t) => t.endedAt)) - 1000, String(newest));
    check("window start moved forward", answer.window.fromMs > answer.window.requestedFromMs);
  }

  // 6. cost: none without rates, exact with rates, partial coverage disclosed
  {
    freshModule();
    global.pi = makePi({ settings: { defaultDays: 30 }, universe }).api;
    const free = await snapshot({ days: 10, toMs: now });
    check("no rates means no cost", free.cost === null);
    check("the absence is explained", free.notes.some((n) => n.includes("单价")), JSON.stringify(free.notes));

    global.pi = makePi({
      settings: {
        defaultDays: 30,
        currency: "USD",
        rates: { "claude-sonnet-4": { input: 3, output: 15 } },
      },
      universe,
    }).api;
    const priced = await snapshot({ days: 10, toMs: now });
    const model = priced.models.find((m) => m.id === "claude-sonnet-4");
    const want =
      (model.input / 1e6) * 3 +
      (model.output / 1e6) * 15 +
      (model.cacheRead / 1e6) * 3 +
      (model.cacheWrite / 1e6) * 3 +
      (model.reasoning / 1e6) * 15;
    check("cost uses the configured rate", Math.abs(priced.cost.total - want) < 0.01, `${priced.cost.total} vs ${want}`);
    check("cost currency is echoed", priced.cost.currency === "USD");
    check("unpriced models are listed", priced.cost.unpricedModels.length === 3, JSON.stringify(priced.cost.unpricedModels));
    check("partial coverage is disclosed", priced.notes.some((n) => n.includes("成本") || n.includes("单价")), JSON.stringify(priced.notes));
    check("cost rows are sorted by amount", priced.cost.byModel.every((r, i, a) => i === 0 || a[i - 1].amount >= r.amount));
  }

  // 7. empty window
  freshModule();
  {
    freshModule();
    global.pi = makePi({ settings: { defaultDays: 30 }, universe }).api;
    const empty = await snapshot({ days: 1, toMs: now - 400 * DAY });
    check("empty window still answers", empty.ok === true);
    check("empty totals are zero", empty.totals.turns === 0 && empty.totals.tokens === 0);
    check("empty state is explained", empty.notes.some((n) => n.includes("没有已完成")), JSON.stringify(empty.notes));
    check("empty days list", empty.days.length === 0);
    check("empty projects list", empty.projects.length === 0);
  }

  // 8. defaults, clamping, cache
  {
    freshModule();
    global.pi = makePi({ settings: { defaultDays: 7, maxTurns: 500 }, universe }).api;
    const answer = await snapshot({ toMs: now });
    check("defaultDays is honoured", answer.window.days === 7, String(answer.window.days));
    check("maxTurns is echoed", answer.settings.maxTurns === 500);
    check("maxTurns is floored at one page", (await snapshot({ toMs: now, force: true })).settings.maxTurns === 500);

    const clamped = await snapshot({ days: 9999, toMs: now });
    check("days are clamped to 365", clamped.window.days === 365, String(clamped.window.days));

    const first = await snapshot({ days: 10, toMs: now, force: true });
    const second = await snapshot({ days: 10, toMs: now });
    check("a repeat call is served from cache", second.cached === true && first.cached === false, `first=${first.cached} second=${second.cached}`);
    const forced = await snapshot({ days: 10, toMs: now, force: true });
    check("force bypasses the cache", forced.cached === false);
  }

  // 9. unknown channel + ping
  {
    freshModule();
    global.pi = makePi({ settings: {}, universe }).api;
    const bad = await mod.onPanelInvoke("stats.nope", {});
    check("unknown channel refused", bad.ok === false && bad.code === "UNSUPPORTED");
    const ping = await mod.onPanelInvoke("stats.ping", {});
    check("ping answers", ping.ok === true && ping.version === "0.1.1");
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
