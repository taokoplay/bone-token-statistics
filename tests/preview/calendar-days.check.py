"""Drive the date filters through the real panel and plugin with synthetic host facts."""
import csv
import io
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ZONE = "America/New_York"
HOST = """
const { now, channel, payload, turns } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const plugin = require('./main.js');
Date.now = () => now;
globalThis.pi = {
  plugin: { getSettings: async () => ({ defaultDays: 14 }) },
  desktop: { invoke: async () => ({ projects: [{ id: 1, name: 'Project A' }, { id: 2, name: 'Project B' }] }) },
  usage: { listTurns: async ({ fromMs, toMs }) => ({
    turns: turns.filter(turn => fromMs <= turn.endedAt && turn.endedAt <= toMs),
    nextCursor: null,
  }) },
};
plugin.onPanelInvoke(channel, payload).then(answer => process.stdout.write(JSON.stringify(answer)));
"""
BRIDGE = """<script>
  let appearance = { base: 'dark', locale: 'zh-CN' };
  window.pluginBridge = {
    invoke(channel, payload) {
      if (channel === 'app.getAppearance') return appearance;
      if (channel === 'stats.balances') return { ok: true, channels: [], configs: [] };
      return window.fixtureInvoke(channel, payload ?? {}, Date.now());
    },
    on(event, receive) {
      if (event !== 'appearance:changed') return;
      window.setFixtureLocale = locale => {
        appearance = { ...appearance, locale };
        receive(appearance);
      };
    },
  };
</script>"""


def turn(ended, tokens, project=1, model="model-a"):
    end = int(datetime.fromisoformat(ended).timestamp() * 1000)
    return dict(turnId=ended, startedAt=end - 60_000, endedAt=end,
                inputTokens=tokens, projectId=project, modelId=model)


TURNS = [
    turn("2026-10-28T23:59:58-04:00", 124_567),
    turn("2026-10-29T00:00:00-04:00", 123_456),
    turn("2026-10-29T06:00:00-04:00", 50, project=2, model="model-b"),
    turn("2026-10-30T00:00:00-04:00", 32),
]
requests = []


def invoke(channel, payload, now):
    requests.append((channel, payload))
    result = subprocess.run(
        ["node", "-e", HOST], cwd=ROOT, env={**os.environ, "TZ": ZONE}, check=True,
        capture_output=True, text=True, timeout=5,
        input=json.dumps(dict(now=now, channel=channel, payload=payload, turns=TURNS)),
    )
    return json.loads(result.stdout)


def choose(page, label):
    radio = page.get_by_role("radio", name=label, exact=True)
    radio.check()
    expect(radio).to_be_checked()


def check_tokens(page, count, label="总 tokens"):
    tile = page.locator(".kpi").filter(has=page.get_by_text(label, exact=True))
    expect(tile).to_have_attribute("title", f"{count:,}")


def check_chips_fit(page):
    assert page.locator("#chips").evaluate("""group => {
        const bounds = group.getBoundingClientRect();
        return bounds.right <= innerWidth && [...group.children].every(chip =>
            chip.getBoundingClientRect().right <= bounds.right);
    }""")


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome", headless=True)
    try:
        page = browser.new_page(viewport={"width": 320, "height": 900}, timezone_id=ZONE, accept_downloads=True)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.expose_function("fixtureInvoke", invoke)
        page.clock.set_fixed_time(datetime.fromisoformat("2026-10-29T23:59:55-04:00"))
        html = (ROOT / "views/index.html").read_text().replace("  <body>\n", "  <body>\n" + BRIDGE, 1)
        page.set_content(html)

        header = page.locator("#sub")
        bars = page.locator(".trend-svg .day-bar")
        expect(header).to_contain_text("最近 14 天 ·")
        expect(page.get_by_role("radio", name="14 天", exact=True)).to_be_checked()
        expect(page.get_by_role("radio")).to_have_count(7)
        check_chips_fit(page)
        bars.last.focus()

        choose(page, "今日")
        expect(header).to_have_text("今日 · 2026/10/29")
        check_tokens(page, 123_506)
        expect(bars).to_have_count(1)
        expect(bars.first).to_have_attribute("tabindex", "0")
        expect(page.locator(".trend-svg .axis-x")).to_have_attribute("text-anchor", "middle")
        page.select_option("#sel-project", "1")
        check_tokens(page, 123_456)
        page.select_option("#sel-model", "model-a")

        choose(page, "昨日")
        expect(header).to_have_text("昨日 · 2026/10/28")
        expect(bars).to_have_count(1)
        check_tokens(page, 124_567)
        assert requests[-1] == ("stats.snapshot", {"range": "yesterday", "projectId": 1, "modelId": "model-a"})
        with page.expect_download() as result:
            page.locator("#btn-export").click()
        download = result.value
        assert download.suggested_filename == "bone-token-stats-yesterday-2026-10-28.csv"
        rows = list(csv.reader(io.StringIO(download.path().read_text(encoding="utf-8-sig"))))
        assert "昨日 · 2026/10/28" in rows[0][0]
        assert next(row for row in rows if row and row[0] == "2026-10-28")[1] == "124567"

        page.evaluate("window.setFixtureLocale('en')")
        expect(page.get_by_role("radio", name="Today", exact=True)).to_be_visible()
        expect(page.get_by_role("radio", name="Yesterday", exact=True)).to_be_checked()
        check_chips_fit(page)
        page.clock.set_fixed_time(datetime.fromisoformat("2026-10-30T00:00:05-04:00"))
        page.get_by_role("button", name="Refresh", exact=True).click()
        expect(header).to_have_text("Yesterday · 10/29/2026")
        check_tokens(page, 123_456, "Total tokens")
        choose(page, "Today")
        expect(header).to_have_text("Today · 10/30/2026")
        check_tokens(page, 32, "Total tokens")

        choose(page, "7 d")
        expect(header).to_contain_text("Last 7 days ·")
        assert requests[-1] == ("stats.snapshot", {"days": 7, "projectId": 1, "modelId": "model-a"})
        assert not errors, errors
        print("PASS: calendar-day filters, bilingual narrow layout, one-day trend, exact CSV, and midnight refresh")
    finally:
        browser.close()
