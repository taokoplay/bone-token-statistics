// Unit tests for the pure aggregation and cost modules: hand-computed numbers,
// no host, no clock.
const path = require("node:path");
const assert = require("node:assert/strict");

const PLUGIN = process.env.PLUGIN_DIR || path.resolve(__dirname, "..");
const { summarize, dayKey, weekdayIndex, tokensOf } = require(path.join(PLUGIN, "lib/aggregate.js"));
const { estimateCost, normalizeRates } = require(path.join(PLUGIN, "lib/cost.js"));

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
};

const DAY = 86_400_000;
// Fixed local date: Sunday 2026-10-25 10:00 local time, so weekday math is checkable.
const base = new Date(2026, 9, 25, 10, 0, 0).getTime();

function turn(overrides) {
  return {
    turnId: "t",
    sessionId: "s1",
    sessionTitle: "S",
    projectId: 1,
    providerId: "p",
    modelId: "m",
    startedAt: base,
    endedAt: base + 1000,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 1000,
    cacheWriteTokens: 5,
    reasoningTokens: 1,
    ...overrides,
  };
}

// ── token semantics ─────────────────────────────────────────────────────────
check("tokens exclude cache reads", () => {
  const t = turn();
  assert.equal(tokensOf({ ...t, input: 100, output: 10, cacheWrite: 5, reasoning: 1 }), 116);
});

check("dayKey is local and zero padded", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 30).getTime()), "2026-01-05");
});

check("weekdayIndex is Monday-first", () => {
  assert.equal(weekdayIndex(new Date(2026, 9, 25).getTime()), 6); // Sunday
  assert.equal(weekdayIndex(new Date(2026, 9, 26).getTime()), 0); // Monday
});

// ── summarize over a hand-built fixture ─────────────────────────────────────
const rows = [
  // day 1 (Sunday), project 1, model a
  turn({ turnId: "1", startedAt: base, endedAt: base + 2000, modelId: "a", projectId: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 1 }),
  // day 1, project 1, model b
  turn({ turnId: "2", startedAt: base + 3600_000, endedAt: base + 3601_000, modelId: "b", projectId: 1, inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
  // day 2 (Monday), project 2, model a
  turn({ turnId: "3", startedAt: base + DAY, endedAt: base + DAY + 1000, modelId: "a", projectId: 2, sessionId: "s2", inputTokens: 300, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 2 }),
];

const summary = summarize(rows, { now: base + DAY + 1000, fromMs: base, toMs: base + 2 * DAY });

check("totals add up", () => {
  assert.equal(summary.totals.input, 600);
  assert.equal(summary.totals.output, 60);
  assert.equal(summary.totals.cacheRead, 60);
  assert.equal(summary.totals.cacheWrite, 5);
  assert.equal(summary.totals.reasoning, 3);
  assert.equal(summary.totals.tokens, 600 + 60 + 5 + 3);
  assert.equal(summary.totals.tokensWithCacheRead, 600 + 60 + 5 + 3 + 60);
  assert.equal(summary.totals.turns, 3);
});

check("sessions and projects are counted distinctly", () => {
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.totals.projects, 2);
  assert.equal(summary.totals.models, 2);
});

check("day buckets keep their own numbers", () => {
  assert.equal(summary.days.length, 2);
  assert.equal(summary.days[0].turns, 2);
  assert.equal(summary.days[0].tokens, 100 + 10 + 5 + 1 + 200 + 20);
  assert.equal(summary.days[1].turns, 1);
  assert.equal(summary.days[1].tokens, 300 + 30 + 2);
});

check("heat indexes weekday × hour", () => {
  assert.equal(summary.heat[6][10], 116); // Sunday 10:00 → first turn
  assert.equal(summary.heat[6][11], 220); // Sunday 11:00 → second turn
  assert.equal(summary.heat[0][10], 332); // Monday 10:00 → third turn
  const total = summary.heat.flat().reduce((a, b) => a + b, 0);
  assert.equal(total, summary.totals.tokens);
});

check("model shares are ordered and add up", () => {
  const modelA = summary.models.find((m) => m.id === "a");
  const modelB = summary.models.find((m) => m.id === "b");
  assert.equal(modelA.tokens, 116 + 332);
  assert.equal(modelB.tokens, 220);
  assert.ok(modelA.share > modelB.share);
  assert.equal(summary.models[0].id, "a");
  assert.equal(modelA.avgPerTurn, Math.round(((116 + 332) / 2) * 10) / 10);
});

check("per-model throughput divides by the summed duration", () => {
  const modelA = summary.models.find((m) => m.id === "a");
  const ms = 2000 + 1000;
  assert.equal(modelA.tokensPerSecond, Math.round((448 / (ms / 1000)) * 100) / 100);
});

check("project rows carry their model breakdown", () => {
  const project1 = summary.projects.find((p) => p.id === 1);
  assert.equal(project1.turns, 2);
  assert.equal(project1.sessions ?? project1.sessions, 1);
  assert.deepEqual(project1.models.map((m) => m.modelId).sort(), ["a", "b"]);
  assert.equal(project1.models.find((m) => m.modelId === "a").tokens, 116);
});

check("provider totals are complete", () => {
  assert.equal(summary.providers.length, 1);
  assert.equal(summary.providers[0].tokens, summary.totals.tokens);
});

check("top sessions are sorted by tokens", () => {
  assert.equal(summary.sessions.length, 2);
  assert.ok(summary.sessions[0].tokens >= summary.sessions[1].tokens);
  assert.equal(summary.sessions[0].sessionId, "s1");
  assert.equal(summary.sessions[0].tokens, 336);
  assert.equal(summary.sessions[1].tokens, 332);
});

check("cache hit rate uses input + cacheRead", () => {
  assert.equal(summary.totals.cacheHitRate, Math.round((60 / (600 + 60)) * 1000) / 10);
});

check("streak counts back from today", () => {
  // now is day 2; day 2 and day 1 both have turns → 2
  assert.equal(summary.totals.streak, 2);
});

check("streak tolerates today having no turns yet", () => {
  // now = day 3, nothing on day 3, but day 2 + day 1 have turns
  const later = summarize(rows, { now: base + 2 * DAY, fromMs: base, toMs: base + 4 * DAY });
  assert.equal(later.totals.streak, 2);
});

check("no input at all means no cache hit rate", () => {
  const empty = summarize([], { now: base, fromMs: base - DAY, toMs: base });
  assert.equal(empty.totals.cacheHitRate, null);
  assert.equal(empty.totals.tokens, 0);
  assert.equal(empty.totals.streak, 0);
  assert.deepEqual(empty.days, []);
});

check("unknown model and project ids degrade, not crash", () => {
  const odd = summarize([turn({ modelId: null, providerId: null, projectId: null })], { now: base, fromMs: base - DAY, toMs: base + DAY });
  assert.equal(odd.models[0].id, "unknown");
  assert.equal(odd.providers[0].id, "unknown");
  assert.equal(odd.projects.length, 0); // a null project id is not invented as a project
  assert.equal(odd.totals.turns, 1);
});

check("rows are sorted before aggregation", () => {
  const shuffled = [rows[2], rows[0], rows[1]];
  const again = summarize(shuffled, { now: base + DAY + 1000, fromMs: base, toMs: base + 2 * DAY });
  assert.deepEqual(again.days.map((d) => d.date), summary.days.map((d) => d.date));
  assert.equal(again.totals.tokens, summary.totals.tokens);
});

// ── cost ────────────────────────────────────────────────────────────────────
check("rates normalize: junk is dropped, numbers kept", () => {
  const rates = normalizeRates({
    a: { input: 1, output: 2 },
    b: { input: "3" },
    c: { nonsense: 5 },
    d: "nope",
  });
  assert.deepEqual(Object.keys(rates).sort(), ["a", "b"]);
  assert.equal(rates.b.input, 3);
});

check("no rates means no cost", () => {
  assert.equal(estimateCost({ models: [{ id: "a", tokens: 1 }] }, {}, "CNY"), null);
});

check("cost uses per-field rates and falls back", () => {
  const models = [{ id: "a", tokens: 1_000_000, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 1_000_000 }];
  const cost = estimateCost({ models }, { a: { input: 1, output: 10 } }, "USD");
  // input 1 + output 10 + cacheRead 1 (input fallback) + cacheWrite 1 + reasoning 10 (output fallback)
  assert.equal(cost.total, 23);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.byModel[0].share, 100);
});

check("unpriced models are reported, not costed", () => {
  const models = [
    { id: "a", tokens: 1_000_000, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { id: "b", tokens: 2_000_000, input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  ];
  const cost = estimateCost({ models }, { a: { input: 2 } }, "CNY");
  assert.equal(cost.total, 2);
  assert.deepEqual(cost.unpricedModels, ["b"]);
  assert.equal(cost.unpricedTokens, 2_000_000);
  assert.equal(cost.pricedTokens, 1_000_000);
});

check("a rate table with only unknown models is no cost", () => {
  const models = [{ id: "a", tokens: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }];
  assert.equal(estimateCost({ models }, { zzz: { input: 1 } }, "CNY"), null);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
