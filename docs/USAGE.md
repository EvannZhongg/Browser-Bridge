# BrowserAttach 使用指南

适用于 **0.15.0**：Node.js 22+、Chrome / Edge 125+、23 个 MCP 工具。安装、配对与升级见 [README](../README.md)；内部实现与安全模型见 [架构说明](ARCHITECTURE.md)。

工具发现采用三层说明：初始化 `instructions` 提供跨工具规则；工具 description 说明用途、独有行为与结果语义；参数 schema 及其短说明提供类型、默认值和选择规则。本文保留完整原理、边界和示例。客户端集成时应把 MCP 初始化响应中的 instructions 传入模型上下文；仅读取 tools/list 不会包含完整的通用调用规则。

## 基本流程

1. `browser_discover(kind="browsers")` 取得 `browser_id`、浏览器族、版本和能力表。
2. `browser_discover(kind="tabs", browser_id)` 取得目标标签的 `tab_id`、精确标题 / URL 与控制状态。
3. `browser_claim_tab(...)` 独占接管，拿到本连接的 `tab_handle`。
4. `browser_snapshot(tab_handle)` 读取语义树与元素 `ref`。
5. 使用 ref 或 selector 执行动作；原节点仍存在时 ref 可复用，需要新信息时再观察。
6. `browser_tab_control(action="release", tab_handle)` 释放控制，页面保持打开。

`tab_id` 必须来自本连接最近一次 `discover(kind="tabs")`。`expected_url` / `expected_title` 是可选的精确校验；提供时须与列表及接管时的实际标签逐字符一致。标题易变时只传 `expected_url`，或明确按 `tab_id` 接管并检查返回的当前身份。同一标签只允许一个 owner，`tab_handle` 不能跨连接使用。

## 工具速查

### 发现与标签管理

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_discover(kind="browsers")` | — | 已连接的浏览器配置、`browser_id`、能力表 |
| `browser_discover(kind="tabs")` | `browser_id` | `tab_id`、标题、URL、`active`、`group_id`、`controllable`、控制状态 |
| `browser_open_tab` | `browser_id`, `url`, `active=false` | 仅 HTTP(S)；默认后台打开，返回 `tab_id`，加载后 discover(kind=tabs) + claim |
| `browser_claim_tab` | `browser_id`, `tab_id`, 可选 `expected_url` / `expected_title` | 按列出的 ID 接管，可显式加身份校验 |
| `browser_tab_control(action="release")` | `tab_handle` | 解除调试并释放控制，不关闭页面 |
| `browser_tab_control(action="activate")` | `tab_handle`, `focus_window=true` | 显式选中标签并聚焦窗口；`false` 只选中标签 |
| `browser_tab_control(action="close")` | `tab_handle` | 关闭标签并作废句柄，可能丢失未保存状态 |

`discover.kind` 与 `tab_control.action` 必填，无默认值。`browser_id` 仅在 `kind=tabs` 时使用且必填；`focus_window` 仅在 `action=activate` 时使用，省略时为 `true`。其他分支传入这些参数会在派发前报错。新建标签仍需加载后发现并显式接管，不会自动取得控制权。

### 观察

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_snapshot` | `profile`, `text`, `text_limit`, `max_nodes=600`, `max_chars=24000`, `cursor` | AX 语义树、元素 ref、frame 覆盖、待处理文件选择器 |
| `browser_wait` | `condition`, `selector`, `expected` / `previous`, `idle_ms=500`, `timeout_ms=5000` | 只读等待元素、文本、URL 或被动网络空闲 |
| `browser_fetch` | `browser_id`, `url`, `wait_until=load`, `format=text`, `max_chars=20000`, `cursor` | 后台临时页读取一次，关闭后按缓存续读 |
| `browser_read_text` | `mode`, `selector`, `offset=0`, `max_chars=20000` | 主 frame 的 DOM、字段值或支持的编辑器模型 |

### 输入

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_click` | `ref` / `selector` / `x`+`y`、`coordinate_space`、`button`、`click_count`、`modifiers`、`mode`、`timeout_ms` | 原生可信点击或显式 DOM 点击 |
| `browser_hover` | `ref` / `selector` / `x`+`y`, `coordinate_space`, `timeout_ms` | 只移动并保留原生指针，核验可信 mousemove |
| `browser_drag` | `source`, `destination`, `mode=pointer`, `steps=20`, `timeout_ms` | 原生指针或 HTML5 拖拽，目的节点自动滚入视口 |
| `browser_select_option` | `ref` / `selector`，`label` / `value` / `index` 三选一 | 设置一个 HTML select 选项，明确事件非可信 |
| `browser_type` | `ref` / `selector`, `text`, `delay_ms=0`, `timeout_ms` | 保留现有文本与选区，逐字符可信按键输入 |
| `browser_fill` | `ref` / `selector`, `text`, `mode`, `timeout_ms` | 文本 / textarea / contenteditable，写入后核验文本 |
| `browser_press_key` | `key`, `timeout_ms` | 单键或组合键，核验可信 keydown 送达 |
| `browser_batch` | `steps`, `timeout_ms=15000` | 单队列内顺序执行 1–20 步 click/fill/type/press_key/hover/scroll/select_option/wait，失败即停并返回部分结果 |
| `browser_scroll` | 可选目标、`delta_y`、`until.text`、`max_steps` | 容器/坐标滚动；有界查找文本并返回新 ref |

### 页面、文件与诊断

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_navigate` | `url` / `direction=back/forward`, `wait_until=domcontentloaded`, `timeout_ms=15000`, `include_snapshot=true` | 等待并返回新文档标题、URL、快照 |
| `browser_handle_dialog` | `accept`, `prompt_text` | alert / confirm / prompt |
| `browser_upload_file` | `files`, `ref`（可省略） | 原生 file input、隐藏 input 或已拦截的选择器 |
| `browser_screenshot` | `full_page=false`, `include_indicators=false` | viewport/full_page/元素 PNG + 坐标映射 |
| `browser_evaluate` | `expression`, `timeout_ms=10000`, `max_chars=20000` | 表达式/函数求值，等待 Promise；可选元素 ref |
| `browser_logs` | 必填 `kind=console/network`, `after_seq`, `limit`, `max_chars`, `level` / `url_contains` | 统一读取日志；network 可显式 capture 有界脱敏的 XHR/fetch 详情 |

普通结果是一份紧凑 JSON 文本；截图另外返回标准图片内容。失败通过 MCP `isError` 返回，错误文本即原因。

## 读取一个 URL

先用 `browser_discover(kind="browsers")` 选择配置，再调用：

```js
browser_fetch({browser_id, url: "https://example.com/article", wait_until: "network_idle", format: "text", max_chars: 20000})
// → {url, title?, status, ok, body, ready_state, wait_satisfied, degraded, degraded_reason, document_changed, ...}
browser_fetch({browser_id, cursor: next_cursor, max_chars: 20000})
```

`browser_fetch` 在选定配置中新建 `active=false` 的临时标签，复用该配置的登录态和导航链路，采集后关闭；不需要对临时页显式 discover/claim。它不操作已有标签，不创建浏览器或窗口，不跟随页面链接。后台标签会短暂出现在标签栏，不能保证浏览器完全不可见。网页脚本、子资源、重定向仍照常执行，打开 URL 也可能产生网站状态变化；“读一页”指工具范围，不代表 HTTP 请求无副作用。

- `wait_until` 支持 `commit`、`domcontentloaded`、`load`（默认）、`network_idle`。最后一种在 load 后等待被动请求表连续 500 ms 无活动请求；长连接可能使网络无法空闲。`commit` 只表示文档提交，正文可能仍为空，不保证应用完成加载。
- `timeout_ms` 为 100–30000，默认 15000，涵盖临时标签创建、调试初始化、等待、采集和关闭。总预算内预留采集与清理时间，所以等待阶段可能早于总 deadline 结束。等待超时时，只要仍有可读的 HTTP(S) 文档且控制权未变化，就读取当前内容；不重发导航。浏览器不响应或尚无 HTTP(S) 文档时仍可报错；无法保证任意登录应用在期限内提供有效业务正文。
- 返回 `ready_state`（`loading` / `interactive` / `complete`）、`wait_until`、`wait_satisfied`、`degraded` 和 `degraded_reason`。`wait_satisfied` 表示本次等待条件已对采集的文档满足，不等于应用内容完整。未满足时 `degraded=true`，原因可能为 `wait_timeout`、`document_changed` 或 `navigation_interrupted`；正常为 `degraded=false`、原因 `null`。即使 `ready_state=complete`，network_idle 仍可能未满足。
- 客户端 `location.replace` 等换文档会在同一次导航的等待期间跟随当前主文档 loader；采集期间上下文失效或文档变化，最多只读重采 3 次，共用原预算。不会为了重试而重新 navigate。控制权、连接变化始终失败；文档持续变化或重采超时也明确报错，不混用旧状态码和新正文。`document_changed` 表示相对本次首次提交的 HTTP(S) 主文档，是否观察到后续主文档替换；初始 about:blank 和同文档 URL 路由变化不计入。不会预知采集结束之后的未来跳转。
- 只读当前主文档。`text` 使用 `body.innerText`；`html` 返回当前 DOM `outerHTML`，同时标记 `dom: "rendered"`，包含页面脚本及浏览器扩展对 DOM 的修改，不能用作服务器原始响应或字节存档；不删除或猜测注入来源。`json` 从浏览器呈现的正文解析、校验后序列化。不另发 fetch/XHR，不返回原始响应体或响应头。`contentType` 来自 `document.contentType`，`url` 为最终采集地址；没有文档标题时省略 `title`。非 HTTP(S) 最终文档报错。
- `status` 来自已有 CDP 网络观察，按采集主文档的 frame 与 loader 匹配最终响应，排除重定向中间响应、子框架和 XHR/fetch。`ok` 仅表示 HTTP 200–299；未观察到匹配状态时两者均为 `null`，不猜成 200。404/500 仍返回正文及 `ok:false`，不因此设置 MCP `isError`。返回 200 的登录墙、验证码页或软错误仍为 `ok:true`，它不代表内容有效、已授权或业务成功。缓存/service worker 响应使用浏览器所报告的文档响应状态，不保证等于服务器本次实际传输的状态行。
- `body_source=rendered_document` 表示正文来自当前文档。空体 HTTP 错误若使浏览器报告 `ERR_HTTP_RESPONSE_CODE_FAILURE`，会保留已观察到的状态码和原 URL；确认 `Content-Length: 0` 时返回 `body:""`、`body_source=http_response`。如果响应正文无法取得且不能证明为空，返回 `body_source=unavailable` 和 `body_unavailable=true`，不能把它当成空响应。两者均标记 `degraded_reason=http_error_response`、`ready_state=null`，并附带 `navigation_error`；浏览器生成的错误页不冒充服务器正文。DNS/TLS 等未取得 HTTP 响应的错误仍失败。JSON 模式维持有效 JSON 约定，无可解析 JSON 文档时明确报错。
- `body` 始终为字符串。文本/HTML 按 `max_chars` 分页，范围 1–100000、默认 20000，按 JavaScript 字符串长度计算。JSON 忽略分页预算，在 1000000 字符采集上限内整份返回，可直接 `JSON.parse(body)`；`truncated=false`、`next_cursor=null`，不会返回半截 JSON。JSON 超出采集上限或解析失败时直接报错。
- 文本/HTML 一次最多采集 1000000 字符。`next_cursor` 非空表示缓存尚有后续片段；`truncated` 表示尚未返回全部内容或采集有损。`capture_truncated=true` 表示超出采集上限，丢失的尾部不能通过 cursor 取回。
- 每个连接、每个浏览器配置最多保留 4 份尚未读完的不可变采集（每份最多 1000000 字符），可交叉续读；第 5 份需要续读的采集会淘汰最久未读取的一份。一次读完或失败的请求不占缓存槽、不淘汰已有采集。相同 URL 的多次采集各自独立，不按 URL 合并，cursor 自身定位对应采集，无需 fetch_id。读完或断连清除；过期/淘汰的 cursor 明确报错，不重新访问 URL。
- 续读只接受 `browser_id`、`cursor` 和可选 `max_chars`，只读缓存，不打开页面。缓存不因临时页关闭而失效，也不能跨连接读取。
- 采集完成、无法降级的错误或断连都会清理临时页，不自动重新导航。标签创建超时后的迟到结果只用于关闭，不能继续导航；关闭等待受原 deadline 限制，底层关闭回执迟到时仍会清理状态。关闭失败会明确报错并保留清理责任，在断连时再次尝试关闭；不会静默移交给其他连接。临时页不出现在 `discover(kind="tabs")` 的结果中。

## 观察：快照与引用

`browser_snapshot` 返回 `snapshot` 文本（每行 `[token:n] role "name" 状态`）、`snapshot_id`、`node_count`、`total_node_count`、`truncated`、`truncation_reason`（`node_limit` / `text_budget`）、`next_cursor`、`viewport`、`omitted_frames`，以及当前 `title` / `url`。

- 渲染时移除 `InlineTextBox`，合并纯文本列表项与段落名称，保留 `disabled`、`focused`、`expanded`、`checked`、`selected`、`required`、`invalid`、`level` 等状态，以及浏览器提供的 `value`；`[token:n]` 即后续动作使用的 `ref`。未提供 invalid/selected 等属性不代表有效或已提交；value 也可能只是下拉框的过滤文本。
- `max_nodes` 为 1–3000（默认 600）；`max_chars` 为 1–2000000（默认 24000），按行序列化长度累计，与节点数是两个独立预算。
- `profile` 默认为 `full`。`interactive` 保留 AX 控件角色、可聚焦/可编辑节点及其祖先链和控件内的文本，略去无关正文；禁用控件仍保留。仅按是否有 ref 筛选无法有效压缩，因为段落、列表项等也可能有 ref。自定义控件未提供可访问角色或可聚焦/可编辑属性时可能被省略，需用 `full` 观察。
- `text` 默认 `true`；`false` 隐去独立文本和纯文本段落/列表项的合并正文，仍保留可访问名称及控件值。`text_limit` 为 0–10000，限制每个文本/合并正文名称并以 `…` 标明省略；`interactive` 默认 80，`full` 默认不截断。需要更多正文时重新请求 `full`，或显式提高 `text_limit`。控件名称、值及 ref 校验所用身份始终完整。
- 返回 `profile` / `text` / `text_limit` 表明本次视图；`node_count` 和 `total_node_count` 统计筛选后的节点。`truncated` / `next_cursor` 只表示该视图尚有分页，不表示视图包含全部网页正文。筛选发生在完整 AX 树读取后，减少返回内容与分页次数，不减少 CDP 的 AX 树采集量。
- `truncated: true` 时把 `next_cursor` 传回同一个工具继续读取同一份观察，refs 在续读期间保持有效；也可以调整预算。单个超长节点放不下时会明确报出所需预算，不静默丢尾部。
- 续读可省略视图参数，沿用原 `profile` / `text` / `text_limit`；显式提供时必须与原观察相同。调整视图须请求新快照，并按下表使旧 ref 失效。
- 覆盖主 frame、同进程 iframe 与递归 OOPIF；读取失败、读取期间变化或附着失败的 frame 列入 `omitted_frames`。

失效规则：

| 事件 | 影响 |
|---|---|
| 输入 / `evaluate`（新表达式） | 快照 cursor 失效；原节点 refs 可继续解析；`evaluate` 的缓存续读不失效 |
| 新的 `browser_snapshot` | 旧 refs 失效 |
| 主文档导航、同文档导航、文档更新 | 全部 refs 与 cursor 失效 |
| 子 frame 导航或移除 | 仅该子树 refs 失效，其余保留 |
| `tab_control(action="release")` / `tab_control(action="close")` / 断连 | 全部失效 |

ref 每次用 frame/session + backendNodeId 重新解析，并以局部 AX 查询核对原 role/name；语义改变时要求新快照，不依赖旧坐标，也不以相似名称查找替代。节点脱离文档时失败；重新插入的同一节点可继续使用。

`browser_read_text` 默认读取主 frame，`max_chars` 为 1–100000（默认 20000）。`mode=visible` 使用 innerText；`text_content` 使用 textContent；`value` 要求用 selector 唯一选中 input、textarea 或 contenteditable；`editor` 要求 selector 对应支持的 Monaco 或 CodeMirror 5 实例并读取完整模型。Monaco 必须在页面暴露 `monaco.editor.getEditors()`，CodeMirror 5 必须在选中节点暴露实例。未知编辑器明确报错，使用站点专用 evaluate 适配；不猜测模块内部状态。

整页摘要/检索直接调用 `browser_read_text({tab_handle})`，不传 selector 即是 document.body.innerText；正文可用 next_offset 分段续读。可见正文包含页面当前渲染文本，不包含未加载的虚拟行、默认模式下的子 frame 或所有 Shadow DOM 内容，所以 complete_source=false 是覆盖边界，不代表分页丢失。

返回 `source`、`complete_source`、`total_chars`、`returned_chars`、`truncated`、`next_offset`。DOM 和 contenteditable 无法保证包含虚拟化内容，`complete_source=false`；字段 value / 支持的模型为 true。`next_offset` 用于下一次实时读取，内容变化可能导致重复或遗漏；需要一致结果时用 evaluate 一次提取并续读缓存。

### 可复用的 frame 寻址

除 frame_id 外，selector、read_text 和 evaluate 可传 frame；二者互斥。URL/title 精确匹配子 frame，多个匹配立即报错。path 是逐层 CSS iframe 选择器，每层须唯一；每次调用重解析，frame 被重新创建后仍可使用同一路径。未出现的 frame 只在准备预算内等待，歧义不重试。

```json
{"tab_handle":"...","selector":"input","frame":{"path":["iframe[title='Outer']","iframe[title='Inner']"]},"text":"填写内容"}
```

也可传 `frame: {url:'https://example.com/form'}` 或 `frame: {title:'表单页面'}`；path 可再与 URL/title 组合校验最终 frame。ref 自带 frame/session，不能另传 frame。路径 CSS 不穿透 Shadow DOM；可操作 AX ref 和拦截的 file chooser 仍覆盖闭合 Shadow DOM。

## 输入：可操作性与两种模式

`click`、`fill`、`press_key` 共用一套等待逻辑：可见、启用、非 `inert`、几何位置连续稳定；`fill` 还要求可编辑且非只读，`press_key` 会从当前焦点逐层进入 OOPIF 找到接收方。`timeout_ms` 默认 5000、范围 100–30000，**一个截止时间**覆盖准备、派发与校验；准备阶段只轮询、不派发，派发只发生一次。原生 click/hover/press_key 派发与可信回执最多另等 1250 ms，清理最多 250 ms；这属于送达上限，长 timeout_ms 仍可用于等待目标出现。

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

原生 click 在准备前、派发前分别检查顶层 tab 的 active/discarded/frozen、窗口是否最小化，并读取 `document.visibilityState` 和 `document.hasFocus()`；每次检查最多 500 ms，且受总输入截止时间限制。未选中的标签、暂停的页面或最小化窗口快速返回 `TAB_NOT_READY` 和 `No input was dispatched`，不自动调用 bringToFront。可显式调用 `browser_tab_control(action="activate")`（默认 focus_window=true），重新 snapshot 后再 click。

成功结果的 `page_state` 包含 visibility_state、has_focus、window_focused。这些信号仅作诊断：活动标签所在窗口即使未处于 OS 前台，或者因遮挡报告 hidden，仍可尝试一次原生点击，并验证可信事件送达。不能据此保证任意后台页面都能交互；没有可信回执时仍报告未知结果，不重放、不自动切换 DOM 模式。

原生 ref/selector 点击已自动滚入视口；viewport 坐标保留严格视口边界。document 坐标针对顶层文档，嵌套滚动容器和动态布局优先用 selector/ref。`hit_target` 返回实际命中的 tag、最多 300 字符 text、role、disabled、clickable_hint，并由 clickable_target 给出最近的可点击候选祖先（含自身）的 tag/role/text。查找跨越 Shadow host 和 slot，例如 span 在 button 内时保留 tag=span，同时返回 clickable_hint=true、clickable_target.tag=button；disabled 同时观察祖先的禁用/inert/aria-disabled 状态。

hint 仅为 HTML/ARIA 启发式判断，false 表示未找到候选，不能证明元素不可点击，也不能覆盖所有事件代理。它不会替换真正的鼠标命中节点或改变派发目标。坐标点击无法推断调用者的业务意图，DOM/网络变化也不能证明业务成功，需按具体任务观察。

`selector` 可复用，但不是永久元素身份。输入准备阶段会等待匹配出现，受同一 timeout_ms 限制；省略 nth 时多个匹配立即报错，附带前 10 个候选的 nth、tag、最多 120 字符的 DOM 文本、disabled 和 visible，超出部分标明省略数量。显式 nth 按当前文档顺序选择，尚未出现该索引时等待；行顺序变化后须重新确认目标。解析后元素被替换会安全失败，不自动重放。CSS/XPath 不穿透 Shadow DOM，那里继续使用 AX ref；iframe 用明确 `frame_id`。例如 `browser_fill({tab_handle, selector:'input[placeholder="公司名称"]', nth:1, text:"第二段经历", mode:"native"})`；XPath 同样支持 nth。

坐标命中 CSS 伪元素时，以其 originating element 做描述和事件校验，`hit_target.pseudo_element=true`。截图坐标仍按截图元数据换算；优先用 ref/selector 避免布局漂移。

`mode: "dom"` 只对 HTML 元素调用一次 `HTMLElement.click()`，返回 `method: "dom"`、`events_trusted: false`：没有 pointer 事件、没有用户激活，也不支持修饰键或坐标。自绘控件、拖拽、依赖 pointerdown 的功能仍需原生输入。两种模式都不会自动互相降级。

跨进程 iframe 会逐层检查父页面遮挡并换算坐标，最终从顶层派发；返回的 `clicked` 始终是顶层视口 CSS 坐标。透视变换的 iframe 会被明确拒绝。

### browser_hover / browser_drag

hover 接受与原生 click 相同的目标，执行一次 mouseMoved，不派发 down/up/click。工具清理不移动指针；后续直接 click 子项，不需要先移回父菜单。输入不移动系统鼠标，也不隐式激活标签。

```json
{"tab_handle":"...","selector":"#menu"}
```

随后调用 `browser_click({tab_handle, selector:'#menu .child'})`。需要等待菜单出现时可组合 browser_wait。

drag 的 source / destination 各自接受 ref、严格 selector（可带 frame_id/nth）或 x/y（可带 coordinate_space）。mode 必须按页面交互选择，默认 pointer；steps 默认 20，范围 2–100，每步间隔约 16 ms。

两端均为 document 坐标且能同时容纳于一个顶层视口时，在按下前统一滚动位置，保留两端的 x/y 差值。已在视口内的 document 坐标不重复居中；需要滚动时只调整越界的轴。跨屏目标仍在按住后滚入视口，因此返回的 from/to 是各自派发时的视口坐标，不能用两者之差推断跨屏的文档距离。

```json
{"tab_handle":"...","source":{"selector":"#card"},"destination":{"selector":"#column"},"mode":"html5","steps":20}
```

pointer 发送 mousePressed → 多步 mouseMoved → mouseReleased，核验可信 pointerdown/pointermove/pointerup，因此控件取消 pointerdown 的默认行为、抑制兼容鼠标事件时仍可校验送达；HTML5 模式先通过真实按下/移动触发 dragstart 并截获其 DragData，再派发 dragEnter/dragOver/drop，核验可信 dragstart/drop/dragend。不会凭空构造拖拽数据，不自动切换模式。目的元素在按住后调用已有滚入视口逻辑，包含嵌套容器，然后重新命中检查；这是目标驱动的滚动，不是持续的视口边缘滚动任务。固定坐标始终受视口边界约束，视口外坐标用 document 或改用元素目标。

成功返回 events_trusted=true、delivery_verified=true、application_result=not_checked；不保证应用已保存排序。任一步失败、主文档/相关 frame 变化或接管结束即停止，尝试取消/释放本次手势；不回滚、不重放。HTML5 CDP 路径仍受浏览器和站点原生拖拽支持限制。

### browser_select_option

ref/selector 必须指向 HTML select。label/value 为精确匹配，index 从 0 开始，三者只传一个；重复 label/value 报错，使用明确 index 消歧。禁用 select/option/optgroup 被拒绝。设置一个选项；multiple 控件也只保留这个选项。

```json
{"tab_handle":"...","selector":"select[name=city]","label":"上海"}
```

不打开系统弹层、不主动聚焦，使用原型 selectedIndex setter 后派发合成 input/change，并核对选项身份及最终索引。返回 method=dom、events_trusted=false、value_verified=true，不能满足网站的 isTrusted/用户激活要求。native click 命中 select、其 UA shadow 节点或关联 label 时在派发前提示使用 select_option。系统弹层已经打开时按 Esc 关闭；工具不接管操作系统 UI。

### browser_wait

condition 支持 attached（出现）、visible（非隐藏且有尺寸）、actionable（可见/启用/非 inert/稳定/命中无阻挡）、text（textContent 含 expected，或与 previous 不同）、url（主 frame URL 含 expected）、network_idle。元素条件使用严格 selector，可带 selector_type/frame_id/nth；歧义立即报错。visible 不要求启用；actionable 不自动滚动，元素须在视口内，并复用 native click 的 frame/祖先遮挡检查。

```json
{"tab_handle":"...","selector":"#toast","condition":"text","expected":"保存成功","timeout_ms":5000}
```

url 需要 expected 子串；text 传 expected 子串，或传 previous 等待任意文本变化，两者只选一个。previous 必须是完整的旧 textContent，可先用 read_text 的 text_content 模式或 evaluate 读取。SPA 可组合 url 与目标元素条件。工具只读轮询，timeout_ms 为 100–30000；失败说明所等条件与最后观察状态：

- `Wait for attached selector="#missing" ... current={"satisfied":false,"state":"absent"}`
- `Wait for visible selector="#hidden" ... current={"ready":false,"reason":"hidden or zero size","satisfied":false}`
- `Wait for actionable selector="#disabled" ... current={"ready":false,"reason":"disabled","satisfied":false}`

network_idle 复用 claim 后的被动网络请求表，等待 inflight=0 且连续 idle_ms（默认 500，范围 100–10000）无请求活动，涵盖已接管页面与 iframe。它不能证明 claim 前的请求、独立 worker 或 WebSocket 消息空闲；长轮询请求会阻止满足条件。活跃表曾超过 500 项时 tracking_overflow=true，无法证明空闲而不会报告成功。页面通常仍需等待业务元素或标志。

### browser_fill

支持文本类 `input`（text / search / email / password / tel / url）、`textarea` 与 `contenteditable`；传当前 ref 或严格 selector。

- `native`（默认）：聚焦、选中后发送原生 `insertText`。
- `dom`：用原型上的原生 value setter（contenteditable 用 `textContent`）写入，派发非可信 `input` / `change`，不主动聚焦；可通知 React/Vue 受控字段，不能保证所有自定义编辑器的内部状态。
- 两种模式都核对字段最终文本，成功返回 `value_verified: true`、`application_result: "not_checked"`；被吞、失焦或页面同步格式化导致不匹配时报错，且不回显字段内容。这不证明框架状态、选项提交、后续重渲染保留或业务保存。
- 不会自动 blur 或按 Enter。需要失焦校验时显式 press_key Tab 或点击其他明确目标；自定义年/月/城市选择器输入通常只是过滤，还需点击具体选项。Enter 的语义由站点决定。校验文案可能滞后，应同时观察选中项和字段值；添加行前先确认已提交选项，不能只看输入框里的文本。

### browser_type

fill 是替换文本，原生路径用 insertText，不制造逐字 keydown。自动补全/搜索框监听按键时用 type：只聚焦，不清空、不全选，在当前选区逐个 Unicode 字符派发原生 keyDown（含文本）/keyUp，由浏览器产生 keypress/input。页面 preventDefault 可阻止后续默认输入；不会为补事件再调用 insertText。ASCII 使用 US 键位，非 ASCII 的 code 为空，不模拟系统 IME 组合输入。

```json
{"tab_handle":"...","selector":"input[role=combobox]","text":"上海","delay_ms":50}
```

delay_ms 为 0–1000，是字符之间的最小额外间隔，准备与协议开销会增加实际耗时；整串 text 最多 10000 个 UTF-16 单位，仍受同一 30 秒以内的总预算约束。换行/Tab/控制字符用显式 press_key。检查原字段连接与焦点，观察到失焦或替换后停止；失败报告已核验字符数，当前字符仍可能已送达，不能重放整串。delivery_verified 证明 keydown，不证明站点接受文本或保存。

### browser_batch

同一 tab_handle 内一次传入 1–20 个明确步骤，action 支持 click/fill/type/press_key/hover/scroll/select_option/wait；元素动作必须使用 selector，可带 selector_type、frame_id、nth 和 mode（默认 native）。click 还支持 button/click_count/modifiers。batch 只接受 selector，不接受 refs 或坐标；每步重新查询目标。

```json
{"tab_handle":"...","steps":[
  {"action":"fill","selector":"input[placeholder=公司名称]","nth":1,"text":"公司名称"},
  {"action":"press_key","key":"Tab"}
]}
```

timeout_ms 默认 15000，范围 100–30000，是整批准备、派发和校验的总预算。每步可设 timeout_ms（100–30000），它与剩余总预算取更早的截止时间，失败后不会继续下一步。所有参数先预检，每一步复用原有输入流程，尚未渲染的选项可在准备阶段等待；不会自动猜选项或增加交互。步骤间不插入其他同标签命令。成功返回 completed=true、results；首个失败返回 MCP isError=true 以及 completed=false、results（此前完成结果）、failed_step（从 0 开始）、error。发生主文档变化、断开接管或弹窗也会停止。整批不具备事务或回滚语义，不要重放已完成步骤；失败步骤可能已产生副作用，先观察。

失败还返回 started_at、next_unattempted_step（无后续步骤时为 null）、retry_failed_step_safe。start_at 是显式的从 0 开始的续跑索引：重新提交同一 steps 并选择要执行的索引，前面的步骤只做参数验证，不再派发。未派发/只读等待失败可报告 retry_failed_step_safe=true；已派发或无法确认时为 false。先观察失败步骤是否生效，再决定重试该步还是跳到 next_unattempted_step；工具不自动选择、重试、回滚或保存后台任务。整批/每步均可指定 dialog_policy；各步骤返回自己的 dialogs，整批返回汇总。

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

容器目标可传 ref/selector 与 frame；DOM 模式直接对这个容器 scrollBy，wheel 模式复用命中与 frame 换算后派发原生 wheel。无目标时保留原来的坐标/视口中心行为。

虚拟列表无需 evaluate 计算坐标，可在同一个标签队列和总预算内滚动查找，并返回找到元素的 ref：

```json
{"tab_handle":"...","selector":"#list","until":{"text":"Row 0487","selector":"button"},"delta_y":200,"max_steps":100,"timeout_ms":15000}
```

until 是显式 DOM 滚动搜索，不与 wheel 组合；省略 delta_y 时每次滚约 0.8 个容器高度。max_steps 默认 100、范围 1–500，只计算实际 scrollBy 次数。搜索容器内渲染且有尺寸的最深匹配元素，文本为子串；重复匹配报错，使用 until.selector 消歧。滚动无位移时继续只读查找并观察容器位置、内容尺寸与视口尺寸，状态变化后才继续滚动；边界本身不证明内容已加载完毕。导航、相关 frame 变化、步数用尽或总预算超时即停止，不自动点击；返回 found/ref/frame_id/scroll_steps。未找到只表示本次有界搜索未命中，内容仍可能稍后加载。滚动本身会改变页面状态，即使未找到也可能已触发加载。它不承诺读到服务端未提供的数据，也不把虚拟列表未渲染行当作已存在。batch 的 scroll 步骤使用同一实现。

### 结果未知时

不确定的输入/求值/导航错误会附带一次有界 Post-action observation：dialog/dialogs、navigation_observed、frame_navigation_observed、current_url、frame_id、dom_changed。DOM 信号由操作前在目标 frame 安装的临时 MutationObserver 提供，读取最多 300 ms、清理最多 100 ms；不读取整棵快照或重放动作。节点属性值、服务端状态及其他 frame 的变化未必触发该 DOM 信号。

观察到对话框、导航或 DOM 变动可报告 observable_effects；no_effect_confirmed 仅表示未确认效果，不表示未送达或未发生。delivery 仍为 unknown，业务成功仍需任务自己的标志或网络证据。确定的准备失败则保留“未派发”。

派发之后的超时会释放工具队列，但动作可能已经送达或稍后生效。此时先观察页面（快照、截图、日志），不要自动重放，也不要为了补一次而切换模式。

`TAB_NOT_READY` 是明确的派发前失败，可以在激活、重新观察后再点击；它不属于“结果未知”。即使前置检查通过，用户仍可能在派发瞬间切换标签，浏览器菜单也可能捕获输入。派发后没有回执仍须报告 Outcome is unknown，不能仅凭 visibility/focus 或“没有观察到变化”宣称零效果。

## 导航、对话框与截图

`browser_navigate` 传 url 或 direction=back/forward，二者只选一个；URL 和历史目的地都必须是不带凭据的 HTTP(S) 页面。历史使用 Page.navigateToHistoryEntry，并等待对应主 frame 的提交/生命周期；同文档历史和 BFCache 恢复无需等待新的 DOMContentLoaded。无历史条目时在派发前失败。

| 参数 | 默认 | 范围 / 说明 |
|---|---|---|
| `wait_until` | `domcontentloaded` | `commit` 只等提交，`load` 等 load 事件；同文档 hash 导航不等待新的加载 |
| `timeout_ms` | 15000 | 100–40000 |
| `include_snapshot` | `true` | 关闭时只返回标题与 URL |

导航成功后另有一次 10000 ms 的观察预算；观察失败会返回导航结果加 `observation_error`、`observe_again`，不会把已成功的导航报告为失败。Hub 侧操作上限 60 秒、客户端 65 秒，覆盖最长导航加观察并保留传输余量。超时不代表导航已取消，SPA 在 `DOMContentLoaded` 之后仍可能异步更新。

观察遇到文档变化、执行上下文销毁等瞬时错误时，内部只重读一次，共享同一 10 秒预算；不会重新导航。权限错误和预算耗尽不重试。

输入、evaluate、navigate、wait 与 batch 可指定 dialog_policy=ask/accept/dismiss，默认 ask。accept/dismiss 在操作期间自动调用已有 JS 对话框接口，返回 dialogs 中的原消息、类型、accepted、handled；prompt 自动 accept 使用原默认文本。每个操作最多自动处理 10 个对话框，之后回到等待人工处理，不自动无限确认。它只覆盖页面 JS 对话框，不接管系统权限/文件 UI。

batch 遇到已自动处理的 alert/confirm 可以继续下一步；默认 ask 仍会停止。beforeunload=accept 继续等待导航，dismiss 返回 navigated=false、cancelled_by_dialog=true；浏览器若未弹出 beforeunload，工具不能强制它出现。主文档实际变化后 batch 仍按原规则停止，避免在新文档执行后续步骤。

页面弹出未自动处理的 JavaScript 对话框时，`browser_snapshot` 会返回 `dialog` 对象，其他动作（除 `tab_control(action="release")`）被拒绝；用 `browser_handle_dialog` 接受或取消，`prompt_text` 只在 prompt 时使用。对话框打开期间仍可读取控制台和网络日志。

handle_dialog 返回原始 `dialog.type/message/default_prompt` 和 `accepted`。`default_button=null`，协议不提供浏览器默认按钮焦点。beforeunload 只有实际弹出时才能观察，浏览器可能因缺少用户激活而抑制它。DOM 值写入不证明应用已保存或 dirty=false；不存在跨框架可靠的通用 dirty 检测，导航前按任务检查保存标志或业务接口。

`browser_screenshot` 返回 PNG 与 `capture` 元数据：`scope`（`viewport` / `full_page`）、`viewport`、`css_width`、`css_height`、`image_origin_css`、`image_to_viewport_css`。像素到视口坐标的换算为 `css = 像素 × scale + offset`。超时为 5 秒；被遮挡或非活动的 Chromium 页面可能暂停渲染，此时先 `browser_tab_control(action="activate")`，或改用 AX / 正文。整页截图超过 4000 万像素会被拒绝；整页图中的视口外位置需要先滚动。

元素截图传 ref 或严格 selector（可用 frame），与 full_page 互斥。截取当前渲染 border box 的外接矩形，不要求元素启用、不移动焦点；OOPIF 坐标逐层换算，保留页面遮挡，截图不是元素抠图。无渲染 box、负文档坐标、透视 frame 或超过 4000 万像素时报错。capture.scope=element，image_origin_css 是该元素的真实文档位置，沿用已有像素到视口换算。可分别请求元素和 full_page 获取视觉证据，不增加另一个截图/图片比较工具。

默认截图隐藏约 1.2 秒的原生点击反馈；`include_indicators: true` 可保留。截图本身不会激活标签或窗口。

## 文件上传

方式一，使用文件 input / 关联 label 的 ref 或严格 selector（可带 frame）；files 数组已支持多文件，files: [] 清空：

```json
{"tab_handle":"...","ref":"<最新快照中的文件输入框 ref>","files":["C:/Users/example/Documents/report.pdf"]}
```

开放 Shadow DOM 可用 evaluate 显式返回元素 ref，闭合 Shadow DOM 中隐藏且没有 AX ref 的文件 input 优先通过真实上传按钮触发已拦截的 chooser；不用穿透 CSS 或开启系统文件框。清空派发合成 input/change，返回 events_trusted=false；非空 DOM.setFileInputFiles 的事件为原生，返回 events_trusted=true。这些字段不证明服务端已上传。

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

`expression` 最多 100000 字符，需要多条语句时使用 `(() => { ...; return result; })()`，异步使用 `(async () => { ... })()` 或直接返回 Promise。表达式默认在主 frame 的页面世界执行一次，可用 frame_id/frame 指定子 frame，可访问页面变量、DOM 和当前登录态，可产生写操作，但不授予用户激活；返回函数时自动调用一次并等待其 Promise；不会递归调用函数返回的另一个函数。

- `timeout_ms` 默认 10000、范围 100–30000；CDP 同步执行时间与 Promise 等待共用该预算。超时会释放工具队列，但不保证取消已调度的异步代码或网络请求。
- `max_chars` 默认 20000、范围 1–100000，限制每页 value 的 JSON 字符预算（不含元数据）。
- 每个被控标签最多缓存一份结果，捕获预算为 1000000 个 JSON 字符、50000 个节点、8 层；只读取自有可枚举数据属性，不调用 getter，数组按索引读取。捕获损失由 `capture_truncated` 标记；转义后超出捕获上限时返回结构化 `$type=truncated` 标记，不返回半截 JSON。
- 数组按完整项、对象按完整键值对、字符串按片段分页，返回 `result_kind`、`has_more`、`next_cursor`。下一页只传 `cursor`，不能再传 expression；续读只读缓存，不执行页面脚本，也不使当前 AX refs 失效。输入不改变已捕获结果；新求值、主文档导航/更新、释放或断连清空缓存。
- 单项放不下时返回 `budget_too_small`、`required_chars`、`next_cursor`，可提高预算续读，不必重新执行。单个嵌套值超过 100000 字符时应在表达式中提取更小的字段；分页不递归拆解嵌套对象。
- 特殊值用 `$type` 标记：`undefined`、`bigint`、`number`（NaN / Infinity / -0）、`date`、`error`、`function`、`symbol`、`accessor`、`circular_or_repeated`、`truncated`。Map、Set、DOM 等实例只遍历可枚举属性，需要稳定结果时返回普通对象或字符串。
- 执行新表达式后快照分页失效；仍连接的原节点 refs 可复用，文档/frame 变化仍使相关 refs 失效；报错或超时前可能已修改页面，先观察，不要自动重放。

需要可操作元素时显式指定 result_type=element：

```json
{"tab_handle":"...","expression":"() => document.querySelector('#target')","result_type":"element"}
```

只接受所选 frame 的单个、仍连接的 DOM Element，不接受数组/JSON/null/Document，也不跨 frame 隐式猜测归属。返回 ref/frame_id/AX role/name，后续复用现有输入和上传工具；其文档/frame/session/语义失效规则与快照 refs 一致。每份当前观察最多追加 500 个元素 refs，新快照清空。原始 Runtime objectId 不暴露给客户端，生成 ref 后立即释放包装对象。result_type=json 为默认，分页只续读缓存，不执行函数；element 结果没有 JSON cursor。子 frame 求值的缓存也在该 frame 导航/移除时失效。

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
- 默认不保存 headers/正文。需要校验 XHR/fetch 时先调用 logs(kind=network, capture={enabled:true,max_body_bytes:65536})，再触发请求；随后读取 request/response/body 事件中的 method/status、headers、request_body/response_body。正文对象包含 text/format/bytes/truncated。url_contains 只过滤读取，不限制 capture 范围。capture.enabled=false 关闭后续捕获；之前的有界记录留到正常淘汰或 release，不落盘。
- Authorization、Proxy-Authorization、Cookie、Set-Cookie 默认且始终脱敏；JSON/form 的 password/token/authorization/cookie 等命名字段也会替换。普通业务文本仍可能含数据，脱敏不保证清除任意格式的个人信息。单正文上限 1024–262144 字节，默认 65536；浏览器每个 debugger session 总缓存 2 MiB，保留原日志 500 条/1 MiB 上限，最多 8 个并行正文读取。已知解压后超过上限的响应不读取，二进制正文省略；缓存不足、捕获前已发出、跨导航丢失或超过并发限额会明示 unavailable，不能当作空正文。大量正文请调低捕获上限，并在读取时提高 max_chars（最大 100000），否则沿用预算预览而非完整正文。
- 正文捕获不修改缓存策略、service worker 或拦截/重放请求；URL 与控制台内容仍可能包含网站数据。
- 覆盖主 target、同进程 frame 与递归附着的 OOPIF，日志带 `session_id`（主 session 为 null），解析出上下文时带 `frame_id`。独立 worker / service worker 与 WebSocket 消息不在覆盖范围。

## 标签栏控制标记

被控标签会临时进入一个**无标题的红色原生分组**（使用 `tabGroups` 权限），扩展按钮同时显示 `RUN` 徽标。分组不修改网页标题、favicon 或正文，也不注入页面脚本。

- 正常释放、MCP 断连或浏览器停止调试时移除标记并恢复原分组；原分组已因空组消失时按记录重建。
- 用户期间改名、改色或移动标签时保留用户的调整；恢复分组不保证原标签顺序。
- 固定标签不能加入分组，claim 会返回 `visual_warning`，扩展徽标仍可显示；需要分组标记时先取消固定。

## 限制与排查

- 仅支持 Chrome / Edge 的 HTTP(S) 页面；不含 `chrome://`、扩展页与本地文件。最低浏览器版本 125。
- 不支持操作系统原生 UI 接管、下载管理、网络拦截、测试运行器、Firefox / WebKit；独立 worker 与 WebSocket 消息不可见。
- 标签拖动或浏览器原生菜单可能捕获原生输入，CDP 返回成功不等于页面收到事件；结束该交互后再依赖原生输入。不要用 `Input.setIgnoreInputEvents(false)` 强行解除用户的菜单 / 拖动状态。
- 后台操作要求浏览器运行且页面未冻结；网站自己弹窗或权限 UI 仍可能改变焦点。
- `target_verified`、`delivery_verified`、`value_verified` 只证明事件送达或文本写入，不证明提交、付款、服务端上传等业务完成。
- Hub 日志位于配对文件同目录的 `hub.log`；`browser-attach status` 查看连接状态，`browser-attach stop` 停止 Hub。
- 宿主把大结果保存为 Artifact 时，长行可能被宿主截断；这是宿主读取行为，不是快照游标分页。相关说明见 [Agent 集成](AGENT-INTEGRATION.md)。
