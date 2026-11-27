"use strict";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function number(value) {
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
  return Number.isFinite(value) ? value : undefined;
}

function percentage(value) {
  const n = number(value);
  return n >= 0 && n <= 100 ? n : undefined;
}

function resetTime(value) {
  return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? { resetsAt: value } : {};
}

function account(value, currency) {
  const amount = number(value);
  if (amount === undefined) return;
  return { scope: "account", amounts: [{ amount, ...(currency ? { currency } : {}) }] };
}

function accountRows(rows, amountFor) {
  const amounts = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    const row = object(item);
    if (!row || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) continue;
    const amount = amountFor(row);
    if (Number.isFinite(amount)) amounts.push({ amount, currency: row.currency });
  }
  if (amounts.length) return { scope: "account", amounts };
}

function plan(windows) {
  if (windows.length) return { scope: "plan", windows };
}

function miniMaxWindow(row, weekly) {
  const prefix = weekly ? "current_weekly_" : "current_interval_";
  const period = weekly ? "week" : "5h";
  const time = resetTime(number(row[weekly ? "weekly_end_time" : "end_time"]));
  const status = number(row[`${prefix}status`]);
  if (status === 3) return { period, remainingPercent: null, ...time };
  if (status === 2) return { period, remainingPercent: 0, ...time };
  let remainingPercent = percentage(row[`${prefix}remaining_percent`]);
  if (remainingPercent === undefined) {
    const total = number(row[`${prefix}total_count`]);
    const remaining = number(row[`${prefix}usage_count`]);
    // The MiniMax CLI treats the legacy count as remaining when no percentage is given.
    if (!(total > 0 && remaining >= 0 && remaining <= total)) return;
    remainingPercent = remaining / total * 100;
  }
  const boost = weekly ? number(row.weekly_boost_permille) : undefined;
  if (boost > 0 && boost <= 10_000) remainingPercent *= boost / 1000;
  return { period, remainingPercent, ...time };
}

function miniMaxPlan(data) {
  if (data.base_resp?.status_code !== 0 || !Array.isArray(data.model_remains)) return;
  const buckets = data.model_remains.filter(row => typeof row?.model_name === "string" &&
    /^minimax-m(?:\*|\d[\d.a-z_-]{0,31})$/i.test(row.model_name));
  const shared = buckets.find(row => row.model_name.toLowerCase() === "minimax-m*");
  const selected = shared ? [shared] : buckets;
  return plan(selected.flatMap(row => [miniMaxWindow(row, false), miniMaxWindow(row, true)]
    .filter(Boolean).map(window => selected.length > 1 ? { ...window, model: row.model_name } : window)));
}

function miniMax(host, currency) {
  return key => key.startsWith("sk-api-")
    ? endpoint(host, "/account/query_balance", data => data.base_resp?.status_code === 0 ? account(data.available_amount, currency) : undefined)
    : endpoint(host, "/v1/token_plan/remains", miniMaxPlan);
}

function glmQuota(data) {
  const limits = Array.isArray(data.data?.limits) ? data.data.limits : [];
  const windows = [];
  for (const row of limits) {
    if (row?.type !== "TOKENS_LIMIT") continue;
    const used = percentage(row.percentage);
    if (used === undefined) continue;
    const unit = number(row.unit);
    const span = number(row.number);
    let period = "other";
    if (unit === 3 && span === 5) period = "5h";
    if (unit === 6 && span === 1) period = "week";
    windows.push({ period, remainingPercent: 100 - used, ...resetTime(number(row.nextResetTime)) });
  }
  return plan(windows);
}

function moonshot(currency) {
  return data => data.code === 0 && data.status === true ? account(data.data?.available_balance, currency) : undefined;
}

function kimiQuota(data) {
  const windows = [];
  const add = (detail, period) => {
    if (!object(detail)) return;
    const limit = number(detail.limit);
    const used = number(detail.used);
    if (!(limit > 0)) return;
    let remaining = number(detail.remaining);
    if (remaining === undefined && used >= 0) remaining = Math.max(0, limit - used);
    if (!(remaining >= 0 && remaining <= limit)) return;
    const time = detail.resetAt ?? detail.reset_at ?? detail.resetTime ?? detail.reset_time;
    windows.push({ period, remainingPercent: remaining / limit * 100,
      ...resetTime(typeof time === "string" ? Date.parse(time) : NaN) });
  };
  add(data.usage, "week");
  for (const row of Array.isArray(data.limits) ? data.limits : []) {
    if (!object(row)) continue;
    const detail = object(row.detail) ?? row;
    const duration = number(row.window?.duration ?? row.duration ?? detail.duration);
    const unit = row.window?.timeUnit ?? row.timeUnit ?? detail.timeUnit;
    const fiveHours = (duration === 300 && ["MINUTE", "TIME_UNIT_MINUTE"].includes(unit)) ||
      (duration === 5 && ["HOUR", "TIME_UNIT_HOUR"].includes(unit));
    add(detail, fiveHours ? "5h" : "other");
  }
  return plan(windows);
}

function keyLimit(data) {
  const row = object(data.data);
  if (!row) return;
  const remaining = row.limit === null && row.limit_remaining === null ? null : number(row.limit_remaining);
  if (remaining !== undefined) return { scope: "key", currency: "USD", remaining };
}

function mimoBalance(data) {
  if (data.object !== "balance") return;
  return accountRows(data.balance_infos, row => {
    const total = number(row.total_available);
    const frozen = number(row.frozen_balance);
    if (total !== undefined && frozen !== undefined) return Number((total - frozen).toFixed(2));
  });
}

function mimoPlan(data) {
  if (data.object !== "token_plan") return;
  const remaining = number(data.quota?.remaining_credits);
  if (!Number.isSafeInteger(remaining) || remaining < 0) return;
  const end = data.period?.end_at;
  const utc = typeof end === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(end)
    ? end.replace(" ", "T") + "Z"
    : end;
  return { scope: "credits", account: false, remaining,
    ...resetTime(typeof utc === "string" ? Date.parse(utc) : NaN) };
}

function endpoint(host, path, parse, rawAuth = false) {
  return { url: `https://${host}${path}`, parse, rawAuth };
}

const providers = new Map();

function add(id, en, zh, request) {
  providers.set(id, { label: { en, "zh-CN": zh }, request });
}

function fixed(id, en, zh, host, path, parse, rawAuth) {
  add(id, en, zh, () => endpoint(host, path, parse, rawAuth));
}

fixed("deepseek", "DeepSeek", "DeepSeek", "api.deepseek.com", "/user/balance",
  data => accountRows(data.balance_infos, row => number(row.total_balance)));
add("minimax-cn", "MiniMax (China)", "MiniMax（中国站）", miniMax("api.minimax.cn", "CNY"));
add("minimax", "MiniMax (Global)", "MiniMax（国际站）", miniMax("api.minimax.io", "USD"));
fixed("bigmodel", "BigModel Coding Plan", "智谱 BigModel Coding Plan", "open.bigmodel.cn", "/api/monitor/usage/quota/limit", glmQuota, true);
fixed("z-ai", "Z.ai Coding Plan", "Z.ai Coding Plan", "api.z.ai", "/api/monitor/usage/quota/limit", glmQuota, true);
fixed("moonshot-cn", "Moonshot (China)", "Moonshot（中国站）", "api.moonshot.cn", "/v1/users/me/balance", moonshot("CNY"));
fixed("moonshot", "Moonshot (Global)", "Moonshot（国际站）", "api.moonshot.ai", "/v1/users/me/balance", moonshot("USD"));
fixed("kimi-code", "Kimi Code", "Kimi Code", "api.kimi.com", "/coding/v1/usages", kimiQuota);
fixed("openrouter", "OpenRouter", "OpenRouter", "openrouter.ai", "/api/v1/key", keyLimit);
fixed("mimo", "Xiaomi MiMo", "小米 MiMo", "api.xiaomimimo.com", "/v1/platform/balance", mimoBalance);
for (const [region, en, zh] of [["cn", "China", "中国"], ["sgp", "Singapore", "新加坡"], ["ams", "Europe", "欧洲"]]) {
  fixed(`mimo-plan-${region}`, `MiMo Token Plan (${en})`, `小米 MiMo Token Plan（${zh}）`,
    `token-plan-${region}.xiaomimimo.com`, "/v1/platform/token_plan", mimoPlan);
}
fixed("siliconflow", "SiliconFlow (Global)", "硅基流动（国际站）", "api.siliconflow.com", "/v1/user/info",
  data => data.code === 20000 && data.status === true ? account(data.data?.totalBalance) : undefined);
fixed("vercel", "Vercel AI Gateway", "Vercel AI Gateway", "ai-gateway.vercel.sh", "/v1/credits", data => {
  const remaining = number(data.balance);
  if (remaining !== undefined) return { scope: "credits", account: true, remaining };
});

const channels = Array.from(providers, ([id, { label }]) => ({ id, label }));

function makeRequest(channel, key) {
  const provider = providers.get(channel);
  if (!provider) return;
  const { url, parse, rawAuth } = provider.request(key);
  return {
    url,
    authorization: rawAuth ? key : `Bearer ${key}`,
    parse: value => object(value) ? parse(value) : undefined,
  };
}

module.exports = { channels, makeRequest };
