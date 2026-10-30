"""Responsive heatmap geometry against the actual view and host fixture."""
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
html = (root / 'views/index.html').read_text()
html = html.replace('  <body>\n', '  <body>\n' + (Path(__file__).parent / 'stub.html').read_text(), 1)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    try:
        page = browser.new_page()
        page.set_content(html, wait_until='load')
        page.wait_for_selector('.hc')
        for width in [390, 720, 905, 1280, 1600]:
            page.set_viewport_size({'width': width, 'height': 1000})
            result = page.evaluate('''() => {
              const grid = document.querySelector('.heat-grid');
              const scroll = document.querySelector('.heat-scroll');
              const cells = [...grid.querySelectorAll('.hc')];
              const rect = e => e.getBoundingClientRect();
              return {width:rect(grid).width, available:scroll.clientWidth,
                count:cells.length, overflow:document.documentElement.scrollWidth > innerWidth,
                aligned:[...document.querySelectorAll('.heat-day')].every((e,i) => Math.abs(rect(e).top-rect(cells[i*24]).top)<1),
                last:rect(cells[23]).right, edge:rect(grid).right};
            }''')
            assert abs(result['width'] - result['available']) < 1, (width, result)
            assert result['count'] == 168 and result['aligned'], (width, result)
            assert abs(result['last'] - result['edge']) < 1, (width, result)
            assert not result['overflow'], (width, result)
        print('PASS: heatmap fills card at 390/720/905/1280/1600px; 168 cells and day alignment preserved')
    finally:
        browser.close()
