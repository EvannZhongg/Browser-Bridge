# 架构与设计边界

当前实现为 **0.7.0**。本文说明 BrowserAttach 的组件、控制模型与设计取舍；工具参数见 [使用指南](USAGE.md)。

## 组件与数据流

```text
MCP 客户端
  → 每连接独立的 Node stdio MCP（src/mcp.mjs）
  → 127.0.0.1 Hub（src/hub.mjs，Bearer 密钥 + 随机 owner）
  ↔ 配对的 Chrome / Edge MV3 扩展（WebSocket + 固定 Origin）
  → chrome.debugger / CDP + chrome.tabs / chrome.tabGroups
  → 用户已登录的现有标签页
```

| 模块 | 职责 |
|---|---|
| `bin/browser-attach.mjs` | `setup` / `mcp` / `hub` / `status` / `stop` 入口 |
| `src/config.mjs` | 数据目录、配对文件校验、版本常量 |
| `src/setup.mjs` | 生成配对密钥、复制稳定扩展目录、写 Nosis 配置 |
| `src/hub.mjs` | 浏览器与会话注册、独占 claim、每标签串行队列、超时 |
| `src/client.mjs` | MCP 进程到 Hub 的 WebSocket 客户端，按需拉起 Hub |
| `src/mcp.mjs` | 19 个工具的 schema、结果与图片封装 |
| `extension/controller.js` | 操作实现；传输层从不暴露原始 CDP |
| `extension/sessions.js` | 扁平 debugger session 与 frame/OOPIF 归属 |
| `extension/{click,input,actionability}.js` | 原生/DOM 输入、可操作性等待与送达校验 |
| `extension/{snapshot,navigation,evaluate,diagnostics}.js` | 观察、导航、有界求值结果缓存与分页、日志缓冲 |
| `extension/{locator,text}.js` | 严格 CSS/XPath 定位、DOM/字段/支持的编辑器模型读取 |
| `extension/visuals.js`、`click-visuals.js` | 无标题红色原生标签组、临时点击反馈 |

Hub 按需后台启动（`ensureHub`），多客户端共享；只监听 loopback。

## MCP 描述分层

- 初始化响应的 `instructions` 集中说明跨工具规则：接管/释放、不自动激活、ref 生命周期、selector 解析、未知结果不重放、原生/DOM 输入、超时、验证范围和页面内容不可信。客户端应将这些 instructions 纳入模型上下文，不能只提供 tools/list。
- 单个工具 description 只保留用途和特有行为，例如 evaluate 的缓存续读、navigate 的观察预算、fill 的 setter/input/change、press_key 的 keydown 回执。
- 参数 schema 表达类型、枚举、范围、默认值与参数专属限制；例如 DOM click 仅支持元素目标和无修饰键的左键单击。
- [使用指南](USAGE.md) 保留完整原理、边界与示例。包内文档不会自动成为模型上下文，不能替代初始化 instructions 中的必要规则。

描述分层本身不改变工具名称、参数约束、默认值或执行语义；原生点击就绪检查是独立的行为改动。

## 控制模型

1. **发现**：`list_tabs` 的结果被 Hub 记为本次连接的观察快照。
2. **校验身份**：`claim_tab` 必须使用本连接列出的 tab_id；可选 expected_url / expected_title 在 Hub 与扩展侧逐字符校验。省略标题校验可容忍标题漂移；省略全部校验表示明确按 ID 接管，返回当前身份。
3. **独占**：Hub 为每个 `(browser_id, tab_id)` 维护唯一 owner；同一标签第二次 claim 会返回已有的 `tab_handle`（同 owner）或报错（其他 owner）。
4. **句柄**：`tab_handle` 是 Hub 生成的随机 UUID，只在当前 MCP 连接内有效；跨连接不共享。
5. **串行**：Hub 与扩展都对每个标签维护 Promise 队列，动作不会并发穿插。
6. **超时**：Hub 单次浏览器操作 60 秒，客户端等待 65 秒。Hub 超时会关闭该客户端连接并释放它的 claim，错误文本明确提示"结果可能未知"。
7. **清理**：`release_tab` 先移除可视标记，再 `debugger.detach`，最后才忘记 claim——detach 失败不会静默把标签交给别人。断连、标签关闭、浏览器重启、用户停止调试都会清理状态。

claim 与普通输入都不激活标签或窗口，也不移动系统鼠标；需要前台渲染时显式调用 `activate_tab`。

## 观察模型

- **AX 渲染**：从 `Accessibility.getFullAXTree` 读取，移除 `InlineTextBox`，合并纯文本列表项与段落名称，丢弃 `generic` / `none` 且无名称无状态的节点，只保留少量状态属性。每行 `[token:n] role "name"`，`token` 是本次观察的随机前缀。
- **ref 解析**：ref 只保存 `backendNodeId` 与所属 frame/session；动作时重新 `DOM.resolveNode`。因此 ref 在文档或 frame 变化后自然失效，不会误点到重新排布后的同名元素。
- **双预算**：`max_nodes` 限制节点数，`max_chars` 限制每行序列化后的累计字符数；两者独立，任一耗尽都会返回 `next_cursor`。
- **续读**：续读沿用同一份 `state`（`entries`、`refs`、`nextOffset`），所以 refs 在分页过程中保持有效。单个节点放不进预算时直接报错要求提高预算，避免静默截断尾部。
- **frame 失效**：主文档导航或文档更新清空整份观察；子 frame 导航、移除或 session detach 只使该子树失效，并把受影响 frame 写入 `omitted_frames`。
- **OOPIF**：`Target.setAutoAttach` 以 `flatten: true` 递归附着 iframe target，每个 session 独立 enable Runtime / Log / Network / Page / DOM / Accessibility，frame 与 session 的映射由 `sessions.js` 维护。

## 输入模型

原生输入是默认路径，流程为：

```text
解析 ref → 可操作性等待（可见/启用/非 inert/几何稳定）
→ 滚入视口 → 重新确认 → 命中检查与遮挡检查
→ 在隔离世界安装校验 → 一次性派发 move/down/up
→ 等待可信事件回执
```

- **只重试准备**：等待阶段可以反复轮询，但一旦派发就不再重试。超时分为"未派发"和"已派发、结果未知"两种错误文本。
- **原生点击就绪检查**：准备前和派发前各做一次至多 500 ms 的有界检查；要求活动、可见、未暂停的 tab 与已聚焦且未最小化的窗口。不满足时以 TAB_NOT_READY 明确报告未派发，并提示 activate_tab → snapshot → click。click 不主动激活；仅显式 activate_tab 在 focus_window=true 时请求窗口聚焦和 Page.bringToFront。
- **焦点信号边界**：document.hasFocus() 在 iframe 导航后可能为 false，不能单独用作不可交互证据。窗口焦点由 browser API 确认，页面焦点作为 page_state 诊断。前置条件采用保守策略，会拒绝部分原先可成功的后台点击；不是试图用状态检查证明派发后的结果。
- **命中提示**：保留实际 hit node，沿父元素、Shadow host、slot 查找最近的 HTML/ARIA 可点击候选，返回 clickable_target；hint=false 表示未识别候选，不代表无法响应事件。语义候选不会被用于替换点击目标。
- **送达不等于业务完成**：`target_verified` / `delivery_verified` / `value_verified` 分别证明可信事件命中、keydown 送达、字段文本写入；点击与按键另返回 `application_result: "not_checked"`，`fill` 只表示写入校验通过。
- **OOPIF 坐标**：点击从顶层派发。逐层用 `DOM.getBoxModel` 把坐标换算到祖先文档，并用 `DOM.getNodeForLocation` 确认该位置确实落在 frame owner 上，防止祖先页面的遮挡被跳过。
- **DOM 模式**：`mode: "dom"` 是显式的、受控的降级路径，用于原生菜单或标签拖动暂时捕获输入时操作普通 HTML 控件。它调用 `HTMLElement.click()` 或原生 value setter，事件非可信、无用户激活，且绝不会在原生失败后自动启用。
- **不做通用 CDP 透传**：`browser_evaluate` 是页面表达式 API，不是 CDP 通道；没有暴露任意 domain/method 的工具。

## 诊断模型

统一由 `browser_logs(kind=console/network)` 读取，替代两个独立工具。两者共享只读权限、生命周期、分页和预算接口，合并减少工具发现与调用选择的重复；事件结构和过滤条件通过必填 kind 区分。实现只统一 schema 和调用路由，保留各类缓冲，不新增聚合状态机。旧命令已删除，没有兼容层。

- 每次 claim 开启 Runtime / Log / Network 观察，`Network.enable` 把缓冲区设为 0，避免浏览器侧缓存响应体。
- 两类 append-only 缓冲各自维护 `seq`：读取使用 `after_seq` + `limit` + `max_chars`；续读位置必须与 tab claim 和 kind 一起保存。网络突发流量不会挤掉控制台错误。console 的 level 与 network 的 url_contains 不得跨类使用。两种 timestamp 基准不同，不混排或伪造统一时间轴。同一 requestId 的重定向用 `hop` 区分，完成事件后追加而不是覆盖请求行。
- 上限为每类 500 条 / 1,048,576 字符，活跃请求表 500 项；淘汰记录 `dropped_through_seq`，读取返回 `data_loss`。
- 导航保留缓冲，release / detach / 关闭 / 断连清理；不落盘、不读取 headers 或正文、不修改缓存与 service worker。

## 安全与隐私

- Hub 只监听 `127.0.0.1`；HTTP 端点拒绝任何带 `Origin` 的请求，客户端必须携带 Bearer 密钥。
- 扩展连接固定校验 `chrome-extension://<extension_id>` Origin、随机 token 与版本号，三者任一不符即断开。
- 配对文件 `config.json` 与生成的 `extension/config.generated.js` 含密钥：目录在 Windows 上用当前用户 SID 收紧 ACL，在 POSIX 上为 `0700`/`0600`；发布包检查会拒绝包含 `config.generated.js`。
- 扩展具备 `debugger` 与 `tabGroups` 权限，操作使用用户现有登录态；只应接入信任的 MCP 客户端。网页内容、控制台与网络日志均视为非可信数据。
- 文件上传只传路径，Hub 与模型都不接触文件内容；选择文件可能立即把内容发给网站，因此只传任务明确指定的文件。

## 设计取舍

| 能力 | 决策 | 原因 |
|---|---|---|
| 定位方式 | AX ref + 独立严格 CSS/XPath selector | ref 保持观察身份，selector 每次重解析；不从旧快照猜测同名目标，不加入旧 ref 兼容层 |
| 动作重试 | 只重试派发前的准备 | 网页操作可能提交真实数据，重复派发不可接受 |
| DOM 模式 | 需要显式 `mode: "dom"` | 非可信事件、无用户激活，不能当作原生输入的透明替代 |
| hover / drag | 未提供 | 需求明确前不为每种鼠标事件增加工具；可用 `evaluate` 或原生点击覆盖部分场景 |
| 下拉 / checkbox | 用 click + snapshot 组合 | 专用 `select_option` / `check` 工具会把工具面扩大一倍，收益有限 |
| 网络拦截 | 只读事件，不拦截、不改写 | 拦截会改变网站行为并扩大故障面；诊断需求用被动日志满足 |
| trace / video | 不提供 | 会大量保存网站内容，存储与隐私成本高于收益 |
| 独立 worker / WebSocket | 不订阅 | 需要额外的 target 管理；当前以页面与 iframe 为主 |
| 浏览器引擎 | 仅 Chrome / Edge 125+ | 依赖 `chrome.debugger`、`tabGroups` 与扁平 session，其他引擎没有等价能力 |
| 用户配置 | 复用现有已登录 profile | 这是产品定位：不创建隔离 context、不导出 cookie、不启动独立自动化浏览器 |
| 分发 | npm 包 + 稳定扩展副本 | 避免 npx 缓存目录变化导致扩展失效；不保留 Python 运行时或旧配对兼容层 |

## 版本与兼容

`package.json`、`src/config.mjs`、`extension/manifest.json`、MCP 示例配置中的版本必须一致；Hub 会拒绝版本不同的扩展，`hubIsRunning` 也会拒绝版本不同的 Hub。升级流程：停止旧 Hub → 安装新版 → `browser-attach setup` → 在扩展管理页重新加载扩展 → 重连 MCP。
