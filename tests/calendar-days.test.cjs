"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const plugin = require("../main.js");

// Isolated by the Node test runner. Explicit offsets below describe the expected
// calendar boundaries independently of the plugin's date arithmetic.
process.env.TZ = "America/New_York";
const ms = Date.parse;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function turn(endedAt, inputTokens, projectId = 1, modelId = "model-a") {
  return { turnId: `turn-${endedAt}`, startedAt: endedAt - 60_000, endedAt, inputTokens, projectId, modelId };
}

function host(t, turns, getTime, settings = { defaultDays: 7 }) {
  t.mock.method(Date, "now", getTime);
  globalThis.pi = {
    plugin: { getSettings: async () => settings },
    desktop: { invoke: async () => ({ projects: [{ id: 1, name: "Project A" }, { id: 2, name: "Project B" }] }) },
    usage: { listTurns: async ({ fromMs, toMs, cursor, limit }) => {
      assert.ok(Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && toMs >= fromMs);
      const matching = turns.filter(row => fromMs <= row.endedAt && row.endedAt <= toMs);
      const offset = Number(cursor || 0);
      return { turns: matching.slice(offset, offset + limit), nextCursor: offset + limit < matching.length ? String(offset + limit) : null };
    } },
  };
  t.after(async () => {
    await plugin.onUnload();
    delete globalThis.pi;
  });
  return async (input) => {
    const answer = await plugin.onPanelInvoke("stats.snapshot", input);
    assert.equal(answer.ok, true, answer.message);
    return answer;
  };
}

function assertWindow(view, range, fromMs, toMs) {
  assert.deepEqual(view.window, { days: 1, range, requestedFromMs: fromMs, fromMs, toMs });
}

test("calendar snapshots partition completed turns at local midnight", async (t) => {
  const yesterdayStart = ms("2026-10-28T00:00:00-04:00");
  const todayStart = ms("2026-10-29T00:00:00-04:00");
  const now = ms("2026-10-29T08:30:00-04:00");
  const snapshot = host(t, [
    turn(yesterdayStart - 1, 900), turn(yesterdayStart, 10), turn(todayStart - 1, 20),
    turn(todayStart, 30), turn(now, 40, 2, "model-b"), turn(now + 1, 900),
  ], () => now);

  const today = await snapshot({ range: "today" });
  assertWindow(today, "today", todayStart, now);
  assert.deepEqual(today.days.map(({ date, tokens }) => [date, tokens]), [["2026-10-29", 70]]);
  assert.equal(today.totals.tokens, 70);
  assert.equal(today.heat[3][0], 30);
  assert.equal(today.heat[2][23], 0);

  const yesterday = await snapshot({ range: "yesterday" });
  assertWindow(yesterday, "yesterday", yesterdayStart, todayStart - 1);
  assert.deepEqual(yesterday.days.map(({ date, tokens }) => [date, tokens]), [["2026-10-28", 30]]);
  assert.equal(yesterday.totals.streak, 1);
  assert.equal(yesterday.totals.tokens, 30);

  const filtered = await snapshot({ range: "today", projectId: 2, modelId: "model-b" });
  assertWindow(filtered, "today", todayStart, now);
  assert.deepEqual(filtered.filters, { projectId: 2, modelId: "model-b" });
  assert.equal(filtered.totals.tokens, 40);

  const rolling = await snapshot({ days: 7, toMs: now });
  assert.deepEqual(rolling.window, { days: 7, requestedFromMs: now - 7 * DAY, fromMs: now - 7 * DAY, toMs: now });
  assert.equal(rolling.totals.tokens, 1000);
  assert.equal(rolling.days.find(day => day.date === "2026-10-28").tokens, 50);
});

test("today and yesterday roll forward on the next read within the cache TTL", async (t) => {
  const midnight = ms("2026-11-01T00:00:00-04:00");
  let now = midnight - 1;
  const snapshot = host(t, [turn(midnight - 1, 18), turn(midnight, 21)], () => now);

  const previousToday = await snapshot({ range: "today" });
  assert.deepEqual(previousToday.days.map(day => day.date), ["2026-10-31"]);
  assert.equal((await snapshot({ range: "today" })).cached, true);
  now = midnight;
  const today = await snapshot({ range: "today" });
  assertWindow(today, "today", midnight, midnight);
  assert.equal(today.cached, false);
  assert.equal(today.totals.tokens, 21);

  now = midnight - 1;
  const previousYesterday = await snapshot({ range: "yesterday" });
  assert.equal(previousYesterday.totals.tokens, 0);
  now = midnight;
  const yesterday = await snapshot({ range: "yesterday" });
  assert.equal(yesterday.cached, false);
  assert.deepEqual(yesterday.days.map(day => day.date), ["2026-10-31"]);
  assert.equal(yesterday.totals.tokens, 18);
  assert.equal((await snapshot({ range: "yesterday" })).cached, true);
  assert.equal((await snapshot({ range: "yesterday", force: true })).cached, false);
});

for (const { date, start, next, hours } of [
  { date: "2026-03-08", start: "2026-03-08T00:00:00-05:00", next: "2026-03-09T00:00:00-04:00", hours: 23 },
  { date: "2026-11-01", start: "2026-11-01T00:00:00-04:00", next: "2026-11-02T00:00:00-05:00", hours: 25 },
]) {
  test(`yesterday covers all ${hours} hours of local day ${date}`, async (t) => {
    const fromMs = ms(start);
    const midnight = ms(next);
    const snapshot = host(t, [turn(fromMs - 1, 100), turn(fromMs, 5), turn(midnight - 1, 10), turn(midnight, 100)],
      () => midnight + HOUR);
    const yesterday = await snapshot({ range: "yesterday" });
    assertWindow(yesterday, "yesterday", fromMs, midnight - 1);
    assert.equal(yesterday.window.toMs + 1 - yesterday.window.fromMs, hours * HOUR);
    assert.deepEqual(yesterday.days.map(({ date, tokens }) => [date, tokens]), [[date, 15]]);
    assert.equal(yesterday.totals.streak, 1);
  });
}
