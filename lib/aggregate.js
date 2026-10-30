"use strict";

/**
 * BoneTokenStatistics — pure aggregation.
 *
 * Everything here is a plain function over rows, so it can be tested without a
 * host: turn rows in, dashboard numbers out. No I/O, no clock reads that the
 * caller cannot control (`now` is always a parameter).
 *
 * Token semantics, deliberately explicit rather than clever:
 *   - `tokens` is the headline and is `input + output + cacheWrite + reasoning`.
 *   - `cacheRead` is reported on its own and NOT added to `tokens`: it is a read
 *     of cache that was already billed when it was written, and providers
 *     differ on whether `input` already includes it. The payload carries both
 *     numbers plus `tokensWithCacheRead` so the UI can show the difference
 *     instead of silently picking one convention.
 */

const DAY_MS = 86_400_000;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Local-time day key (`YYYY-MM-DD`), because "today" means the user's today. */
function dayKey(epochMs) {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 0 = Monday … 6 = Sunday, matching the heatmap's row order. */
function weekdayIndex(epochMs) {
  return (new Date(epochMs).getDay() + 6) % 7;
}

/** `Number(null)` is 0, which would invent a project 0; ids stay null instead. */
function idOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function normalizeTurn(row) {
  const startedAt = finite(row?.startedAt);
  const endedAt = finite(row?.endedAt);
  return {
    turnId: String(row?.turnId ?? ""),
    sessionId: String(row?.sessionId ?? ""),
    sessionTitle: typeof row?.sessionTitle === "string" ? row.sessionTitle : null,
    projectId: idOrNull(row?.projectId),
    providerId: typeof row?.providerId === "string" && row.providerId ? row.providerId : null,
    modelId: typeof row?.modelId === "string" && row.modelId ? row.modelId : null,
    startedAt,
    endedAt,
    input: finite(row?.inputTokens),
    output: finite(row?.outputTokens),
    cacheRead: finite(row?.cacheReadTokens),
    cacheWrite: finite(row?.cacheWriteTokens),
    reasoning: finite(row?.reasoningTokens),
  };
}

function tokensOf(turn) {
  return turn.input + turn.output + turn.cacheWrite + turn.reasoning;
}

function emptyBucket() {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    turns: 0,
    durationMs: 0,
    firstAt: null,
    lastAt: null,
  };
}

function addTurn(bucket, turn) {
  bucket.tokens += tokensOf(turn);
  bucket.input += turn.input;
  bucket.output += turn.output;
  bucket.cacheRead += turn.cacheRead;
  bucket.cacheWrite += turn.cacheWrite;
  bucket.reasoning += turn.reasoning;
  bucket.turns += 1;
  bucket.durationMs += Math.max(0, turn.endedAt - turn.startedAt);
  bucket.firstAt = bucket.firstAt === null ? turn.startedAt : Math.min(bucket.firstAt, turn.startedAt);
  bucket.lastAt = bucket.lastAt === null ? turn.endedAt : Math.max(bucket.lastAt, turn.endedAt);
  return bucket;
}

function bump(map, key, turn) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyBucket();
    map.set(key, bucket);
  }
  return addTurn(bucket, turn);
}

function share(part, total) {
  return total > 0 ? round((part / total) * 100, 1) : 0;
}

function perSecond(tokens, durationMs) {
  return durationMs > 0 ? round(tokens / (durationMs / 1000), 2) : 0;
}

/**
 * @param {ReadonlyArray<object>} rows raw `pi.usage.listTurns` rows
 * @param {{ now?: number, fromMs: number, toMs: number }} window
 */
function summarize(rows, { now, fromMs, toMs }) {
  const turns = rows.map(normalizeTurn).sort((a, b) => a.startedAt - b.startedAt);

  const totals = emptyBucket();
  const byProject = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  const byDay = new Map();
  const bySession = new Map();
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const turn of turns) {
    addTurn(totals, turn);
    if (turn.projectId !== null) bump(byProject, turn.projectId, turn);
    bump(byModel, turn.modelId ?? "unknown", turn);
    bump(byProvider, turn.providerId ?? "unknown", turn);
    bump(byDay, dayKey(turn.startedAt), turn);
    if (turn.sessionId) bump(bySession, turn.sessionId, turn);
    heat[weekdayIndex(turn.startedAt)][new Date(turn.startedAt).getHours()] += tokensOf(turn);
  }

  const sessions = new Map();
  for (const turn of turns) {
    if (!turn.sessionId) continue;
    const view = sessions.get(turn.sessionId) ?? {
      sessionId: turn.sessionId,
      title: turn.sessionTitle,
      projectId: turn.projectId,
      lastAt: 0,
      turns: 0,
      tokens: 0,
      modelId: null,
    };
    view.turns += 1;
    view.tokens += tokensOf(turn);
    if (turn.endedAt >= view.lastAt) {
      view.lastAt = turn.endedAt;
      view.modelId = turn.modelId;
      view.projectId = turn.projectId ?? view.projectId;
      view.title = turn.sessionTitle ?? view.title;
    }
    sessions.set(turn.sessionId, view);
  }

  const models = [...byModel.entries()]
    .map(([id, bucket]) => {
      const sample = turns.find((turn) => (turn.modelId ?? "unknown") === id);
      return {
        id,
        providerId: sample?.providerId ?? null,
        tokens: bucket.tokens,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        reasoning: bucket.reasoning,
        turns: bucket.turns,
        share: share(bucket.tokens, totals.tokens),
        avgPerTurn: bucket.turns ? round(bucket.tokens / bucket.turns, 1) : 0,
        tokensPerSecond: perSecond(bucket.tokens, bucket.durationMs),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const projects = [...byProject.entries()]
    .map(([id, bucket]) => {
      const modelMap = new Map();
      for (const turn of turns) {
        if (turn.projectId === id) bump(modelMap, turn.modelId ?? "unknown", turn);
      }
      const sessionCount = new Set(
        turns.filter((turn) => turn.projectId === id).map((turn) => turn.sessionId),
      ).size;
      return {
        id,
        name: null,
        tokens: bucket.tokens,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        reasoning: bucket.reasoning,
        turns: bucket.turns,
        sessions: sessionCount,
        share: share(bucket.tokens, totals.tokens),
        firstAt: bucket.firstAt,
        lastAt: bucket.lastAt,
        models: [...modelMap.entries()]
          .map(([modelId, modelBucket]) => ({
            modelId,
            tokens: modelBucket.tokens,
            turns: modelBucket.turns,
          }))
          .sort((a, b) => b.tokens - a.tokens),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const providers = [...byProvider.entries()]
    .map(([id, bucket]) => ({ id, tokens: bucket.tokens, turns: bucket.turns, share: share(bucket.tokens, totals.tokens) }))
    .sort((a, b) => b.tokens - a.tokens);

  const days = [...byDay.entries()]
    .map(([date, bucket]) => ({
      date,
      tokens: bucket.tokens,
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      reasoning: bucket.reasoning,
      turns: bucket.turns,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const activeDays = days.length;
  const dayKeys = new Set(days.map((day) => day.date));
  let streak = 0;
  for (let cursor = now; streak < 400; cursor -= DAY_MS) {
    if (!dayKeys.has(dayKey(cursor))) {
      // "Today" may legitimately have no turns yet; do not break the streak on it.
      if (streak === 0 && dayKey(cursor) === dayKey(now)) continue;
      break;
    }
    streak += 1;
  }

  const topSessions = [...sessions.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20)
    .map((session) => ({
      ...session,
      tokens: session.tokens,
      title: session.title || null,
    }));

  const cacheHitRate =
    totals.input + totals.cacheRead > 0
      ? round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100, 1)
      : null;

  return {
    window: { fromMs, toMs, days: Math.max(1, Math.round((toMs - fromMs) / DAY_MS)) },
    totals: {
      tokens: totals.tokens,
      tokensWithCacheRead: totals.tokens + totals.cacheRead,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      reasoning: totals.reasoning,
      turns: totals.turns,
      sessions: sessions.size,
      projects: byProject.size,
      models: byModel.size,
      activeDays,
      streak,
      avgPerTurn: totals.turns ? round(totals.tokens / totals.turns, 1) : 0,
      tokensPerSecond: perSecond(totals.tokens, totals.durationMs),
      cacheHitRate,
      firstAt: totals.firstAt,
      lastAt: totals.lastAt,
    },
    days,
    heat,
    projects,
    models,
    providers,
    sessions: topSessions,
  };
}

module.exports = { summarize, dayKey, weekdayIndex, tokensOf, round, finite, idOrNull };
