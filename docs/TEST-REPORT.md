# 验证报告

当前版本 **0.11.3**（2026-10-22）。验证使用本地 fixture 和临时 profile，链路为扩展 → 本机 Hub → stdio MCP。

## 当前版本

- `npm test`：146 项通过。覆盖独占控制、快照/ref 生命周期、严格 selector 与有界歧义候选、原生/DOM 输入、逐字输入、hover、pointer/HTML5 拖拽、document 拖拽坐标差值与按轴滚动、滚动边界后的延迟加载、条件等待、HTML select、batch、历史导航、OOPIF、日志、上传、截图、对话框和未知结果不重放。
- `npm run test:package`：仓库外含空格路径安装运行通过，22 个 MCP 工具、45 个发布文件；包含 `drag.js` / `wait.js` / `scroll.js` / `outcomes.js`，不包含配对密钥。版本为 0.11.3，示例配置使用 `@latest`。
- Chromium headless `--primitives`：15 个场景通过，包含 document 坐标纵向 pointer/HTML5 拖拽、普通 pointer/HTML5 拖拽、取消 pointerdown 默认行为后的可信回执、滚动边界后延迟增长和歧义候选。

## 升级前的浏览器验证

- Edge 155 headless `--primitives`：10 个场景通过，包含 hover 停留后点击子项、一次快照的 ref 连续输入并跨只读 evaluate 保持有效、替换节点拒绝、label/value/index 下拉选择、三种等待失败、pointer/HTML5 拖拽和目的元素滚入视口。
- Edge 155 完整 stdio MCP 集成：192 个调用通过，包含嵌套 OOPIF、原生/DOM 输入、遮挡、上传、日志、按键、滚动与导航；扩展报告 `extension_version=0.10.0`。
- Chromium 156、Edge 155 headless `--extended`：各 12 个场景通过，包含 ref 生命周期、选择框、拖拽、等待、历史导航和 OOPIF。
- `select_option` 明确返回 `events_trusted=false`；native select 点击在派发前拒绝。拖拽和输入只证明送达，不证明页面业务成功。

## 复跑

```sh
npm test
npm run test:package
node scripts/live-smoke.mjs --executable /path/to/browser --family edge
node scripts/interaction-smoke.mjs --primitives --headless --executable /path/to/browser --family edge
node scripts/interaction-smoke.mjs --extended --headless --executable /path/to/browser --family edge
```

真实浏览器测试需要允许命令行加载扩展的 Chromium / Edge 可执行文件，并只操作临时 profile 与本地 fixture。原始结果保存在被忽略的 `test-results/` 目录（`primitives-*.json`、`npm-live-*.json`、`extended-*.json`）。

## 已知限制

- 未覆盖独立 worker / service worker、WebSocket 消息、`window.showOpenFilePicker()`、目录上传、下载管理和网络拦截。
- 后台截图可能因浏览器暂停渲染而在 5 秒后超时；原生菜单和标签拖动可能抑制输入。
- readiness 是派发前的保守条件，不保证 compositor 或业务处理；输入真正派发后丢失可信回执仍报告 Outcome is unknown，不把“没观察到效果”当作零效果证明。
- 拖拽的自动滚动是目的元素驱动的滚入视口，不提供持续边缘滚动任务。
- `select_option` 不制造可信事件；`network_idle` 只覆盖 claim 后观察到的页面/iframe 请求。
- Monaco / CodeMirror 5 分支通过接口级测试，未针对第三方生产编辑器或特定 React/Vue 版本做站点验收。
- 计时数据仅代表本机 fixture，不构成对任意网站的耗时承诺。

## 历史验证

- 0.8.0（2026-10-21）：`npm test` 118 项通过；20 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
- 0.7.0（2026-10-21）：`npm test` 110 项通过；19 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
