# BrowserAttach 使用指南

适用于 **0.8.0**：Node.js 22+、Chrome / Edge 125+、20 个 MCP 工具。安装、配对与升级见 [README](../README.md)；内部实现与安全模型见 [架构说明](ARCHITECTURE.md)。

工具发现采用三层说明：初始化 `instructions` 提供跨工具规则，各工具 description 和参数 schema 说明自身行为与约束，本文保留完整边界和示例。客户端集成时应把 MCP 初始化响应中的 instructions 传入模型上下文；仅读取 tools/list 不会包含完整的通用调用规则。

## 基本流程

1. `browser_list_browsers` 取得 `browser_id`、浏览器族、版本和能力表。
2. `browser_list_tabs(browser_id)` 取得目标标签的 `tab_id`、精确标题 / URL 与控制状态。
3. `browser_claim_tab(...)` 独占接管，拿到本连接的 `tab_handle`。
4. `browser_snapshot(tab_handle)` 读取语义树与元素 `ref`。
5. 用当前 ref 执行**一次**动作，动作后重新观察。
6. `browser_release_tab(tab_handle)` 释放控制，页面保持打开。

`tab_id` 必须来自本连接最近一次 `list_tabs`。`expected_url` / `expected_title` 是可选的精确校验；提供时须与列表及接管时的实际标签逐字符一致。标题易变时只传 `expected_url`，或明确按 `tab_id` 接管并检查返回的当前身份。同一标签只允许一个 owner，`tab_handle` 不能跨连接使用。

## 工具速查

### 发现与标签管理

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_list_browsers` | — | 已连接的浏览器配置、`browser_id`、能力表 |
| `browser_list_tabs` | `browser_id` | `tab_id`、标题、URL、`active`、`group_id`、`controllable`、控制状态 |
| `browser_open_tab` | `browser_id`, `url`, `active=false` | 仅 HTTP(S)；默认后台打开，返回 `tab_id`，加载后 list + claim |
| `browser_claim_tab` | `browser_id`, `tab_id`, 可选 `expected_url` / `expected_title` | 按列出的 ID 接管，可显式加身份校验 |
| `browser_release_tab` | `tab_handle` | 解除调试并释放控制，不关闭页面 |
| `browser_activate_tab` | `tab_handle`, `focus_window=true` | 显式选中标签并聚焦窗口；`false` 只选中标签 |
| `browser_close_tab` | `tab_handle` | 关闭标签并作废句柄，可能丢失未保存状态 |

### 观察

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_snapshot` | `max_nodes=600`, `max_chars=24000`, `cursor` | AX 语义树、元素 ref、frame 覆盖、待处理文件选择器 |
| `browser_read_text` | `mode`, `selector`, `offset=0`, `max_chars=20000` | 主 frame 的 DOM、字段值或支持的编辑器模型 |

### 输入

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_click` | `ref` / `selector` / `x`+`y`、`coordinate_space`、`button`、`click_count`、`modifiers`、`mode`、`timeout_ms` | 原生可信点击或显式 DOM 点击 |
| `browser_fill` | `ref` / `selector`, `text`, `mode`, `timeout_ms` | 文本 / textarea / contenteditable，写入后核验文本 |
| `browser_press_key` | `key`, `timeout_ms` | 单键或组合键，核验可信 keydown 送达 |
| `browser_batch` | `steps`, `timeout_ms=15000` | 单队列内顺序执行 1–20 步 click/fill/press_key，失败即停并返回部分结果 |
| `browser_scroll` | `delta_y`, `delta_x`, `x`, `y`, `mode`, `timeout_ms` | 容器 `scrollBy` 或原生 wheel |

### 页面、文件与诊断

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_navigate` | `url`, `wait_until=domcontentloaded`, `timeout_ms=15000`, `include_snapshot=true` | 等待并返回新文档标题、URL、快照 |
| `browser_handle_dialog` | `accept`, `prompt_text` | alert / confirm / prompt |
| `browser_upload_file` | `files`, `ref`（可省略） | 原生 file input、隐藏 input 或已拦截的选择器 |
| `browser_screenshot` | `full_page=false`, `include_indicators=false` | PNG + 像素到视口 CSS 的映射 |
| `browser_evaluate` | `expression`, `timeout_ms=10000`, `max_chars=20000` | 主 frame 表达式求值，可等待 Promise |
| `browser_logs` | 必填 `kind=console/network`, `after_seq`, `limit`, `max_chars`, `level` / `url_contains` | 统一读取控制台、异常或网络日志；过滤条件按 kind 区分 |

普通结果是一份紧凑 JSON 文本；截图另外返回标准图片内容。失败通过 MCP `isError` 返回，错误文本即原因。

## 观察：快照与引用

`browser_snapshot` 返回 `snapshot` 文本（每行 `[token:n] role "name" 状态`）、`snapshot_id`、`node_count`、`total_node_count`、`truncated`、`truncation_reason`（`node_limit` / `text_budget`）、`next_cursor`、`viewport`、`omitted_frames`，以及当前 `title` / `url`。

- 渲染时移除 `InlineTextBox`，合并纯文本列表项与段落名称，保留 `disabled`、`focused`、`expanded`、`checked`、`selected`、`required`、`invalid`、`level` 等状态，以及浏览器提供的 `value`；`[token:n]` 即后续动作使用的 `ref`。未提供 invalid/selected 等属性不代表有效或已提交；value 也可能只是下拉框的过滤文本。
- `max_nodes` 为 1–3000（默认 600）；`max_chars` 为 1–2000000（默认 24000），按行序列化长度累计，与节点数是两个独立预算。
- `truncated: true` 时把 `next_cursor` 传回同一个工具继续读取同一份观察，refs 在续读期间保持有效；也可以调整预算。单个超长节点放不下时会明确报出所需预算，不静默丢尾部。
- 覆盖主 frame、同进程 iframe 与递归 OOPIF；读取失败、读取期间变化或附着失败的 frame 列入 `omitted_frames`。

失效规则：

| 事件 | 影响 |
|---|---|
| `click` / `fill` / `press_key` / `scroll` / `upload_file` / `evaluate`（新表达式） | 全部 refs 与 cursor 失效；`evaluate` 的 `cursor` 续读不失效 |
| 新的 `browser_snapshot` | 旧 refs 失效 |
| 主文档导航、同文档导航、文档更新 | 全部 refs 与 cursor 失效 |
| 子 frame 导航或移除 | 仅该子树 refs 失效，其余保留 |
| `release_tab` / `close_tab` / 断连 | 全部失效 |

`browser_read_text` 读取主 frame，`max_chars` 为 1–100000（默认 20000）。`mode=visible` 使用 innerText；`text_content` 使用 textContent；`value` 要求用 selector 唯一选中 input、textarea 或 contenteditable；`editor` 要求 selector 对应支持的 Monaco 或 CodeMirror 5 实例并读取完整模型。Monaco 必须在页面暴露 `monaco.editor.getEditors()`，CodeMirror 5 必须在选中节点暴露实例。未知编辑器明确报错，使用站点专用 evaluate 适配；不猜测模块内部状态。

返回 `source`、`complete_source`、`total_chars`、`returned_chars`、`truncated`、`next_offset`。DOM 和 contenteditable 无法保证包含虚拟化内容，`complete_source=false`；字段 value / 支持的模型为 true。`next_offset` 用于下一次实时读取，内容变化可能导致重复或遗漏；需要一致结果时用 evaluate 一次提取并续读缓存。

## 输入：可操作性与两种模式

`click`、`fill`、`press_key` 共用一套等待逻辑：可见、启用、非 `inert`、几何位置连续稳定；`fill` 还要求可编辑且非只读，`press_key` 会从当前焦点逐层进入 OOPIF 找到接收方。`timeout_ms` 默认 5000、范围 100–30000，**一个截止时间**覆盖准备、派发与校验；准备阶段只轮询、不派发，派发只发生一次。

### browser_click

| 参数 | 取值 | 说明 |
|---|---|---|
| `ref` / `selector` / `x`,`y` | 三选一 | ref 来自最新快照；selector 每次重解析 |
| `selector_type` / `frame_id` | `css`（默认）或 `xpath` / 快照中的 frame ID | 仅 selector 使用；默认主 frame |
| `nth` | 从 0 开始的整数 | 仅 selector 使用；显式选择当前匹配的第 N 项，省略则要求唯一 |
| `coordinate_space` | `viewport`（默认）/ `document` | 仅坐标点击使用；document 自动滚动顶层文档后换算到视口 |
| `button` | `left`（默认）/ `middle` / `right` | |
| `click_count` | `1`（默认）/ `2` | 双击按顺序重复 down/up |
| `modifiers` | `Alt` / `Control` / `Meta` / `Shift` | 默认空数组 |
| `mode` | `native`（默认）/ `dom` | DOM 模式接受 ref 或 selector |

原生模式按序派发 move → down → up，显式设置 `buttons` 与修饰键，并在隔离世界安装命中校验：成功返回 `target_verified: true`、`application_result: "not_checked"`。左键单击 / 双击分别校验 `click` / `dblclick`，中键校验 `auxclick`，右键校验 `contextmenu`。目标被遮挡、在 hover 后移动或派发中变化时会明确报错并阻止不匹配事件；已送达的前序事件可能已有副作用，不能撤销或自动重试。

原生 click 在准备前、派发前分别检查顶层 tab 的 active/discarded/frozen、窗口是否最小化，并读取 `document.visibilityState` 和 `document.hasFocus()`；每次检查最多 500 ms，且受总输入截止时间限制。未选中的标签、暂停的页面或最小化窗口快速返回 `TAB_NOT_READY` 和 `No input was dispatched`，不自动调用 bringToFront。可显式调用 `browser_activate_tab`（默认 focus_window=true），重新 snapshot 后再 click。

成功结果的 `page_state` 包含 visibility_state、has_focus、window_focused。这些信号仅作诊断：活动标签所在窗口即使未处于 OS 前台，或者因遮挡报告 hidden，仍可尝试一次原生点击，并验证可信事件送达。不能据此保证任意后台页面都能交互；没有可信回执时仍报告未知结果，不重放、不自动切换 DOM 模式。

原生 ref/selector 点击已自动滚入视口；viewport 坐标保留严格视口边界。document 坐标针对顶层文档，嵌套滚动容器和动态布局优先用 selector/ref。`hit_target` 返回实际命中的 tag、最多 300 字符 text、role、disabled、clickable_hint，并由 clickable_target 给出最近的可点击候选祖先（含自身）的 tag/role/text。查找跨越 Shadow host 和 slot，例如 span 在 button 内时保留 tag=span，同时返回 clickable_hint=true、clickable_target.tag=button；disabled 同时观察祖先的禁用/inert/aria-disabled 状态。

hint 仅为 HTML/ARIA 启发式判断，false 表示未找到候选，不能证明元素不可点击，也不能覆盖所有事件代理。它不会替换真正的鼠标命中节点或改变派发目标。坐标点击无法推断调用者的业务意图，DOM/网络变化也不能证明业务成功，需按具体任务观察。

`selector` 可复用，但不是永久元素身份。输入准备阶段会等待匹配出现，受同一 timeout_ms 限制；省略 nth 时多个匹配立即报错。显式 nth 按当前文档顺序选择，尚未出现该索引时等待；行顺序变化后须重新确认目标。解析后元素被替换会安全失败，不自动重放。CSS/XPath 不穿透 Shadow DOM，那里继续使用 AX ref；iframe 用明确 `frame_id`。例如 `browser_fill({tab_handle, selector:'input[placeholder="公司名称"]', nth:1, text:"第二段经历", mode:"native"})`；XPath 同样支持 nth。

坐标命中 CSS 伪元素时，以其 originating element 做描述和事件校验，`hit_target.pseudo_element=true`。截图坐标仍按截图元数据换算；优先用 ref/selector 避免布局漂移。

`mode: "dom"` 只对 HTML 元素调用一次 `HTMLElement.click()`，返回 `method: "dom"`、`events_trusted: false`：没有 pointer 事件、没有用户激活，也不支持修饰键或坐标。自绘控件、拖拽、依赖 pointerdown 的功能仍需原生输入。两种模式都不会自动互相降级。

跨进程 iframe 会逐层检查父页面遮挡并换算坐标，最终从顶层派发；返回的 `clicked` 始终是顶层视口 CSS 坐标。透视变换的 iframe 会被明确拒绝。

### browser_fill

支持文本类 `input`（text / search / email / password / tel / url）、`textarea` 与 `contenteditable`；传当前 ref 或严格 selector。

- `native`（默认）：聚焦、选中后发送原生 `insertText`。
- `dom`：用原型上的原生 value setter（contenteditable 用 `textContent`）写入，派发非可信 `input` / `change`，不主动聚焦；可通知 React/Vue 受控字段，不能保证所有自定义编辑器的内部状态。
- 两种模式都核对字段最终文本，成功返回 `value_verified: true`、`application_result: "not_checked"`；被吞、失焦或页面同步格式化导致不匹配时报错，且不回显字段内容。这不证明框架状态、选项提交、后续重渲染保留或业务保存。
- 不会自动 blur 或按 Enter。需要失焦校验时显式 press_key Tab 或点击其他明确目标；自定义年/月/城市选择器输入通常只是过滤，还需点击具体选项。Enter 的语义由站点决定。校验文案可能滞后，应同时观察选中项和字段值；添加行前先确认已提交选项，不能只看输入框里的文本。

### browser_batch

同一 tab_handle 内一次传入 1–20 个明确步骤，action 仅支持 click/fill/press_key；click/fill 必须使用 selector，可带 selector_type、frame_id、nth 和 mode（默认 native）。click 还支持 button/click_count/modifiers。不能使用 refs 或坐标；不会跨输入保留旧元素身份。

```json
{"tab_handle":"...","steps":[
  {"action":"fill","selector":"input[placeholder=公司名称]","nth":1,"text":"公司名称"},
  {"action":"press_key","key":"Tab"}
]}
```

timeout_ms 默认 15000，范围 100–30000，是整批准备、派发和校验的总预算。所有参数先预检，每一步复用原有输入流程，尚未渲染的选项可在准备阶段等待；不会自动猜选项或增加交互。步骤间不插入其他同标签命令。成功返回 completed=true、results；首个失败返回 MCP isError=true 以及 completed=false、results（此前完成结果）、failed_step（从 0 开始）、error。发生主文档变化、断开接管或弹窗也会停止。整批不具备事务或回滚语义，不要重放已完成步骤；失败步骤可能已产生副作用，先观察。

用 batch 合并已知的“打开 → 原生输入过滤 → 点击具体选项”路径；不确定下一目标时先结束本批，snapshot/evaluate 观察后再继续。evaluate 中的 JavaScript 不能制造可信输入事件。

### browser_press_key

支持 F1–F12、Enter / Tab / Escape / Backspace、Insert / Delete、四个方向键、Home / End / PageUp / PageDown，以及 ASCII 字母、数字和 US 键盘标点。标点既可直接传字符，也可用物理键名：`Semicolon`、`Equal`、`Minus`、`Comma`、`Period`、`Slash`、`Backquote`、`BracketLeft`、`BracketRight`、`Backslash`、`Quote`、`Space`。

- `Shift+1` 生成 `!`，`Shift+/` 生成 `?`；直接传 `?`、`:`、`+` 会自动补 Shift。
- `+` 或 `Plus` 表示加号，组合键写 `Control++`；普通字母需要大写时显式使用 `Shift+A`。
- Control / Alt / Meta 组合不额外插入文本。
- 在隔离世界监听可信 keydown，成功返回 `delivery_verified: true`；无法建立校验的 frame 列入 `verification_omitted_frames`。浏览器保留的快捷键可能被浏览器截获。没有 DOM 快捷键替代模式。

### browser_scroll

- `x` / `y` 始终是顶层视口 CSS 坐标，省略时取视口中心；正 `delta_y` 向下，正 `delta_x` 向右，单位为 CSS 像素。
- `mode: "dom"`（默认）在指定位置逐层查找可滚动容器并调用 `scrollBy`，不触发 wheel；可进入闭合 Shadow DOM 与同源 iframe，跨源 iframe 会明确报错。
- `mode: "wheel"` 从顶层派发原生 wheel，由浏览器路由到容器或 OOPIF，遵守祖先页面遮挡；返回 `method: "native_wheel"`、`dispatched: true`，仅表示 CDP 已确认派发，不保证处理器执行或页面移动。
- DOM 模式返回 `scrolled`、`before` / `after`、`scope`（`document` 或 `element`）。

### 结果未知时

派发之后的超时会释放工具队列，但动作可能已经送达或稍后生效。此时先观察页面（快照、截图、日志），不要自动重放，也不要为了补一次而切换模式。

`TAB_NOT_READY` 是明确的派发前失败，可以在激活、重新观察后再点击；它不属于“结果未知”。即使前置检查通过，用户仍可能在派发瞬间切换标签，浏览器菜单也可能捕获输入。派发后没有回执仍须报告 Outcome is unknown，不能仅凭 visibility/focus 或“没有观察到变化”宣称零效果。

## 导航、对话框与截图

`browser_navigate` 只接受不带凭据的 HTTP(S) URL。

| 参数 | 默认 | 范围 / 说明 |
|---|---|---|
| `wait_until` | `domcontentloaded` | `commit` 只等提交，`load` 等 load 事件；同文档 hash 导航不等待新的加载 |
| `timeout_ms` | 15000 | 100–40000 |
| `include_snapshot` | `true` | 关闭时只返回标题与 URL |

导航成功后另有一次 10000 ms 的观察预算；观察失败会返回导航结果加 `observation_error`、`observe_again`，不会把已成功的导航报告为失败。Hub 侧操作上限 60 秒、客户端 65 秒，覆盖最长导航加观察并保留传输余量。超时不代表导航已取消，SPA 在 `DOMContentLoaded` 之后仍可能异步更新。

观察遇到文档变化、执行上下文销毁等瞬时错误时，内部只重读一次，共享同一 10 秒预算；不会重新导航。权限错误和预算耗尽不重试。

页面弹出 JavaScript 对话框时，`browser_snapshot` 会返回 `dialog` 对象，其他动作（除 `release_tab`）被拒绝；用 `browser_handle_dialog` 接受或取消，`prompt_text` 只在 prompt 时使用。对话框打开期间仍可读取控制台和网络日志。

handle_dialog 返回原始 `dialog.type/message/default_prompt` 和 `accepted`。`default_button=null`，协议不提供浏览器默认按钮焦点。beforeunload 只有实际弹出时才能观察，浏览器可能因缺少用户激活而抑制它。DOM 值写入不证明应用已保存或 dirty=false；不存在跨框架可靠的通用 dirty 检测，导航前按任务检查保存标志或业务接口。

`browser_screenshot` 返回 PNG 与 `capture` 元数据：`scope`（`viewport` / `full_page`）、`viewport`、`css_width`、`css_height`、`image_origin_css`、`image_to_viewport_css`。像素到视口坐标的换算为 `css = 像素 × scale + offset`。超时为 5 秒；被遮挡或非活动的 Chromium 页面可能暂停渲染，此时先 `browser_activate_tab`，或改用 AX / 正文。整页截图超过 4000 万像素会被拒绝；整页图中的视口外位置需要先滚动。

默认截图隐藏约 1.2 秒的原生点击反馈；`include_indicators: true` 可保留。截图本身不会激活标签或窗口。

## 文件上传

方式一，直接使用新快照中文件 input 或其关联 label 的 ref：

```json
{"tab_handle":"...","ref":"<最新快照中的文件输入框 ref>","files":["C:/Users/example/Documents/report.pdf"]}
```

方式二，隐藏 input 或自定义上传按钮：

1. `browser_click` 点击“Choose file”之类的按钮。
2. 返回结果或下一次 snapshot 中出现 `file_chooser: { pending: true, ... }`。
3. 调用 `browser_upload_file(tab_handle, files)`，省略 ref，使用被拦截的真实 input。

`files: []` 清空指定 input 或结束待处理的选择，页面会收到 `input` / `change`。文件通过 `DOM.setFileInputFiles` 在浏览器本机设置，不读取内容到 MCP 或 Hub，也不弹系统文件框。

- 路径必须是浏览器所在机器的绝对可读路径，最多 100 个；支持单文件、多文件、中文 / 空格路径与空文件。
- 多文件要求 input 具有 `multiple`；禁用、失效 ref、目录路径和 `webkitdirectory` 会被拒绝。
- `accept` 只是网页提示，不做格式校验；网站仍可自行拒绝。
- 选择文件可能立即触发网站自动上传，只传任务指定的文件；选择成功不代表服务端上传完成。
- File System Access API 的 `showOpenFilePicker()` 与原生权限弹窗不在支持范围；跨进程 iframe 的 file input 已支持。

## JavaScript 求值

```json
{"tab_handle":"...","expression":"({title: document.title, count: document.querySelectorAll('a').length})"}
```

`expression` 最多 100000 字符，需要多条语句时使用 `(() => { ...; return result; })()`，异步使用 `(async () => { ... })()` 或直接返回 Promise。表达式在主 frame 的页面世界执行一次，可访问页面变量、DOM 和当前登录态，可产生写操作，但不授予用户激活；函数值不会被自动调用。

- `timeout_ms` 默认 10000、范围 100–30000；CDP 同步执行时间与 Promise 等待共用该预算。超时会释放工具队列，但不保证取消已调度的异步代码或网络请求。
- `max_chars` 默认 20000、范围 1–100000，限制每页 value 的 JSON 字符预算（不含元数据）。
- 每个被控标签最多缓存一份结果，捕获预算为 1000000 个 JSON 字符、50000 个节点、8 层；只读取自有可枚举数据属性，不调用 getter，数组按索引读取。捕获损失由 `capture_truncated` 标记；转义后超出捕获上限时返回结构化 `$type=truncated` 标记，不返回半截 JSON。
- 数组按完整项、对象按完整键值对、字符串按片段分页，返回 `result_kind`、`has_more`、`next_cursor`。下一页只传 `cursor`，不能再传 expression；续读只读缓存，不执行页面脚本，也不使当前 AX refs 失效。输入不改变已捕获结果；新求值、主文档导航/更新、释放或断连清空缓存。
- 单项放不下时返回 `budget_too_small`、`required_chars`、`next_cursor`，可提高预算续读，不必重新执行。单个嵌套值超过 100000 字符时应在表达式中提取更小的字段；分页不递归拆解嵌套对象。
- 特殊值用 `$type` 标记：`undefined`、`bigint`、`number`（NaN / Infinity / -0）、`date`、`error`、`function`、`symbol`、`accessor`、`circular_or_repeated`、`truncated`。Map、Set、DOM 等实例只遍历可枚举属性，需要稳定结果时返回普通对象或字符串。
- 执行新表达式后 refs 全部失效；报错或超时前可能已修改页面，先观察，不要自动重放。

异步 IIFE 已能表达多步 JavaScript 流程，例如 `(async()=>{const r=await fetch('/api/state');return await r.json()})()`；它不能调用 MCP 原生输入工具。最多 30 秒，没有后台 job 或超时后的结果续接。长工作流按可观察检查点拆分；游标仅续读成功捕获的结果。超时不等于取消异步副作用。

## 诊断日志

```json
{"tab_handle":"...","kind":"console","level":"error","after_seq":0,"limit":100,"max_chars":24000}
```

使用 `browser_logs` 读取日志，`kind` 必填且只能是 `console` 或 `network`，没有默认值或混合模式。返回包含 `kind`、`entries` 及续读元数据。两类日志各自拥有缓冲和序列，只能在同一标签、同一次 claim、同一个 kind 内续读：把返回的 `next_seq` 作为下一次的 `after_seq`，切换 kind 时使用该 kind 自己的续读位置。`limit` 为 1–200，`max_chars` 为 1000–100000（约束 `entries` 数组）。`has_more` 表示还有事件可扫描，`latest_seq` 是当前末尾；被过滤器跳过的事件也会推进游标，想在改过滤条件后回看旧事件应从 `after_seq: 0` 开始。

网络查询示例：`{"tab_handle":"...","kind":"network","url_contains":"/api/","after_seq":0}`。`level` 仅接受 console，`url_contains` 仅接受 network；传错类型明确报错，不会静默忽略。读取不消费缓冲，不使快照 refs 失效，JS 对话框打开时也可读取。

- 控制台：`level` 可选 `log` / `debug` / `info` / `warning` / `error`，收集 console、未捕获异常 / rejection 和浏览器 Log 消息。对象参数是浅层预览，没有 live handle；行号列号从 0 开始，`timestamp` 与 `capture_started_at` 是 Unix 毫秒。
- 网络：`url_contains`（最多 2000 字符）过滤 URL，事件为 `request` / `redirect` / `response` / `finished` / `failed` / `cache`。按 `session_id`、`request_id` 和重定向 `hop` 关联；404 属于 `response`，连接失败属于 `failed`。timestamp 是 CDP 单调时钟秒，`request` 另带 Unix 秒的 `wall_time`。
- 每次 claim 自动开启 Runtime / Log / Network 观察；过滤启用时会重放 claim 之后的历史控制台消息，已发生的网络请求无法追溯。导航不清空日志，`release`、detach、关闭或断连清理，不写入磁盘。
- 每类最多保留 500 条、1,048,576 个 JSON 字符，活跃请求关联表最多 500 项。淘汰时 `data_loss: true` 并由 `dropped_through_seq` 标识缺口；关联表溢出可能让完成事件缺少 URL / hop，但仍保留 `request_id`。单条字段超长时尾部显示 `…[truncated]`；单条放不进读取预算时返回 `truncated: true` 的预览并推进游标。
- 网络不保存 headers、请求体或响应体，也不修改缓存、service worker 或拦截请求；URL 与控制台内容仍可能包含网站数据。
- 覆盖主 target、同进程 frame 与递归附着的 OOPIF，日志带 `session_id`（主 session 为 null），解析出上下文时带 `frame_id`。独立 worker / service worker 与 WebSocket 消息不在覆盖范围。

## 标签栏控制标记

被控标签会临时进入一个**无标题的红色原生分组**（使用 `tabGroups` 权限），扩展按钮同时显示 `RUN` 徽标。分组不修改网页标题、favicon 或正文，也不注入页面脚本。

- 正常释放、MCP 断连或浏览器停止调试时移除标记并恢复原分组；原分组已因空组消失时按记录重建。
- 用户期间改名、改色或移动标签时保留用户的调整；恢复分组不保证原标签顺序。
- 固定标签不能加入分组，claim 会返回 `visual_warning`，扩展徽标仍可显示；需要分组标记时先取消固定。

## 限制与排查

- 仅支持 Chrome / Edge 的 HTTP(S) 页面；不含 `chrome://`、扩展页与本地文件。最低浏览器版本 125。
- 不支持下拉专用选择、hover / drag、下载管理、网络拦截、测试运行器、Firefox / WebKit；独立 worker 与 WebSocket 消息不可见。
- 标签拖动或浏览器原生菜单可能捕获原生输入，CDP 返回成功不等于页面收到事件；结束该交互后再依赖原生输入。不要用 `Input.setIgnoreInputEvents(false)` 强行解除用户的菜单 / 拖动状态。
- 后台操作要求浏览器运行且页面未冻结；网站自己弹窗或权限 UI 仍可能改变焦点。
- `target_verified`、`delivery_verified`、`value_verified` 只证明事件送达或文本写入，不证明提交、付款、服务端上传等业务完成。
- Hub 日志位于配对文件同目录的 `hub.log`；`browser-attach status` 查看连接状态，`browser-attach stop` 停止 Hub。
- 宿主把大结果保存为 Artifact 时，长行可能被宿主截断；这是宿主读取行为，不是快照游标分页。相关说明见 [Nosis 集成](NOSIS-INTEGRATION.md)。
