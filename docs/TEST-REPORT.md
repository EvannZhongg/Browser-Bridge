# 验证报告

当前版本 **0.17.2**（2026-10-23）。浏览器验证使用本地 fixture 和临时 profile；测试链路在各项下说明。

## 当前版本

- `npm test`：204 项通过。新增渲染文本的 expected/previous 比较与预览截取、1.5 万层深树的 full/interactive 遍历和正文合并、15 万节点观察的分页回归。用修改前的实现分别复现深树递归和宽树数组参数展开的 `Maximum call stack size exceeded`。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 254 次调用通过。真实 DOM 验证 script/style/隐藏子节点字面量不会提前满足 text wait，expected 与 previous 均等待渲染文字变化；1.2 万个显式语义节点在 max_nodes=1 下完成采集和续页，分别约 15.3 秒、16.6 秒。
- 剩余限制：Chromium 上 12 万个显式 group 节点的真实快照调用仍触及 MCP 60 秒请求超时。迭代渲染和逐项合并只消除栈及函数参数数量上限，不减少完整 AX 采集成本；max_nodes 仅控制分页，不代表超大页面能在现有预算内完成。
- `npm run test:package`：仓库外安装运行通过，23 个工具、50 个发布文件，不含配对密钥；无新增工具、运行依赖或扩展权限。
- 本机部署：Hub 从工作区重启，健康接口返回 0.17.2 / ready；`F:\.nosis\browser-attach\extension` 的 manifest 为 0.17.2，其余 31 个非生成源码/资源文件与工作区逐字节一致。Chrome、Edge 已自动重载并上报 0.17.2 / ready；已有 MCP 连接需重新连接。

## 0.17.1 验证

- `npm test`：200 项通过。新增并发升级与冷启动、旧配对缺少 `extension_dir` 的兼容回落、`release_all` 部分失败时的错误回传与剩余控制权保留、弹窗释放失败提示和显式重试，以及原有升级、清理和连接回归。
- Chromium 156 与 Edge 155：`npm run test:upgrade -- --executable <路径>` 均通过。临时 profile 开启开发者模式后，两个并发启动者将 Hub 和真实扩展从当前代码改版本号构造的兼容旧协议 0.16.9 升到 0.17.1；确认同一 profile、实际 runtime 重载后的版本，以及升级后发现/接管 → AX 查询 → DOM 点击 → 查询结果 → 释放。CDP 只用于临时 profile 的开发者模式设置，页面操作走扩展与 Hub。该脚本验证升级协议本身，不代表真实 0.16 扩展能自行重载；真实旧版本首次升级仍需手动重载。
- `npm run test:package`：仓库外安装运行通过，23 个工具、50 个发布文件；由已安装包中的 Hub 同步稳定扩展目录并运行 stdio MCP，不含配对密钥，无新增运行依赖或扩展权限。
- 本机部署：Hub 已从工作区重启并返回 0.17.1 / ready；`F:\.nosis\browser-attach\extension` 已同步，manifest 为 0.17.1。Chrome、Edge 均上报 0.17.1 并已重连。

## 0.16.0 验证

- `npm test`：184 项通过。新增 offset 的变换/越界处理、延迟区间校验、默认路径不采样随机数、拖拽曲线与精确终点、batch 参数预检、真实 stdio MCP 参数转发，以及 settle/拖拽超时后停止和调试分离取消待点击的回归。
- Chromium 156 与 Edge 155 headless 输入集成：各 19 个场景通过（扩展 → 独立 Hub 客户端）。新增非中心可信点击、offset hover、settle、区间逐字输入、曲线 pointer 与 HTML5 拖拽；实际记录移动坐标、可信事件和按键时间，保留原有默认路径及跨屏拖拽验证。不据此声称能通过任意网站的行为验证。
- Chromium 156 完整 stdio MCP 集成：244 次调用通过，保留发现/接管、输入、导航、OOPIF、日志、分页及临时页清理覆盖。
- `npm run test:package`：仓库外安装运行通过，23 个工具、48 个发布文件，版本 0.16.0；无新增依赖或扩展权限，不包含本机配对密钥。
- 本机部署：Hub 已从工作区重启，健康接口返回 0.16.0；扩展同步至 `F:\.nosis\browser-attach\extension`，29 个源码/资源文件哈希一致，manifest 版本为 0.16.0。Chrome 与 Edge 均已重新连接并上报 0.16.0；MCP 客户端需刷新连接以获取新 schema。

## 0.15.1 验证

- `npm test`：176 项通过。新增 AX 字面查询（名称/合并正文/value、预览前匹配、interactive 视图、零命中）、查询分页与新旧 ref 生命周期、默认精简/verbose 元数据、当前/祖先 frame 的遮挡诊断、诊断节点失效保留主错误，以及 drag 已派发预算不能误报“未派发”的回归。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 244 次调用通过。新增真实 AX 查询返回的 ref 可用于原生 hover、查询分页和 verbose 续页、零命中及 ancestor frame 的实际遮挡文字；保留输入、导航、OOPIF、日志、分页和临时页关闭链路。
- 同一构造表单 AX（2 个字段、2 个按钮，固定 URL/ref 前缀）比较 JSON 字符数：0.15.0 默认 908，0.15.1 默认 443（减少 51.2%），query=save 为 332。这里只衡量固定 fixture 的序列化输出，不代表题述表单、token 数或 AX 采集耗时。
- 实际 MCP tools/list：仍为 23 个工具；紧凑 JSON 从 36703 增至 37116 UTF-8 字节（新增 query/verbose 参数及说明，约 +1.1%），格式化 JSON 从 75945 增至 76502 字节。未声称 schema 总量下降；不新增工具分组、依赖或扩展权限。
- `npm run test:package`：仓库外安装运行通过，23 个工具、47 个发布文件，版本为 0.15.1；发布包不含本机配对密钥。
- 本机部署：已把扩展同步至 `F:\.nosis\browser-attach\extension`，关键模块与源码一致，Hub 健康接口返回 0.15.1。临时 Chromium 加载该实际副本连接共享 Hub，AX 查询 → 原生点击 → 查询确认页面变化通过。验证结束时用户原有浏览器尚未重新连接；仍需在 Chrome/Edge 重新加载扩展，并刷新 MCP 连接以获取新 schema。

## 0.15.0 验证

- `npm test`：172 项通过。新增 commit / DOMContentLoaded、等待超时后的降级采集、主文档替换后跟随 loader、采集期间只读重试、等待完成后换文档的身份核对、HTTP 错误响应关联及空体判断，以及标签创建/关闭超时和迟到清理；保留断连、控制权变化与不重放导航的回归覆盖。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 238 次调用通过。新增阻塞 load 时的早期等待及超时降级、load 前 location.replace、SSE 阻塞 network_idle，以及空体 418/500/503 的状态码和正文来源；同时验证既有输入、导航、OOPIF、分页与临时页关闭链路。
- Chromium 临时配置访问真实 URL：`https://httpbin.org/status/500` 与 `/status/503` 分别在约 689 ms、384 ms 返回对应状态、`ok=false`、空正文及 `http_error_response` 标记。`https://chatgpt.com/` 在约 2253 ms 返回 403 验证页的文档结果，未复现客户端跳转，不将该结果视为登录应用验收。
- `npm run test:package`：仓库外安装运行通过，23 个工具、46 个发布文件，版本为 0.15.0；无新增扩展权限与依赖。

## 0.14.0 验证

- `npm test`：165 项通过。新增主文档 frame/loader 状态匹配、未知状态、日志淘汰后状态保留、HTTP 错误正文、渲染后 DOM 标记、空标题省略、JSON 整份返回、四份缓存交叉续读与 LRU 淘汰；读完/失败的请求不淘汰已有缓存，同 URL 独立采集，保留断连及迟到回执不续跑的回归覆盖。
- Chromium 156 与 Edge 155 headless 完整 stdio MCP 集成：各 230 次调用通过。实际验证重定向后的 HTTP 200、404/500 保留正文并返回 ok=false、200 登录墙不误判成 HTTP 错误、子框架 404 不污染主文档状态、动态 DOM 插入与 dom=rendered、900000 字符 JSON 在 max_chars=400 下整份返回、超限 JSON 报错、四份缓存交叉续读与第 5 份 LRU 淘汰，以及临时页关闭和不激活。
- `npm run test:package`：仓库外安装运行通过，23 个工具、46 个发布文件，版本为 0.14.0；无新增扩展权限与依赖。

## 0.13.1 验证

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
- 未针对已登录 Gmail / Overleaf / ChatGPT 生产页面验收；这些页面可受登录状态、验证页、网络与应用初始化影响。降级保证以实际可读文档为准，不保证业务正文在期限内出现。

## 历史验证

- 0.8.0（2026-10-21）：`npm test` 118 项通过；20 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
- 0.7.0（2026-10-21）：`npm test` 110 项通过；19 个工具、40 个发布文件；Chromium 156 / Edge 155 各 191 次真实调用通过。
