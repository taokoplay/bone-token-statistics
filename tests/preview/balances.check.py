"""Balance configuration through the real view with a synthetic plugin bridge."""
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

VIEW = Path(__file__).resolve().parents[2] / "views/index.html"
CHANNELS = [
    {"id": "deepseek", "label": {"en": "DeepSeek"}},
    {"id": "minimax", "label": {"en": "MiniMax"}},
    {"id": "openrouter", "label": {"en": "OpenRouter"}},
    {"id": "mimo", "label": {"en": "MiMo"}},
    {"id": "custom", "label": {"en": "VeryLongProviderNameForTheNarrowViewport"}},
]
STUB = """
<script>
  window.balanceCalls = 0;
  window.lastBalanceRefresh = false;
  window.configs = [];
  window.channels = CHANNELS_JSON;
  const state = () => ({ ok: true, channels: window.channels, configs: window.configs, checkedAt: Date.now() });
  window.pluginBridge = {
    invoke(channel, input) {
      if (channel === "app.getAppearance") return { base: "light", locale: "zh-CN" };
      if (channel === "stats.ping") return { ok: true, defaultDays: 30 };
      if (channel === "stats.balances") {
        window.balanceCalls++;
        window.lastBalanceRefresh = input.refresh;
        return state();
      }
      if (channel === "stats.balances.save") {
        if (input.apiKey === "invalid-sample") return { ok: false, code: "UNAUTHORIZED" };
        const row = { id: input.id || "added", channel: input.channel, status: "available",
          balance: { scope: "account", amounts: [{ currency: "CNY", amount: 0 }] } };
        window.configs = window.configs.filter(config => config.id !== row.id).concat(row);
        return { ok: true, snapshot: state() };
      }
      if (channel === "stats.balances.remove") {
        window.configs = window.configs.filter(config => config.id !== input.id);
        return { ok: true, snapshot: state() };
      }
      if (channel === "stats.snapshot") {
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
        expect(dialog).to_contain_text("重新启动客户端后需要补填")
        selector.select_option("deepseek")
        key.fill("invalid-sample")
        confirm = dialog.get_by_role("button", name="确认", exact=True)
        confirm.click()
        expect(dialog.get_by_role("alert")).to_contain_text("当前 Key 无权查询")
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
        assert not errors, json.dumps(errors, ensure_ascii=False)
        print("PASS: add, verify, cancel, refresh, enter a replacement key, remove, and responsive layout")
    finally:
        browser.close()
