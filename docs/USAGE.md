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

总共 17 个工具，包含显式标签管理、点击验证、快照续读和导航等待。普通结果只返回一份紧凑 JSON TextContent；截图另外返回标准 ImageContent。失败使用 MCP `isError`。

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

**架构与边界**

```text
MCP 客户端
  → 每连接独立的 Node stdio MCP
  → 127.0.0.1 Hub
  ↔ 配对的 Chrome / Edge MV3 扩展
  → chrome.tabs + chrome.debugger / CDP
```

Hub 按需后台启动，多客户端共用；只监听 loopback，扩展验证固定 Origin、随机密钥和版本；客户端端点要求 Bearer 密钥并拒绝网页 Origin。没有 content script、web-accessible resource 或任意 JS/CDP MCP 工具。

每个 MCP 连接有独立 owner，tab_handle 不跨连接共享；同一 tab 只允许一个 owner。断连、浏览器重启、用户停止调试均会使句柄失效。动作超时会释放该连接的控制权，结果可能未知，不自动重放。任务结束仍应显式 release，不能假设 MCP 客户端每轮都会关闭连接。

claim 和常规输入不主动激活标签页或浏览器窗口，也不移动系统鼠标；DOM / AX 和常规输入可在后台执行。显式 activate_tab 可以切换标签并聚焦窗口；open_tab 的 active 参数可以选中新标签。网站自己弹出的新窗口及浏览器权限 UI 仍可能改变焦点。控制状态显示在标签栏的红色「🔴」原生分组标记中，页面不再显示常驻“已接管”徽标。原生点击仍保留约 1.2 秒的箭头和光圈，随后移除节点；截图默认隐藏点击提示，`include_indicators: true` 可包含它。

**标签栏控制标识（0.3.3）**

每个被控标签临时进入单独的红色「🔴」原生分组，需要新增 `tabGroups` 扩展权限。分组标记由 [Chrome Tabs / TabGroups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups) 管理，不更改网页标题、favicon 或正文，也不设置页面常驻徽标。

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

升级时先停止旧 Hub，再安装新版并运行 `browser-attach setup` 更新已配对的扩展副本，在浏览器中重新加载扩展并重连 MCP。使用自定义配置/扩展目录时保留原参数。Hub 与扩展版本必须一致，0.3.3 不会将新增参数发送给旧版扩展。

AX 合并重复文本、移除 InlineTextBox，保留语义节点和交互子元素。`max_nodes` 为每页 10–3000，默认 600；`max_chars` 为每页序列化文本预算 1000–2000000，默认 24000。`truncated: true` 时传回 `next_cursor` 继续调用同一个 `browser_snapshot`，可以调整预算，refs 在续读过程中保持有效；输入、新快照和主文档导航会使 cursor/ref 一起失效。iframe 导航、同文档导航或移除仅使其子树 refs 失效，主页面 refs 与 cursor 保留；读取期间变化的子 frame 或续读中失效的 frame 会跳过并列入 `omitted_frames`。单个超长节点无法放入一页时会明确提示需要的预算，不丢弃尾部。`omitted_frames` 也报告未覆盖的跨进程 iframe；分页不表示已补齐 OOPIF。

`browser_navigate` 默认 `wait_until: "domcontentloaded"`、`timeout_ms: 15000`、`include_snapshot: true`，一次调用返回目标文档的标题、URL 和快照。可选 `commit` / `load`，超时范围 100–40000 ms；`include_snapshot: false` 省去快照。同文档 hash 导航不等待新的加载事件。超时不代表导航已取消，单页应用在 DOMContentLoaded 后仍可能异步更新，需按任务继续观察。

`browser_read_text` 默认 20000 字符，允许 1–100000，仅读取主页面可见正文。宿主的 Artifact 长行读取问题见 [Nosis 接入分析](NOSIS-INTEGRATION.md)，并不等于 Attach 快照的游标分页。

当前不支持下拉专用选择、鼠标 hover / drag、下载管理、网络拦截、测试运行器、Firefox / WebKit。完整优先级与源码依据见 [Playwright 对照分析](PLAYWRIGHT-ANALYSIS.md)。

