"""Check compact usage labels and exact values through the dashboard and export."""
import csv
import io
import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TOTAL = 123_456_789
CACHE_READ = 1_234_567_890
BUCKET = {"tokens": TOTAL, "input": 111_099_999, "output": 12_356_790,
          "cacheRead": CACHE_READ, "cacheWrite": 0, "reasoning": 0, "turns": 12}
SNAPSHOT = {
    "ok": True,
    "generatedAt": "2026-10-29T12:00:00Z",
    "window": {"days": 7, "fromMs": 1792713600000, "toMs": 1793313600000},
    "totals": {**BUCKET, "sessions": 1, "projects": 1, "models": 1,
               "activeDays": 1, "avgPerTurn": 10_288_065.75, "tokensPerSecond": 1_234.56},
    "days": [{**BUCKET, "date": "2026-10-29"}],
    "heat": [[TOTAL]],
    "projects": [{**BUCKET, "id": 12, "name": "Display Test Project", "sessions": 1,
                  "models": [{"modelId": "display-test-model", "tokens": TOTAL, "turns": 12}]}],
    "models": [{**BUCKET, "id": "display-test-model", "providerId": "test-provider",
                "avgPerTurn": 10_288_065.75, "tokensPerSecond": 1_234.56}],
    "sessions": [{"sessionId": "test-session", "title": "Display Test Session",
                  "projectId": 12, "projectName": "Display Test Project", "modelId": "display-test-model",
                  "tokens": TOTAL, "turns": 12}],
}
STUB = """<script>
  const fixture = SNAPSHOT_JSON;
  let appearance = { base: "dark", locale: "zh-CN" };
  window.pluginBridge = {
    invoke(channel) {
      if (channel === "app.getAppearance") return appearance;
      if (channel === "stats.ping") return { ok: true, defaultDays: 7 };
      if (channel === "stats.snapshot") return fixture;
      if (channel === "stats.balances") return { ok: true, channels: [], configs: [] };
    },
    on(event, receive) {
      if (event !== "appearance:changed") return;
      window.setFixtureLocale = locale => { appearance = { ...appearance, locale }; receive(appearance); };
    },
  };
</script>""".replace("SNAPSHOT_JSON", json.dumps(SNAPSHOT))


def tile(page, label):
    return page.locator(".kpi").filter(has=page.get_by_text(label, exact=True))


def check_labels(page, total_label, throughput_label, cache_read_label):
    compact = "123.46M"
    total = tile(page, total_label)
    expect(total.locator(".kpi-value")).to_have_text(compact)
    expect(total).to_have_attribute("title", f"{TOTAL:,}")
    for selector in (".panel--projects tbody", ".panel--models tbody", ".panel--sessions .sess-nums"):
        count = page.locator(selector).locator(f'[title="{TOTAL:,}"]').first
        expect(count).to_contain_text(compact)
    expect(tile(page, throughput_label).locator(".kpi-value")).to_have_text("1.23K")
    expect(tile(page, cache_read_label).locator(".kpi-value")).to_have_text("1.23B")
    expect(page.locator(".axis-text").filter(has_text=re.compile(r"^500M$"))).to_have_count(1)


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome", headless=True)
    try:
        page = browser.new_page(viewport={"width": 360, "height": 850}, accept_downloads=True, timezone_id="UTC")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        html = (ROOT / "views/index.html").read_text().replace("  <body>\n", "  <body>\n" + STUB, 1)
        page.set_content(html)
        check_labels(page, "总 tokens", "吞吐", "缓存读")
        expect(tile(page, "推理").locator(".kpi-value")).to_have_text("0")
        assert page.locator(".trend-svg .axis-text").evaluate_all("labels => labels.every(label => label.getBBox().x >= 0)")
        page.locator(".day-bar").last.focus()
        expect(page.get_by_role("tooltip")).to_contain_text(f"{TOTAL:,}")

        page.evaluate("window.setFixtureLocale('en')")
        check_labels(page, "Total tokens", "Throughput", "Cache read")
        assert page.evaluate("document.documentElement.scrollWidth === innerWidth")

        with page.expect_download() as download:
            page.locator("#btn-export").click()
        raw = download.value.path().read_text(encoding="utf-8-sig")
        rows = list(csv.reader(io.StringIO(raw)))
        for identity, index, count in (("2026-10-29", 1, TOTAL), ("2026-10-29", 4, CACHE_READ),
                                       ("12", 2, TOTAL), ("display-test-model", 2, TOTAL)):
            row = next(row for row in rows if row and row[0] == identity)
            assert row[index] == str(count), row
        assert not errors, errors
        print("PASS: K/M/B in both languages, full values, chart axes, narrow layout, and exact CSV counts")
    finally:
        browser.close()
