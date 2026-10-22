# 验证报告

当前版本 **0.13.1**（2026-10-22）。验证使用本地 fixture 和临时 profile，链路为扩展 → 本机 Hub → stdio MCP。

## 当前版本

- 描述精简：实际 MCP 初始化与 tools/list 的描述文本从 18716 降至 11469 字符，减少 38.7%（不含 schema 结构，不等于 token 数）；instructions / 工具描述 / 参数说明分别为 1893 / 3949 / 5627 字符。跨工具规则、工具语义、参数选择规则与文档实现细节各自归位。
- 对比精简前后的实际 MCP 输出：23 个工具的名称与输入 schema 在移除 description 后完全一致；类型、枚举、默认值、范围与 required 均未改变。
- `npm test`：159 项通过；`npm run test:package`：仓库外安装运行通过，23 个工具、46 个发布文件，版本为 0.13.1。本次只调整描述与版本，未修改浏览器操作实现，未重复运行真实浏览器用例。

## 0.13.0 验证

- `npm test`：159 项通过。新增单页 fetch 参数、三种格式、采集上限、缓存分页、owner 隔离、断连清理、初始化与导航超时、文档/控制权变化、关闭失败保留所有权和迟到回执不续跑；保留原有 149 项回归覆盖。
- `npm run test:package`：仓库外含空格路径安装运行通过，23 个 MCP 工具、46 个发布文件；包含 `fetch.js`，不包含配对密钥，版本为 0.13.0。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 219 个调用通过。新增后台临时页不激活、单次导航、重定向与 HttpOnly 登录 Cookie、网络空闲等待延迟内容、无链接爬取、text/HTML/JSON、不可变分页、1000000 字符采集上限、非法 JSON 和导航超时后关闭；同时覆盖原有输入、OOPIF、上传、日志、截图与导航链路。

## 0.12.0 验证

- `npm test`：149 项通过。覆盖 interactive 快照的控件/祖先筛选、文本预览与原始 ref 身份、视图绑定分页、独占控制、快照/ref 生命周期、严格 selector 与有界歧义候选、原生/DOM 输入、逐字输入、hover、pointer/HTML5 拖拽、document 拖拽坐标差值与按轴滚动、滚动边界后的延迟加载、条件等待、HTML select、batch、历史导航、OOPIF、日志、上传、截图、对话框和未知结果不重放。
- `npm run test:package`：仓库外含空格路径安装运行通过，22 个 MCP 工具、45 个发布文件；包含 `drag.js` / `wait.js` / `scroll.js` / `outcomes.js`，不包含配对密钥。版本为 0.12.0，示例配置使用 `@latest`。
- Chromium headless `--primitives`：16 个场景通过，包含 interactive 快照、document 坐标纵向 pointer/HTML5 拖拽、普通 pointer/HTML5 拖拽、取消 pointerdown 默认行为后的可信回执、滚动边界后延迟增长和歧义候选。含 200 段正文的 fixture 中，默认 full 首屏 23302 字符且仍需续页，interactive 为 947 字符且无需续页；该比较只衡量返回内容，不代表 AX 采集提速。

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
