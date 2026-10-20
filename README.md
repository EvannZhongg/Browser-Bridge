# Browser Bridge

通过本机配对的 Chrome / Edge 扩展，以标准 stdio MCP 操作已经打开、已经登录的用户标签页。运行时统一使用 Node.js 22+，无需 Python、Playwright 或远程调试端口。

**从 clone 安装**

```powershell
npm ci
npm install --global .
browser-bridge setup
```

setup 输出扩展目录。在 Chrome 的 `chrome://extensions` 和 Edge 的 `edge://extensions` 中开启开发者模式，加载该目录。每个需要接入的浏览器配置分别加载一次。默认扩展安装在用户数据目录，npm 缓存清理、升级或仓库移动不会改变该路径。扩展选项可设置配置名称。

开发时直接加载仓库中的扩展：

```powershell
browser-bridge setup --extension-dir ./extension
```

Windows 也可运行 `./scripts/install.ps1 -ConfigureNosis`：安装 npm 命令、配对仓库扩展并备份/更新 Nosis 配置。常规用户通过 `browser-bridge setup --nosis` 接入 Nosis。自定义 `--config` 时应自行向 MCP 配置添加相同参数；`--nosis` 只接受默认配对路径。

该 Windows 脚本将本次 clone 的 `.local/runtime` 设为 `BROWSER_BRIDGE_HOME`，并把这个本机值写入 Nosis 的 `env`。此前本机 Nosis 共享 Broker 与直接启动进程对 AppData 配对文件存在可见性差异，需使用双方都能访问的目录；详情与数据传递结论见 [Nosis 接入分析](NOSIS-INTEGRATION.md)。通用 `mcp-config.json` 不写入这个本机路径。

**可移植 MCP 配置**

安装全局命令后，复制仓库的 [mcp-config.json](mcp-config.json) 到客户端：

```json
{
  "mcpServers": {
    "browser_bridge": {
      "command": "browser-bridge",
      "args": ["mcp"]
    }
  }
}
```

没有 Python、仓库或用户目录的绝对路径，也不依赖客户端工作目录。客户端需能从 PATH 找到 npm 的全局 bin 目录；Windows 客户端若只接受可执行文件名，可以使用 `browser-bridge.cmd`。安装后重启 MCP 客户端以重新发现工具。

包名为 `@evannzhongg/browser-bridge`，bin 为 `browser-bridge`。当前代码已支持 npm 打包和安装，**尚未发布 npm registry**；本机 `npm whoami` 返回 401，需要先登录具有该 scope 发布权限的账号。已占用的 `local-browser-bridge` 属于其他项目，所以没有使用该名称。

现在可分享本地安装包：

```powershell
npm pack
npm install --global ./evannzhongg-browser-bridge-0.3.0.tgz
browser-bridge setup
```

完成 registry 发布后，才可使用下面的免全局安装配置；固定版本使客户端和扩展版本一致：

```json
{
  "mcpServers": {
    "browser_bridge": {
      "command": "npx",
      "args": ["--yes", "--package=@evannzhongg/browser-bridge@0.3.0", "browser-bridge", "mcp"]
    }
  }
}
```

对应首次配对：`npx --yes --package=@evannzhongg/browser-bridge@0.3.0 browser-bridge setup`。未发布前不要将该 registry 配置当作已经可用。

**本机数据与升级**

Windows 默认数据目录为 `%LOCALAPPDATA%/BrowserBridge`，其他系统为 `~/.local/share/browser-bridge`；可用 `BROWSER_BRIDGE_HOME` 覆盖。目录包含 `config.json`、`hub.log` 及默认安装的 `extension/`。配对密钥仅写入私有配置与 `extension/config.generated.js`，打包检查禁止发布该生成文件。

```powershell
browser-bridge status
browser-bridge start
browser-bridge stop
```

每次升级：停止 Hub、安装新版、重新运行 setup 更新同一扩展目录，再在扩展管理页点击重载，或打开扩展选项点击“重新加载扩展”。本地维护也可打开 `chrome-extension://<setup 输出的扩展 ID>/options.html#reload`；该页面不是 web-accessible resource，网站无法直接调用它。重载会释放调试控制。Hub 与扩展版本必须一致，旧版扩展不会被误报为具有新版能力。

这是 0.2 的运行时替换；没有读取旧项目 `.local/config.json`、旧 Python MCP 或旧数据迁移的兼容路径。旧私有文件可以自行清理，不参与运行。

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
| browser_claim_tab / browser_release_tab | 校验身份、独占接管 / 释放 |
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

总共 14 个工具；0.3 保持现有工具集合，通过已有参数补齐点击验证、快照续读和导航等待。普通结果只返回一份紧凑 JSON TextContent；截图另外返回标准 ImageContent。失败使用 MCP `isError`。

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

不主动激活标签页、浏览器窗口或系统鼠标；DOM / AX 和常规输入可在后台执行。网站自己弹出的新窗口及浏览器权限 UI 仍可能改变焦点。页面带“Agent 已接管”标记及短暂点击指示；截图默认隐藏标记。

截图有 5 秒超时：被遮挡或非活动的 Chromium 页面可能停止渲染，失败时优先使用 AX / 文本，不自动切前台。PNG 像素要按返回的 `image_to_viewport_css` 映射到视口 CSS 坐标；整页截图的视口外位置需先滚动。

点击保持原生输入，连续派发 move/down/up 后统一等待确认；ref 会检查可见、启用、稳定和遮挡。命中查询换算为文档 CSS 坐标，鼠标输入仍为视口 CSS 坐标。隔离世界中的事件校验会阻止偏离目标的点击；只有收到匹配目标的可信 click 才返回 `target_verified: true`。这证明事件送达，不证明提交、付款等业务已完成。无确认时 5 秒内明确报错，不自动重试。

AX 合并重复文本、移除 InlineTextBox，保留语义节点和交互子元素。`max_nodes` 为每页 10–3000，默认 600；`max_chars` 为每页序列化文本预算 1000–2000000，默认 24000。`truncated: true` 时传回 `next_cursor` 继续调用同一个 `browser_snapshot`，可以调整预算，refs 在续读过程中保持有效；动作、新快照和导航会使 cursor/ref 一起失效。单个超长节点无法放入一页时会明确提示需要的预算，不丢弃尾部。`omitted_frames` 单独报告未覆盖的跨进程 iframe；分页不表示已补齐 OOPIF。

`browser_navigate` 默认 `wait_until: "domcontentloaded"`、`timeout_ms: 15000`、`include_snapshot: true`，一次调用返回目标文档的标题、URL 和快照。可选 `commit` / `load`，超时范围 100–40000 ms；`include_snapshot: false` 省去快照。同文档 hash 导航不等待新的加载事件。超时不代表导航已取消，单页应用在 DOMContentLoaded 后仍可能异步更新，需按任务继续观察。

`browser_read_text` 默认 20000 字符，允许 1–100000，仅读取主页面可见正文。宿主的 Artifact 长行读取问题见 [Nosis 接入分析](NOSIS-INTEGRATION.md)，并不等于 Bridge 快照的游标分页。

当前不支持下拉专用选择、鼠标 hover / drag、下载管理、网络拦截、测试运行器、Firefox / WebKit。完整优先级与源码依据见 [Playwright 对照分析](PLAYWRIGHT-ANALYSIS.md)。

**验证**

```powershell
npm ci
npm test
npm run test:package
npm pack --dry-run
```

真实临时浏览器扩展测试（只使用本地 fixture）：

```powershell
npm run test:live -- --executable "path/to/chromium-or-edge.exe" --family chromium
npm run test:interaction -- --executable "path/to/chromium-or-edge.exe" --family chromium
```

浏览器需允许命令行加载扩展；常规新版 Chrome 不保证支持此参数。也可对已经连接的 Chrome / Edge 运行 `--connected --executable <浏览器路径> --family chrome` / `edge`。该模式在用户浏览器中新建本地测试页，结束后释放控制，测试页保留。

2026-10-20：37 项自动测试；Chromium 156 和 Edge 155 独立窗口覆盖后台输入、焦点、缩放、动态位移、200 行完整快照及导航；Chrome 155、Edge 155 当前配置也验证上传及回归。具体结果见 [测试报告](TEST-REPORT.md) 和 [交互修复复核](INTERACTION-REVIEW.md)。
