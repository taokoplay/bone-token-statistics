"use strict";

/**
 * BoneTokenStatistics — cost estimation.
 *
 * The host exposes token counters and nothing about money, so a cost is only
 * ever computed from rates the user typed into the plugin settings. With no
 * rates there is no cost anywhere in the payload: the view then shows tokens
 * only, instead of inventing a price.
 *
 * Rate shape (per 1,000,000 tokens, same currency for every entry):
 *   { "<modelId>": { "input": 0.5, "output": 2, "cacheRead": 0.05,
 *                    "cacheWrite": 0.5, "reasoning": 2 } }
 * Missing sidelines fall back to `input` (for reads/writes) or `output`
 * (for reasoning), because that is how providers usually bill them.
 */

const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Keeps only entries that carry at least one usable rate. */
function normalizeRates(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [modelId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const price = {};
    for (const field of FIELDS) {
      const value = num(entry[field]);
      if (value !== null) price[field] = value;
    }
    if (Object.keys(price).length === 0) continue;
    out[String(modelId)] = price;
  }
  return out;
}

function rateFor(price, field) {
  if (price[field] !== undefined) return price[field];
  if (field === "reasoning") return price.output ?? price.input ?? 0;
  return price.input ?? 0;
}

function amountOf(bucket, price) {
  let amount = 0;
  for (const field of FIELDS) {
    const tokens = Number(bucket[field]) || 0;
    if (!tokens) continue;
    amount += (tokens / 1_000_000) * rateFor(price, field);
  }
  return amount;
}

/**
 * @param {{ models: Array<object>, totals: object }} summary
 * @param {Record<string, object>} rates normalized rate table
 * @param {string} currency display-only symbol choice
 * @returns {null | { currency: string, total: number, pricedTokens: number,
 *   unpricedTokens: number, byModel: Array<object>, unpricedModels: string[] }}
 */
function estimateCost(summary, rawRates, currency) {
  const rates = normalizeRates(rawRates);
  const modelIds = Object.keys(rates);
  if (modelIds.length === 0) return null;

  const byModel = [];
  const unpricedModels = [];
  let total = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;

  for (const model of summary.models ?? []) {
    const price = rates[model.id];
    if (!price) {
      unpricedModels.push(model.id);
      unpricedTokens += model.tokens;
      continue;
    }
    const amount = amountOf(model, price);
    total += amount;
    pricedTokens += model.tokens;
    byModel.push({
      modelId: model.id,
      tokens: model.tokens,
      amount: round(amount, 4),
      share: 0,
    });
  }

  if (byModel.length === 0) return null;
  for (const row of byModel) row.share = total > 0 ? round((row.amount / total) * 100, 1) : 0;
  byModel.sort((a, b) => b.amount - a.amount);

  return {
    currency: currency === "USD" ? "USD" : "CNY",
    total: round(total, 4),
    pricedTokens,
    unpricedTokens,
    byModel,
    unpricedModels,
  };
}

module.exports = { estimateCost, normalizeRates };
