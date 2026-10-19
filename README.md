# Local Browser Bridge

独立的 Chrome / Edge 浏览器扩展与 MCP。操作已经打开的用户标签页，直接使用该浏览器配置中的登录状态；不依赖 Nosis 源码、Codex、Playwright 或远程调试启动参数。

## 本机已经配置

- 项目：`F:\BrowserBridge`
- 扩展：`F:\BrowserBridge\extension`
- Python：`F:\BrowserBridge\.venv\Scripts\python.exe`
- 配对：`F:\BrowserBridge\.local\config.json`（私有目录，不参与版本管理）
- 日志：`F:\BrowserBridge\.local\hub.log`（不记录网页内容或配对密钥；原有 Hub 重启前仍写入旧日志）
- Nosis：`~/.nosis/agent_config.json` 中的 `mcp.servers.browser_bridge`

## 第一次使用

1. 在你平时使用的 Chrome 配置中打开 `chrome://extensions`。
2. 开启开发者模式，点击“加载已解压的扩展”，选择 `F:\BrowserBridge\extension`。
3. 在你平时使用的 Edge 配置中打开 `edge://extensions`，加载同一个目录。
4. 如有多个浏览器配置，每个需要接入的配置都分别加载。可以在扩展选项中设置“Chrome 个人账号”“Edge 工作账号”等名称。
5. 重启 Nosis，使新增的 MCP 配置生效。扩展连接成功时显示 `ON`。

无需退出浏览器，无需重新登录网站，无需打开 9222 端口。普通网页不需要刷新。浏览器会显示调试控制提示，用户可以随时停止，也可以在扩展弹窗中“释放全部标签页”。

Chrome 和 Edge 的本地加载说明：
- https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading

## 在 Nosis 中使用

例如告诉 Nosis：

> 使用 browser_bridge MCP，列出已连接的 Chrome 和 Edge 以及标签页；接管 Edge 中标题为 Nosis 的页面，读取页面结构，完成后释放标签页。

工具名称前缀为 `mcp__browser_bridge__`。完整流程：

1. `browser_list_browsers()`：发现已连接的浏览器配置实例。
2. `browser_list_tabs(browser_id)`：列出用户标签页及控制状态。
3. `browser_claim_tab(browser_id, tab_id, expected_url, expected_title)`：传入刚列出的精确身份，取得 `tab_handle`。
4. `browser_snapshot(tab_handle)`：读取无障碍树及元素 `ref`。
5. 使用快照中的 `ref` 点击或填写；操作后重新观察。坐标点击使用最新截图的视口 CSS 坐标。
6. `browser_release_tab(tab_handle)`：释放控制，保留页面。

| 工具 | 功能 |
|---|---|
| `browser_list_browsers` | 发现 Chrome / Edge 配置实例 |
| `browser_list_tabs` | 列举已有标签页、标题、URL 和控制状态 |
| `browser_claim_tab` | 校验身份并独占接管 |
| `browser_release_tab` | 释放控制，不关闭用户页面 |
| `browser_snapshot` | AX 语义树、元素引用和 iframe 覆盖情况 |
| `browser_read_text` | 主页面的可见文本 |
| `browser_click` | 按元素引用或视口坐标点击 |
| `browser_fill` | 替换文本框、多行文本或可编辑区域的内容 |
| `browser_press_key` | 按键或组合键，如 `Enter`、`Control+A` |
| `browser_scroll` | 在指定视口位置滚动 |
| `browser_navigate` | 将已接管标签页导航到 HTTP(S) URL |
| `browser_handle_dialog` | 处理 JavaScript alert / confirm / prompt |
| `browser_screenshot` | 返回视口或整页 PNG 图片内容 |

Nosis 使用现有权限 preset 和 MCP 审批规则；安装配置设为 `scope: session`、`tools.approval: always`。Full Access preset 是否跳过审批由 Nosis 自身决定。

## 后台操作和接管标记

扩展不会主动切换标签页、置顶浏览器窗口，也不移动系统鼠标。普通 DOM/AX 读取、文本填写、点击、按键、滚动和导航可以在非活动标签页执行。本机已在 Chrome、Edge 中分别把另一个浏览器窗口放在前台进行验证。网站自己打开的新窗口、浏览器权限提示、系统对话框仍可能改变焦点；这不等于无人桌面或锁屏自动化。

接管时，页面右上角显示绿色机器人图标和“Agent 已接管”，扩展按钮在此标签页显示 `RUN`。点击时在实际视口位置显示橙色鼠标和圆环约 1.2 秒。它们不接收鼠标事件，不进入 AX 树或可见正文；页面导航后会重新显示。显式释放会立即清除；用户在浏览器中停止调试时，页面标记通过约 9 秒租约过期清除，后台页面的定时器可能延后。

截图默认隐藏这些标记并在完成或失败后恢复；需要查看操作轨迹时可传入 `include_indicators: true`。页面标记在后台标签页中绘制，用户切回该页时可看到接管状态；不会为了展示光标而激活页面。这里没有改写网站 favicon。

后台截图有明确限制：Chromium 的非活动或被遮挡页面可能停止生成截图，工具等待 5 秒后返回错误，不自动激活页面。此时优先使用 `browser_snapshot` / `browser_read_text`；需要视觉信息时，由用户明确查看目标页后重新截图。普通可见页面的视口和整页截图均已实测通过。

`browser_scroll` 使用页面内的 DOM 滚动，返回实际 `before` / `after`、`scope` 和 `method: "dom_scroll"`，避免后台原生滚轮等待渲染而挂起。它不触发自定义 wheel 处理器或 Canvas 缩放；跨源 iframe 内滚动会明确报错。隐藏页面的 `scroll` 事件处理器可能稍后执行，工具返回的滚动位置比网站缓存的事件状态更直接。

## 传给模型的数据

12 个普通工具只返回一个包含紧凑 JSON 的 MCP `TextContent`，不再同时发送重复的 `structuredContent`。截图返回一个文字元数据块和一个标准 `ImageContent`；PNG base64 只用于图片传输，不放进文字元数据。

Nosis 会把图片保存为附件并转换为 `ImagePart`，通过独立图片消息送给支持视觉的模型。普通结果仍保留标准 MCP `content` 外层；超过 Nosis 工具预算的正文按其现有机制写入 Artifact。错误通过 MCP `isError` 进入 Nosis 的错误结果，不伪装为成功。完整示例和实际大小见 [测试报告](TEST-REPORT.md)。

截图元数据提供 PNG 实际像素尺寸、CSS 视口和 `image_to_viewport_css`。点击不能直接套用 PNG 像素坐标，应计算：

```text
viewport_x = image_x * scale_x + offset_x
viewport_y = image_y * scale_y + offset_y
```

整页截图中视口外的位置需要先滚动并重新观察。本机缩放比例为 1.5，已经验证 PNG 像素与 CSS 点击坐标的换算。

## 架构与控制边界

```text
Nosis / 其他 MCP Client
    → 每个连接独立的 stdio MCP 进程
    → 127.0.0.1 本地 Hub（端口 47831）
    ↔ 当前 Chrome / Edge 配置中的 MV3 扩展
    → chrome.tabs + chrome.debugger / CDP
```

Hub 只监听 loopback，扩展连接同时验证固定扩展 Origin 和本机随机密钥；MCP 连接使用 Bearer 密钥并拒绝网页 Origin。扩展没有 content script 或 web-accessible resource，不把密钥注入网站。操作不移动 Windows 的真实鼠标。

每个 MCP 连接有独立所有者身份；标签页只能被一个所有者接管，其他聊天无法使用它的句柄。扩展断连、浏览器重启、用户停止调试都会使原句柄失效。MCP 连接关闭时自动释放其标签页。Nosis Broker 可能跨 Turn 保持 MCP 连接，因此任务结束后应显式释放，不依赖 Turn 结束自动释放。

本地 Hub 在 MCP 初始化时按需后台启动，可跨 MCP 客户端共享。连接恢复只恢复通信，不重放浏览器动作。操作结果未知时，重新观察后再决定下一步。

## 当前范围

- 支持 Chrome / Edge 120+ 的普通 HTTP(S) 标签页，包括 localhost；浏览器内置页面和其他扩展页面仅列出，不能接管。
- 读取不要求支持视觉的模型；截图需要 MCP 客户端和模型支持图片。
- AX 快照尝试读取主框架及同进程 iframe。无法读取的跨进程 iframe 明确列在 `omitted_frames` 中；截图可用时可使用坐标操作。默认最多 600 节点，范围 10–3000，并有约 14000 字符的序列化行预算；截断会返回原因。
- 文本填充支持常规文本 input、textarea、contenteditable；禁用、只读、number 等不支持的输入会报错。不提供下拉框专用选择、上传、下载管理或任意 JavaScript/CDP 执行工具。
- `browser_read_text` 读取主页面可见正文，默认最多 20000 字符，可设置 1–100000；不承诺包含 iframe 或关闭的 Shadow DOM。JavaScript 对话框可处理，浏览器原生权限、文件选择和系统对话框需用户操作。
- 元素引用在下一次快照、输入动作或文档更新后失效。动态页面仍可能在观察后发生变化；失效或被遮挡时应重新观察。
- 浏览器配置名称由用户设置；扩展通过随机实例 ID 区分配置，不读取浏览器配置文件或密码库。
- 保留浏览器自身的权限限制。DevTools、其他调试扩展或企业策略可能阻止接管，错误会原样返回，不强行抢占。

## 本地命令

```powershell
cd F:\BrowserBridge
.\.venv\Scripts\python.exe -m browser_bridge.setup status
.\.venv\Scripts\python.exe -m browser_bridge.setup start
.\.venv\Scripts\python.exe -m browser_bridge.setup stop
```

停止 Hub 会断开扩展并释放调试控制。下一次 MCP 初始化会重新启动 Hub。

重新安装依赖并配置 Nosis：

```powershell
.\scripts\install.ps1 -ConfigureNosis
```

安装脚本只新增或更新 `browser_bridge` 配置；修改前备份 Nosis 的完整配置，不改变其他 MCP。更新扩展代码后，在 Chrome / Edge 扩展管理页点击该扩展的“重新加载”。

## 其他 MCP 客户端

`mcp-config.json` 提供通用 `mcpServers` 配置。服务本身不导入 Nosis，不依赖其 Session 或 Runtime。

## 开发与测试

```powershell
uv sync --frozen
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/controller.test.mjs
```

Python 测试启动真实 loopback Hub 和 stdio MCP，模拟浏览器扩展响应，验证发现、身份校验、互斥、断开清理、浏览器重启和图片内容。Node 测试模拟 Chrome API，验证 AX 引用、输入、遮挡、边界、释放和对话框。这些测试不等同于在用户已登录页面上的实测；真实浏览器接入需先完成上面的扩展加载步骤。

2026-10-20 本机验证结果：7 项 Python、16 项 Node 测试通过；Chrome 155 / Edge 155 真实边界测试记录 171 次工具调用，其中 138 次后台调用未改变前台窗口。全部 13 个工具的结果经过 Nosis MCP SDK 2.2.0 和实际媒体/Artifact 转换链验证。可见页面的视口与整页截图通过；后台截图分别记录成功或 5 秒超时，不计为后台能力全通过。详见 [测试报告](TEST-REPORT.md)。

真实操作只使用新建的本地测试页，结束后释放控制。原始结果含浏览器标签页标题和 URL，位于忽略版本管理的 `test-results/`，分享时应按需脱敏。

需要重新进行真实浏览器测试时，先确认两个浏览器都已连接，然后运行：

```powershell
.\.venv\Scripts\python.exe scripts/live_smoke.py
.\.venv\Scripts\python.exe scripts/verify_boundaries.py
F:\Nosis\.venv\Scripts\python.exe scripts/check_nosis_data.py --nosis-root F:\Nosis
```

该脚本会在两个浏览器的默认配置中新建本地测试标签页，通过真实 stdio MCP 执行测试，结束后关闭临时网页服务并释放控制。测试标签页保留，可自行关闭；如果连接的是非默认配置，需在对应配置中打开脚本给出的测试 URL，或调整测试脚本的启动参数。

`extension/config.generated.js` 和 `.local/` 配对配置含本机密钥，已排除在版本管理之外，不应公开分享。配对文件与 MCP 放在同一个 F 盘项目目录，避免不同宿主对用户 AppData 目录的可见性差异。复制项目到另一台机器后使用 setup 重新配对。

本次更新已写入本机 Nosis MCP 配置（`python -u -m browser_bridge.mcp_server`），修改前已备份。两个浏览器已加载最终扩展代码；重启 Nosis 后使用更新后的工具定义。测试脚本可能依赖本机 Nosis 开发环境，扩展、Hub 和 MCP 运行时仍完全独立。
