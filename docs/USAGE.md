# BrowserAttach 使用指南

**工具与操作流程**

1. `browser_list_browsers` 发现已连接的浏览器配置。
2. `browser_list_tabs(browser_id)` 获取目标标签页的精确身份。
3. `browser_claim_tab(browser_id, tab_id, expected_url, expected_title)` 获得独占 `tab_handle`。
4. `browser_snapshot(tab_handle)` 读取 AX 语义树及元素 `ref`。
5. 使用当前 ref 操作，操作后重新观察。
6. 完成后 `browser_release_tab(tab_handle)`，不关闭用户页面。

| 工具 | 能力 |
|---|---|
| browser_list_browsers | 发现连接的配置实例、版本和能力表 |
| browser_list_tabs | 现有标签页身份与控制状态 |
| browser_open_tab | 打开 HTTP(S) 标签，默认后台打开；加载后 list + claim |
| browser_claim_tab / browser_release_tab | 校验身份、独占接管 / 释放 |
| browser_activate_tab / browser_close_tab | 显式激活已接管标签 / 关闭并作废句柄 |
| browser_snapshot | AX 树、引用、frame 覆盖和待处理文件选择器 |
| browser_read_text | 主页面可见文本 |
| browser_click | 当前 ref 或视口 CSS 坐标点击 |
| browser_fill | 文本 input / textarea / contenteditable |
| browser_press_key | 按键和组合键 |
| browser_scroll | 指定位置的容器 DOM 滚动 |
| browser_navigate | HTTP(S) 导航 |
| browser_handle_dialog | JavaScript alert / confirm / prompt |
| browser_upload_file | 本机文件选择、多个文件及清空 |
| browser_screenshot | 视口 / 整页 PNG 与坐标映射 |
| browser_evaluate | 主页面 JavaScript 表达式及 Promise 求值 |
| browser_console_logs | console、未捕获异常/rejection 与浏览器日志 |
| browser_network_logs | 请求、重定向、响应、完成与失败事件 |

总共 20 个工具，包含显式标签管理、点击验证、快照续读、导航等待及页面调试。普通结果只返回一份紧凑 JSON TextContent；截图另外返回标准 ImageContent。失败使用 MCP `isError`。

`browser_activate_tab(tab_handle, focus_window)` 默认 `focus_window: true`，选中目标标签并聚焦其窗口；传 `false` 只在窗口内选中标签。`claim_tab` 继续返回 `activation_requested: false`，普通点击也不自动切前台。后台或遮挡页面需要前台渲染时，先显式 activate，再重新观察。`browser_open_tab(browser_id, url, active)` 默认 `active: false`，返回新 tab_id；加载后通过 list_tabs 获取精确标题/URL 再 claim。`browser_close_tab(tab_handle)` 关闭已接管的标签，可能丢弃未保存状态；保留页面则使用 release_tab。

**文件上传**

直接使用新快照中文件 input 或其关联 label 的 ref：

```json
{
  "tab_handle": "...",
  "ref": "<最新快照中的文件输入框 ref>",
  "files": ["C:/Users/example/Documents/report.pdf"]
}
```

对于隐藏 input 或自定义上传按钮：

1. `browser_click` 点击“Choose file”之类的按钮。
2. 返回结果或下一次 snapshot 中出现 `file_chooser: { pending: true, ... }`。
3. 调用 `browser_upload_file(tab_handle, files)`，省略 ref，使用被拦截的真实 input。

`files: []` 清空指定 input，或结束待处理的选择；页面会收到 input/change 事件。普通文件使用原生 `DOM.setFileInputFiles`，不把文件内容读取到 MCP 或 Hub，也不弹出系统文件选择框。点击与上传是两个明确的动作；点击按钮不意味着已经上传。

限制和语义：

- 文件必须在浏览器所在本机，传入可读取的绝对路径；最多 100 个路径。
- 支持单文件、多文件、中文/空格路径、空文件，以及原生 input 的 `click()` / `showPicker()` 触发的选择器。
- 多文件要求 input 具有 multiple；禁用字段、失效 ref、目录路径和 webkitdirectory 会明确拒绝。
- `accept` 是网页选择提示，不作文件格式验证；网站仍可自行验证或拒绝。
- ref 在动作、新快照或导航后失效；待处理 chooser 在导航、文档更新、释放和断连后清除。
- 仅针对 HTML file input；File System Access API 的 `window.showOpenFilePicker()`、原生权限弹窗和跨进程 iframe 尚不支持。
- 选择文件可能立即触发网站自动上传，应只传任务指定的文件；选择成功并不证明服务端上传完成，需继续观察页面。

## JavaScript 求值与诊断日志（0.4.0）

接管标签后，可以调用 `browser_evaluate`：

```json
{"tab_handle":"...","expression":"({title: document.title, count: document.querySelectorAll('a').length})"}
```

`expression` 是最多 100000 字符的表达式，需要多条语句时使用 `(() => { ...; return result; })()`；异步使用 `(async () => { ... })()`，也可直接返回 Promise。工具在主 frame 的页面世界执行一次，能够访问页面变量、DOM 和当前登录态，可产生网站操作，不授予用户激活。函数值不会自动调用。执行后必须重新 snapshot 获取 refs；错误前也可能已修改页面，不能自动重放。

`timeout_ms` 默认 10000，范围 100–30000。CDP 限制同步执行时间，扩展另设 Promise 等待截止时间；超时会释放工具队列，但不保证取消已调度的异步代码或网络请求。JS 弹窗会及时返回提示，继续用 snapshot / handle_dialog 处理。随后可以读取已有日志。

`max_chars` 默认 20000，范围 1000–100000，限制结果值的 JSON 字符预算（不包含返回元数据）。普通 JSON 值返回在 `value`。序列化只读取自有可枚举数据属性，不调用 getter；数组按索引读取，稀疏项标为 undefined。最多访问 1000 个节点、8 层，裁剪时 `truncated: true`；转义后的 JSON 仍超限时用 `serialized_preview` 替代 value，preview 不保证是完整 JSON。特殊值使用 `$type` 标记：undefined / bigint / number（NaN、Infinity、-0）/ date / error / function / symbol / accessor / circular_or_repeated。重复引用不会重建对象图；Map、Set、DOM 等实例只遍历可枚举属性，需要明确结果时请返回普通对象或字符串。

读取 `browser_console_logs` 或 `browser_network_logs`：

```json
{"tab_handle":"...","after_seq":0,"limit":100,"max_chars":24000}
```

后续调用把返回的 `next_seq` 作为 `after_seq`；两类日志各自拥有序列，且只能在同一次 claim 内续读。`limit` 范围 1–200；`max_chars` 范围 1000–100000，约束 entries 数组的 JSON 字符数。`has_more` 表示尚有事件可扫描，`latest_seq` 是当前末尾；过滤器跳过的事件也推进游标。修改过滤器后想重新查看旧事件应从 `after_seq: 0` 开始。

- 控制台可选 `level: log | debug | info | warning | error`，收集 console、未捕获异常/rejection、浏览器 Log 消息；对象参数是浅层预览，没有 live handle 或 getter 求值。位置的 line / column 从 0 开始，timestamp 与 capture_started_at 是 Unix 毫秒。
- 网络可选 `url_contains`（最多 2000 字符），事件为 request / redirect / response / finished / failed / cache。按 `request_id` 和重定向 `hop` 关联；404 等 HTTP 错误属于 response，连接失败属于 failed。timestamp 使用 CDP 单调时钟秒，request 的 wall_time 是 Unix 秒。后续响应会追加新事件，因此续读不会漏掉同一请求的状态变化。
- 每次 claim 自动开启 Runtime / Log / Network 观察，过滤启用时重放的历史控制台信息；已经发生的网络请求无法追溯。导航不清空日志，release、detach、关闭或断连会清理；不写入磁盘。
- 每标签每类日志最多 500 条及 1048576 个 JSON 字符，活跃请求关联表最多 500 项。淘汰时 `data_loss: true`、`dropped_through_seq` 标识缺口；超限关联表可能使完成事件缺少 URL/hop，但仍保留 request_id。单条字段有长度上限，裁剪尾部显示 `…[truncated]`；单条放不入读取预算时返回 `truncated: true` 的 serialized_preview 并推进游标。
- 网络不保存 headers、请求体或响应体，也不修改缓存、service worker 或请求拦截；URL 与 console 内容仍可能包含网站数据。网页结果与日志是非可信内容。
- 覆盖当前附着 target 及其同进程 frames，不保证跨进程 iframe、独立 worker/service worker 或 WebSocket 消息覆盖。日志可以在 JS 弹窗打开时读取；读取不会使 refs 失效。

**架构与边界**

```text
MCP 客户端
  → 每连接独立的 Node stdio MCP
  → 127.0.0.1 Hub
  ↔ 配对的 Chrome / Edge MV3 扩展
  → chrome.tabs + chrome.debugger / CDP
```

Hub 按需后台启动，多客户端共用；只监听 loopback，扩展验证固定 Origin、随机密钥和版本；客户端端点要求 Bearer 密钥并拒绝网页 Origin。没有 content script、web-accessible resource 或通用 CDP MCP 工具；页面 JavaScript 通过显式 browser_evaluate 执行。

每个 MCP 连接有独立 owner，tab_handle 不跨连接共享；同一 tab 只允许一个 owner。断连、浏览器重启、用户停止调试均会使句柄失效。动作超时会释放该连接的控制权，结果可能未知，不自动重放。任务结束仍应显式 release，不能假设 MCP 客户端每轮都会关闭连接。

claim 和常规输入不主动激活标签页或浏览器窗口，也不移动系统鼠标；DOM / AX 和常规输入可在后台执行。显式 activate_tab 可以切换标签并聚焦窗口；open_tab 的 active 参数可以选中新标签。网站自己弹出的新窗口及浏览器权限 UI 仍可能改变焦点。控制状态显示在标签栏的红色原生分组中，分组标题为空；页面不再显示常驻“已接管”徽标。原生点击仍保留约 1.2 秒的箭头和光圈，随后移除节点；截图默认隐藏点击提示，`include_indicators: true` 可包含它。

**标签栏控制标识（0.4.0）**

每个被控标签临时进入单独的红色原生分组，标题为空，使用已有 `tabGroups` 扩展权限。分组标记由 [Chrome Tabs / TabGroups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups) 管理，不更改网页标题、favicon 或正文，也不设置页面常驻徽标。

正常释放、MCP 断连或浏览器停止调试时，会移除标记并恢复原分组；原分组已因空组消失时按记录重建。用户期间自行改名、改颜色或移动到其他分组，则保留用户的调整。分组恢复信息保存在浏览器会话存储，扩展重载后会清理上次遗留的标记。临时分组可能调整标签排列，恢复分组不保证精确恢复原标签顺序。

固定标签不能加入原生分组；不会自动取消固定，claim 会返回 `visual_warning`，扩展按钮仍有 `RUN` 状态。需要标签栏分组标记时先取消固定，再接管。浏览器自己的调试提示由浏览器管理。

截图有 5 秒超时：被遮挡或非活动的 Chromium 页面可能停止渲染，可显式调用 activate_tab 后再次观察，或使用 AX / 文本；截图本身不自动切前台。PNG 像素要按返回的 `image_to_viewport_css` 映射到视口 CSS 坐标；整页截图的视口外位置需先滚动。

点击保持原生输入，连续派发 move/down/up 后统一等待确认；ref 会检查可见、启用和遮挡。短暂等待稳定后，即使持续动画仍会使用最新几何位置尝试点击；快速移动造成偏离目标时仍会被命中检查或事件校验拒绝。命中查询换算为文档 CSS 坐标，鼠标输入仍为视口 CSS 坐标。隔离世界中的事件校验会阻止偏离目标的点击；只有收到匹配目标的可信 click 才返回 `target_verified: true`。这证明事件送达，不证明提交、付款等业务已完成。无确认时 5 秒内明确报错，不自动重试。

**拖动标签、原生菜单与并行操作（0.3.1 起）**

拖动浏览器标签、打开浏览器原生菜单时，Chromium 可能捕获或抑制页面输入。CDP 命令返回不等于页面收到了事件，扩展不能保证此时原生输入始终可用；结束拖动或关闭菜单后才能可靠继续依赖真实按键、指针事件和用户激活的操作。不要用 `Input.setIgnoreInputEvents(false)` 试图解除用户的菜单/拖动状态；它只释放该 CDP 会话自己持有的抑制状态，见 [Chromium InputHandler 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc)。

普通 HTML 控件可在操作前显式选择 `mode: "dom"`，减少与用户的原生输入竞争：

```json
{"tab_handle":"...","ref":"<最新快照的按钮 ref>","mode":"dom"}
```

以上参数用于 `browser_click`；`browser_fill` 另外传入 `text`。两者默认仍为 `mode: "native"`。

- DOM 点击要求 ref，只对 HTML 元素调用一次 `HTMLElement.click()`；不发送 mouse/pointer 序列，不提供可信事件或用户激活。返回 `method: "dom"`、`events_trusted: false`，不返回 `target_verified: true`。自绘控件、拖拽、依赖 pointerdown 或用户激活的功能仍需要原生输入。
- DOM 填写使用原生 value setter（contenteditable 使用 textContent），发送非可信 input/change 事件，不主动 focus/select。两种填写模式均核验字段最终文本，成功返回 `value_verified: true`；被吞、失焦或页面同步格式化导致文本不匹配时明确报错，不返回字段内容。复杂编辑器仍可能需要原生事件，异步回写不在即时校验范围内。
- 原生按键在隔离世界监听可信 keydown，以确认页面收到对应 key/code/modifiers，成功返回 `delivery_verified: true`。连续派发 down/char/up 后统一等待，输入派发阶段无回执或确认超时在 5 秒内报错，释放工具队列；确认送达不等于应用完成预期操作。无 DOM 快捷键替代模式。
- 失败后先观察页面；原生命令可能已经生效或稍后送达，不能自动重放，也不能在结果未知时自动切 DOM 模式补点一次。DOM 模式同样需要页面渲染进程能执行 JavaScript；浏览器/页面冻结、系统模态窗口等仍可能阻塞。

升级时先停止旧 Hub，再安装新版并运行 `browser-attach setup` 更新已配对的扩展副本，在浏览器中重新加载扩展并重连 MCP。使用自定义配置/扩展目录时保留原参数。Hub 与扩展版本必须一致，0.4.0 不会将新增工具发送给旧版扩展。

Windows 默认数据目录现为 `%USERPROFILE%/.browser-attach`，避免不同宿主的 AppData 虚拟化视图。已有配对目录请显式保留绝对 `BROWSER_ATTACH_HOME` 或 `--config`。`setup --nosis --config <实际路径>` 会将绝对配对文件和目录一起写入 Nosis；MCP 启动 Hub 时继续固定同一文件。不会自动查找或迁移 Codex 私有缓存中的配对数据。

AX 合并重复文本、移除 InlineTextBox，保留语义节点和交互子元素。`max_nodes` 为每页 10–3000，默认 600；`max_chars` 为每页序列化文本预算 1000–2000000，默认 24000。`truncated: true` 时传回 `next_cursor` 继续调用同一个 `browser_snapshot`，可以调整预算，refs 在续读过程中保持有效；输入、新快照和主文档导航会使 cursor/ref 一起失效。iframe 导航、同文档导航或移除仅使其子树 refs 失效，主页面 refs 与 cursor 保留；读取期间变化的子 frame 或续读中失效的 frame 会跳过并列入 `omitted_frames`。单个超长节点无法放入一页时会明确提示需要的预算，不丢弃尾部。`omitted_frames` 也报告未覆盖的跨进程 iframe；分页不表示已补齐 OOPIF。

`browser_navigate` 默认 `wait_until: "domcontentloaded"`、`timeout_ms: 15000`、`include_snapshot: true`，一次调用返回目标文档的标题、URL 和快照。可选 `commit` / `load`，超时范围 100–40000 ms；`include_snapshot: false` 省去快照。同文档 hash 导航不等待新的加载事件。超时不代表导航已取消，单页应用在 DOMContentLoaded 后仍可能异步更新，需按任务继续观察。

`browser_read_text` 默认 20000 字符，允许 1–100000，仅读取主页面可见正文。宿主的 Artifact 长行读取问题见 [Nosis 接入分析](NOSIS-INTEGRATION.md)，并不等于 Attach 快照的游标分页。

当前不支持下拉专用选择、鼠标 hover / drag、下载管理、网络拦截、测试运行器、Firefox / WebKit。完整优先级与源码依据见 [Playwright 对照分析](PLAYWRIGHT-ANALYSIS.md)。
