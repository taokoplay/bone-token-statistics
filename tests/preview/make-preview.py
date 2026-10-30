#!/usr/bin/env python3
"""Rebuild preview.html = the real view + the host stub.

The stub only stands in for `window.pluginBridge`; the plugin never ships it as
runtime code. Run after every edit to views/index.html, then reload the preview.
"""
import pathlib

here = pathlib.Path(__file__).parent
view = here.parents[1] / "views/index.html"
html = view.read_text()
stub = (here / "stub.html").read_text()

anchor = "  <body>\n"
if anchor not in html:
    raise SystemExit("views/index.html has no `  <body>` line to anchor the stub on")
(here / "preview.html").write_text(html.replace(anchor, anchor + stub, 1))
print("preview.html rebuilt from", view)
