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
