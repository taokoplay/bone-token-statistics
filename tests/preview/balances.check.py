"""Balance configuration through the real view with a synthetic plugin bridge."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

VIEW = Path(__file__).resolve().parents[2] / "views/index.html"
CHANNELS = [
    {"id": "deepseek", "label": {"en": "DeepSeek"}},
    {"id": "minimax", "label": {"en": "MiniMax M Plan (Global)"}, "keyKind": "minimaxPlan"},
    {"id": "minimax-cn", "label": {"en": "MiniMax M Plan (China)", "zh-CN": "MiniMax M Plan（中国站）"}, "keyKind": "minimaxPlan"},
    {"id": "minimax-api-cn", "label": {"en": "MiniMax Pay-as-you-go (China)"}, "keyKind": "minimaxPaygo"},
    {"id": "openrouter", "label": {"en": "OpenRouter"}},
    {"id": "mimo", "label": {"en": "MiMo"}},
    {"id": "custom", "label": {"en": "VeryLongProviderNameForTheNarrowViewport"}},
]
STUB = """
<script>
  window.balanceCalls = 0;
  window.lastBalanceRefresh = false;
  window.snapshotCalls = 0;
  window.configs = [];
  window.channels = CHANNELS_JSON;
  let nextId = 0;
  const state = () => ({ ok: true, channels: window.channels, configs: window.configs, checkedAt: Date.now() });
  window.pluginBridge = {
    invoke(channel, input) {
      if (channel === "app.getAppearance") return { base: "light", locale: "zh-CN" };
      if (channel === "stats.ping") return { ok: true, defaultDays: 30 };
      if (channel === "stats.balances") {
        window.balanceCalls++;
        window.lastBalanceRefresh = input.refresh;
        if (input.refresh && window.deferBalanceRefresh) {
          return new Promise(resolve => { window.finishBalanceRefresh = resolve; });
        }
        return state();
      }
      if (channel === "stats.balances.save") {
        if (input.apiKey === "invalid-sample") return { ok: false, code: "UNAUTHORIZED" };
        if (input.apiKey === "locked-vault-sample") return { ok: false, code: "STORAGE_UNAVAILABLE" };
        if (input.channel === "minimax-cn" && input.apiKey?.startsWith("sk-api-")) {
          return { ok: false, code: "MINIMAX_PLAN_KEY_REQUIRED" };
        }
        const existing = window.configs.find(config => config.id === input.id);
        const isPlan = input.channel === "minimax-cn";
        const remainingPercent = input.apiKey?.endsWith("-personal") ? 29 : 64;
        const balance = !input.apiKey && existing ? existing.balance : isPlan
          ? { scope: "plan", windows: [{ period: "5h", remainingPercent }, { period: "week", remainingPercent: 82 }] }
          : { scope: "account", amounts: [{ currency: "CNY", amount: 0 }] };
        window.usedNewKey = Boolean(input.apiKey);
        const row = { id: input.id || `added-${++nextId}`, channel: input.channel,
          name: input.name, status: "available", balance };
        window.configs = window.configs.filter(config => config.id !== row.id).concat(row);
        return { ok: true, snapshot: state() };
      }
      if (channel === "stats.balances.remove") {
        window.configs = window.configs.filter(config => config.id !== input.id);
        return { ok: true, snapshot: state() };
      }
      if (channel === "stats.snapshot") {
        window.snapshotCalls++;
        window.snapshotDays = input.days;
        return { ok: true, totals: { turns: 0 } };
      }
    },
  };
</script>
""".replace("CHANNELS_JSON", json.dumps(CHANNELS))

ROWS = [
    {"id": "m", "channel": "minimax", "status": "available", "balance": {
        "scope": "plan", "windows": [{"period": "5h", "remainingPercent": 40},
            {"period": "week", "remainingPercent": 80, "resetsAt": 1893456000000}]}},
    {"id": "r", "channel": "openrouter", "status": "available", "balance": {"scope": "key", "currency": "USD", "remaining": None}},
    {"id": "c", "channel": "mimo", "status": "available", "balance": {"scope": "credits", "account": False, "remaining": 1230}},
    {"id": "n", "channel": "custom", "status": "missing-credential"},
]
html = VIEW.read_text().replace("  <body>\n", "  <body>\n" + STUB, 1)

with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome", headless=True)
    try:
        page = browser.new_page(viewport={"width": 390, "height": 850})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content(html)
        panel = page.get_by_role("region", name="剩余余额")
        add = panel.get_by_role("button", name="添加配置")
        expect(panel).to_contain_text("添加 AI 渠道和 API Key 后")
        add.click()
        dialog = page.get_by_role("dialog", name="添加配置")
        selector = dialog.get_by_label("AI 渠道")
        key = dialog.get_by_label("API Key", exact=True)
        expect(selector).to_be_focused()
        expect(key).to_have_attribute("type", "password")
        expect(dialog).to_contain_text("配置会加密保存在本机")
        expect(dialog).to_contain_text("重启后会自动读取 Key")
        confirm = dialog.get_by_role("button", name="确认", exact=True)
        selector.select_option(label="MiniMax M Plan（中国站）")
        hint = dialog.locator("#balance-key-hint")
        expect(hint).to_contain_text("M Plan 套餐页复制订阅 Key")
        key.fill("sk-api-synthetic-wrong-type")
        confirm.click()
        expect(dialog.get_by_role("alert")).to_contain_text("M Plan 订阅 Key（sk-cp- 开头）")
        assert page.evaluate("window.configs.length") == 0
        selector.select_option("minimax-api-cn")
        expect(hint).to_contain_text("按量付费 API Key")
        selector.select_option("deepseek")
        key.fill("invalid-sample")
        confirm.click()
        expect(dialog.get_by_role("alert")).to_contain_text("当前 Key 无权查询")
        key.fill("locked-vault-sample")
        confirm.click()
        expect(dialog.get_by_role("alert")).to_contain_text("无法访问系统凭据存储")
        assert page.evaluate("window.configs.length") == 0
        key.fill("valid-synthetic-key")
        confirm.click()
        row = panel.get_by_role("row").filter(has_text="DeepSeek")
        expect(row).to_contain_text("0.00")
        expect(dialog).to_have_count(0)
        expect(add).to_be_focused()
        expect(page.locator("#balance-dialog input")).to_have_count(0)
        assert "valid-synthetic-key" not in panel.inner_text()

        page.evaluate("rows => { window.configs.push(...rows); }", ROWS)
        page.locator("#btn-refresh").click()
        expect(panel.get_by_role("row")).to_have_count(len(ROWS) + 2)
        expect(panel).to_contain_text("40%")
        expect(panel).to_contain_text("重置")
        expect(panel).to_contain_text("不限额")
        expect(panel).to_contain_text("1,230 积分")
        assert page.evaluate("window.lastBalanceRefresh") is True

        for width in (360, 720, 1280):
            page.set_viewport_size({"width": width, "height": 850})
            for theme in ("light", "dark"):
                page.evaluate("theme => { document.documentElement.dataset.base = theme; }", theme)
                assert panel.evaluate("""section => {
                  const table = section.querySelector('table');
                  const stats = document.querySelector('#main').firstElementChild.getBoundingClientRect();
                  const balance = section.getBoundingClientRect();
                  const values = [...table.querySelectorAll('tr > :last-child')];
                  return Math.abs(stats.left - balance.left) < 1 && Math.abs(stats.right - balance.right) < 1 &&
                    values.every(cell => getComputedStyle(cell).textAlign === 'right') &&
                    table.scrollWidth <= table.clientWidth && document.documentElement.scrollWidth === innerWidth;
                }"""), (width, theme)
            add.click()
            assert dialog.evaluate("""d => {
              const r = d.getBoundingClientRect();
              return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
            }"""), width
            page.keyboard.press("Escape")
            expect(add).to_be_focused()

        page.get_by_role("radio", name="7 天", exact=True).locator("..").click()
        page.wait_for_function("window.snapshotDays === 7")
        assert page.evaluate("window.balanceCalls") == 2
        panel.get_by_role("button", name="填写 Key · VeryLongProviderNameForTheNarrowViewport").click()
        unlock = page.get_by_role("dialog", name="填写 Key")
        expect(unlock.get_by_label("AI 渠道")).to_be_disabled()
        unlock.get_by_label("API Key", exact=True).fill("replacement-synthetic-key")
        unlock.get_by_role("button", name="确认", exact=True).click()
        expect(panel.get_by_role("row").filter(has_text="VeryLongProviderNameForTheNarrowViewport")).to_contain_text("0.00")
        row.get_by_role("button", name="移除 · DeepSeek").click()
        page.get_by_role("dialog", name="移除配置").get_by_role("button", name="移除", exact=True).click()
        expect(row).to_have_count(0)
        expect(add).to_be_focused()

        add.click()
        name_field = dialog.get_by_role("textbox", name="配置名称（选填）")
        name_field.fill("工作账号")
        selector.select_option("minimax-cn")
        key.fill("sk-cp-synthetic-subscription")
        confirm.click()
        plan = panel.get_by_role("row").filter(has_text="工作账号")
        expect(plan).to_contain_text("MiniMax M Plan（中国站）")
        expect(plan).to_contain_text("64%")
        expect(plan).to_contain_text("82%")
        expect(dialog).to_have_count(0)
        expect(add).to_be_focused()

        add.click()
        selector.select_option("minimax-cn")
        name_field.fill("个人账号")
        key.fill("sk-cp-synthetic-personal")
        confirm.click()
        personal = panel.get_by_role("row").filter(has_text="个人账号")
        expect(personal).to_contain_text("29%")
        expect(plan).to_contain_text("64%")

        plan.get_by_role("button", name="编辑配置 · 工作账号 · MiniMax M Plan（中国站）").click()
        editor = page.get_by_role("dialog", name="编辑配置")
        rename = editor.get_by_role("textbox", name="配置名称（选填）")
        expect(rename).to_have_value("工作账号")
        expect(editor.get_by_label("API Key", exact=True)).to_have_value("")
        rename.fill("团队账号")
        editor.get_by_role("button", name="确认", exact=True).click()
        updated = panel.get_by_role("row").filter(has_text="团队账号")
        expect(updated).to_contain_text("64%")
        expect(personal).to_contain_text("29%")
        assert page.evaluate("window.usedNewKey") is False
        expect(updated.get_by_role("button", name="编辑配置 · 团队账号 · MiniMax M Plan（中国站）")).to_be_focused()

        refresh = panel.get_by_role("button", name="刷新余额", exact=True)
        for width in (320, 720):
            page.set_viewport_size({"width": width, "height": 850})
            refresh_box = refresh.bounding_box()
            add_box = add.bounding_box()
            assert abs(refresh_box["y"] - add_box["y"]) < 1
            assert refresh_box["x"] + refresh_box["width"] <= add_box["x"]

        before = page.evaluate("[window.balanceCalls, window.snapshotCalls]")
        page.evaluate("window.deferBalanceRefresh = true")
        refresh.click()
        expect(refresh).to_have_attribute("aria-busy", "true")
        expect(refresh).to_be_disabled()
        expect(refresh).to_be_focused()
        refresh.press("Enter")
        assert page.evaluate("[window.balanceCalls, window.lastBalanceRefresh]") == [before[0] + 1, True]
        page.evaluate("window.finishBalanceRefresh({ ok: false, code: 'UNAVAILABLE' })")
        expect(panel).to_contain_text("操作未完成，请重试")
        expect(refresh).to_be_enabled()
        expect(refresh).to_be_focused()

        page.evaluate("""() => {
          window.deferBalanceRefresh = false;
          window.configs.find(config => config.name === '团队账号').balance.windows[0].remainingPercent = 53;
        }""")
        refresh.click()
        expect(updated).to_contain_text("53%")
        expect(refresh).to_be_focused()
        assert page.evaluate("[window.balanceCalls, window.snapshotCalls]") == [before[0] + 2, before[1]]
        assert not errors, json.dumps(errors, ensure_ascii=False)
        print("PASS: balance setup, account names, responsive layout, and dedicated balance refresh")
    finally:
        browser.close()
