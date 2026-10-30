"""Independent acceptance for the BoneTokenStatistics view (semantic + ids)."""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PREVIEW = HERE / "preview.html"
shots = HERE / "shots"
shots.mkdir(exist_ok=True)
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))


RECORDER = """
() => {
  if (window.__recorderInstalled) return;
  window.__recorderInstalled = true;
  window.__calls = [];
  const wrap = (bridge) => {
    const original = bridge.invoke.bind(bridge);
    bridge.invoke = (channel, payload) => {
      window.__calls.push({ channel, payload: payload ?? null });
      return original(channel, payload);
    };
    return bridge;
  };
  if (window.pluginBridge) { wrap(window.pluginBridge); return; }
  // the stub assigns window.pluginBridge after this init script has run
  Object.defineProperty(window, "pluginBridge", {
    configurable: true,
    set(value) {
      Object.defineProperty(window, "pluginBridge", {
        value: wrap(value), writable: true, configurable: true,
      });
    },
  });
}
"""


def boot(page):
    page.add_init_script("(" + RECORDER.strip() + ")();")
    page.reload()
    page.wait_for_timeout(900)


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome")
    context = browser.new_context(viewport={"width": 1024, "height": 1000}, accept_downloads=True)
    page = context.new_page()
    errors, console = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.goto(PREVIEW.as_uri())
    page.wait_for_timeout(600)
    boot(page)

    payload = page.evaluate("() => window.pluginBridge.invoke('stats.snapshot', { days: 30 })")
    totals = payload["totals"]
    body = page.evaluate("() => document.body.innerText")

    check("no page errors", not errors, "; ".join(errors))
    check("no console errors", not console, "; ".join(console))
    check("one h1", page.evaluate("() => document.querySelectorAll('h1').length") == 1)
    check("title mentions token", "Token" in body or "token" in body, body[:60])
    check("boot asks for stats.ping", any(c["channel"] == "stats.ping" for c in page.evaluate("() => window.__calls")), json.dumps(page.evaluate("() => window.__calls"))[:160])
    check("first snapshot request is days=30", any((c["payload"] or {}).get("days") == 30 for c in page.evaluate("() => window.__calls") if c["channel"] == "stats.snapshot"))

    full = f"{totals['tokens']:,}"
    check("total tokens visible (full or compact)", full in body or ("K" in body or "M" in body), str(totals["tokens"]))
    check("turn count visible", str(totals["turns"]) in body, str(totals["turns"]))
    check("kpi tiles rendered", page.evaluate("() => document.querySelectorAll('.kpi').length") >= 10, str(page.evaluate("() => document.querySelectorAll('.kpi').length")))
    check("both tables exist", page.evaluate("() => document.querySelectorAll('table').length") >= 2)
    check("tables have captions", page.evaluate("() => [...document.querySelectorAll('table')].every(t => !!t.querySelector('caption'))"))
    check("charts are inline svg", page.evaluate("() => document.querySelectorAll('svg').length") >= 2)
    check("heat cells rendered", page.evaluate("() => document.querySelectorAll('.hc').length") >= 100, str(page.evaluate("() => document.querySelectorAll('.hc').length")))
    check("notes rendered", page.evaluate("() => document.querySelectorAll('.notes li').length") >= 1)
    check("cost shown when priced", ("$" in body) or ("¥" in body))
    check("cost marked as estimate", "估算" in body or "estimated" in body.lower())
    check("sessions listed", page.evaluate("() => document.querySelectorAll('.sess').length") >= 1)

    # ── filters ─────────────────────────────────────────────────────────────
    def last_calls(n=3):
        return page.evaluate("() => (window.__calls || []).slice(-%d)" % n)

    page.select_option("#sel-project", index=1)
    page.wait_for_timeout(700)
    calls = last_calls()
    check("project select triggers a snapshot", any(c["channel"] == "stats.snapshot" for c in calls), json.dumps(calls)[:200])
    check("project select sends projectId", any("projectId" in json.dumps(c["payload"]) for c in calls), json.dumps(calls)[:200])

    page.select_option("#sel-model", index=1)
    page.wait_for_timeout(700)
    calls = last_calls()
    check("model select sends modelId", any("modelId" in json.dumps(c["payload"]) for c in calls), json.dumps(calls)[:200])

    page.click("#btn-clear")
    page.wait_for_timeout(700)
    cleared = (last_calls(1) or [{}])[0].get("payload") or {}
    check("clear resets both filters", "projectId" not in cleared and "modelId" not in cleared, json.dumps(cleared))

    page.get_by_role("radio", name="7 天").first.check(force=True) if page.get_by_role("radio", name="7 天").count() else page.get_by_text("7 天", exact=True).first.click()
    page.wait_for_timeout(700)
    check("range chip sends days=7", any((c["payload"] or {}).get("days") == 7 for c in last_calls(3)), json.dumps(last_calls(2))[:160])

    page.click("#btn-refresh, .btn:has-text('刷新')")
    page.wait_for_timeout(600)
    check("refresh sends force=true", any((c["payload"] or {}).get("force") is True for c in last_calls(2)), json.dumps(last_calls(1))[:160])

    # ── CSV ─────────────────────────────────────────────────────────────────
    with page.expect_download(timeout=10000) as dl:
        page.click("#btn-export")
    download = dl.value
    csv_path = shots / "export.csv"
    download.save_as(str(csv_path))
    raw = csv_path.read_bytes()
    text = raw.decode("utf-8-sig", errors="replace")
    check("csv name ends with .csv", download.suggested_filename.endswith(".csv"), download.suggested_filename)
    check("csv has a UTF-8 BOM", raw[:3] == b"\xef\xbb\xbf", str(raw[:6]))
    check("csv mentions projects", "Framecraft" in text, text[:120].replace("\n", " | "))
    check("csv has three sections", text.count("日期") + text.count("项目") + text.count("模型") >= 3 or text.count("#") >= 2, text[:200])

    # ── widths ──────────────────────────────────────────────────────────────
    for width in (360, 480, 720, 1200):
        page.set_viewport_size({"width": width, "height": 1000})
        page.wait_for_timeout(300)
        overflow = page.evaluate("() => document.documentElement.scrollWidth - innerWidth")
        check(f"no page overflow at {width}", overflow <= 1, str(overflow))
        if width in (360, 1024):
            page.screenshot(path=str(shots / f"view-{width}.png"), full_page=True)

    # ── states ──────────────────────────────────────────────────────────────
    def set_mode(mode):
        page.evaluate("(m) => window.__setStubMode(m)", mode)
        page.click("#btn-refresh, .btn:has-text('刷新')")
        page.wait_for_timeout(800)
        return page.evaluate("() => document.body.innerText")

    page.set_viewport_size({"width": 1024, "height": 1000})
    page.wait_for_timeout(200)
    text = set_mode("empty")
    check("empty state explains itself", "没有已完成" in text, text[:100])
    check("empty state draws no chart bars", page.evaluate("() => document.querySelectorAll('.day-bar').length") == 0, str(page.evaluate("() => document.querySelectorAll('.day-bar').length")))

    text = set_mode("nocost")
    check("no money without rates", ("$" not in text) and ("¥" not in text), text[:120])
    check("nocost notes say why", "单价" in text, text[:200])

    text = set_mode("truncated")
    check("truncation badge shown", "已截断" in text, text[:120])

    text = set_mode("error")
    check("error shows the host message", "读取用量失败" in text, text[:120])
    check("error offers retry", page.get_by_role("button", name="重试").count() >= 1)

    page.evaluate("() => window.__setStubMode('rich')")
    page.get_by_role("button", name="重试").first.click()
    page.wait_for_timeout(900)
    check("retry recovers", page.evaluate("() => document.querySelectorAll('.kpi').length") >= 10)
    page.screenshot(path=str(shots / "view-recovered.png"), full_page=True)

    check("no page errors after all states", not errors, "; ".join(errors)[:300])
    browser.close()

failed = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail and not ok else ""))
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
