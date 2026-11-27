# 测试

三套，都不需要主机在跑：

```bash
# 纯函数（聚合 + 成本）：手算期望，无宿主
node tests/unit.test.cjs

# 后端契约：用假宿主驱动真实的 onPanelInvoke，覆盖分页/过滤/命名/上限/成本/缓存
node tests/backend.test.cjs

# 视图：真浏览器 + 桩桥接（需要 Python Playwright 与本机 Chrome）
cd tests/preview
python3 make-preview.py     # 用 views/index.html + stub.html 生成 preview.html
python3 view.check.py
```

`tests/preview/stub.html` 里是**测试夹具**（合成数据 + 六种状态开关），只在浏览器检查时
顶替 `window.pluginBridge`；插件运行时不会加载它，界面上的任何数字都来自宿主。

`tests/preview/shots/` 是检查时落盘的截图与 CSV 样本，可随时删除。

规则约定（与 `../README.md` 一致）：数字只认宿主返回的 payload，夹具不参与产品逻辑；
新增检查请写"能失败"的断言（先让它红，再修到绿），不要只断言"能渲染"。

项目名称回归：`node --test tests/project-names.test.cjs`。覆盖不读取会话的名称解析、超过 40 个项目、手工名称优先、刷新后重命名和权限拒绝提示。

响应式热力图：`python3 tests/preview/heatmap.check.py`。验证 390、720、905、1280、1600px 窗口下铺满卡片宽度，保留 168 格和星期行对齐。

余额回归：`node --test tests/model-balances.test.cjs` 和 `python3 tests/preview/balances.check.py`。
覆盖添加与验证渠道、鉴权错误、系统凭据存储不可用的界面提示、补填旧配置、移除、刷新和窄窗口布局。

加密存储回归：`node --test tests/balance-vault.test.cjs`。覆盖密文落盘、重启恢复、旧配置迁移、更换 Key、移除和文件篡改。

Run `python3 tests/preview/token-units.check.py` to verify K, M, and B in both
languages, chart scales, full-value tooltips, and exact CSV counts.

Calendar filters use `node --test tests/calendar-days.test.cjs` and
`python3 tests/preview/calendar-days.check.py`. The tests cover inclusive
completion-time boundaries, midnight rollover within the cache lifetime,
23- and 25-hour days, and the panel's narrow layout, language, project and model
selections, single-day chart, and exact CSV counts.

The balance tests also verify that separate names identify accounts on the same provider, editing a name retains the stored API key, and both names persist after reload.
