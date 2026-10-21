<p align="center">
  <img src="https://raw.githubusercontent.com/EvannZhongg/BrowserAttach/main/extension/icons/BrowserAttach.png" width="112" alt="BrowserAttach logo">
</p>

# BrowserAttach

让 MCP 客户端操作你已经打开、已经登录的 Chrome / Edge 标签页。BrowserAttach 通过本机配对扩展连接浏览器，保留现有登录状态，不需要启动远程调试端口或单独的自动化浏览器。

[npm](https://www.npmjs.com/package/@evan_zhong/browser-attach) · [使用指南](docs/USAGE.md) · [架构与设计](docs/ARCHITECTURE.md) · [验证报告](docs/TEST-REPORT.md) · [问题反馈](https://github.com/EvannZhongg/BrowserAttach/issues) · [贡献指南](CONTRIBUTING.md)

## 能做什么

- 发现多个浏览器配置，精确选择并独占接管标签页，完成后释放。
- 读取可访问性树、字段值和支持的编辑器模型，通过当前快照引用或严格 CSS/XPath 定位点击、替换填写和逐字输入。
- 原生指针悬停、分步拖拽、条件等待；无需打开系统弹层即可选择 HTML 下拉选项。
- 导航与历史前进/后退、打开或关闭标签页，处理 JavaScript 对话框，上传本机文件并截取整页或单个元素。
- 在主页面执行 JavaScript 表达式，读取接管后的控制台、页面异常和网络生命周期日志；需要校验 XHR/fetch 时显式开启有界、脱敏的请求/响应详情。
- 使用标准 stdio MCP，共提供 22 个工具。Hub 仅监听本机 loopback，通过随机密钥配对扩展。

## 环境要求

- Node.js **22 或更新版本**，以及 npm。
- Chrome / Edge **125 或更新版本**，且允许加载未打包扩展。推荐使用最新稳定版。
- 支持 stdio MCP 的客户端，能从 `PATH` 找到 Node/npm。

## 快速开始

### 1. 安装与配对

```sh
npm install --global @evan_zhong/browser-attach
browser-attach setup
```

`setup` 会输出稳定的扩展目录并启动本地 Hub。扩展目录通常是：

- Windows：`%USERPROFILE%\.browser-attach\extension`
- macOS / Linux：`~/.local/share/browser-attach/extension`

打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载该目录。每个需要接入的浏览器配置分别加载一次；扩展选项可设置容易辨认的配置名称。

也可以不全局安装：

```sh
npx --yes --package=@evan_zhong/browser-attach@latest browser-attach setup
```

### 2. 配置 MCP 客户端

将以下配置合并到客户端的 MCP 配置中，或参考 [mcp-config.json](mcp-config.json)：

```json
{
  "mcpServers": {
    "browser_attach": {
      "command": "npx",
      "args": ["--yes", "--package=@evan_zhong/browser-attach@latest", "browser-attach", "mcp"]
    }
  }
}
```

Windows 客户端若要求完整命令扩展名，使用 `npx.cmd`。已全局安装时，也可以配置 `"command": "browser-attach", "args": ["mcp"]`。重启 MCP 客户端后发现工具。

`@latest` 会在启动时解析 npm 最新版本。MCP 包与已加载扩展必须为同一版本；升级后重新运行 `browser-attach setup` 并在扩展页重新加载扩展，否则 Hub 会拒绝旧扩展连接。

Nosis 用户可运行 `browser-attach setup --nosis` 自动备份并更新配置，详见 [Nosis 集成](docs/NOSIS-INTEGRATION.md)。

### 3. 开始操作

1. `browser_discover(kind="browsers")` → `browser_discover(kind="tabs")`，确认浏览器、标签页标题和 URL。
2. `browser_claim_tab`，用 `discover(kind="tabs")` 的 `tab_id` 接管（可选 `expected_url` / `expected_title` 精确校验），取得本连接的 `tab_handle`。
3. `browser_snapshot` 取得元素 `ref`，再执行点击、填写或其他动作。
4. 动作后重新观察，结束时调用 `browser_tab_control(action="release")`。

标题易变时，claim 可省略 `expected_title`；`expected_url` 也可选。点击/填写可改用每次重新解析的 `selector`。原生元素点击自动滚动；整页坐标点击使用 `coordinate_space: "document"`。求值结果使用 `cursor` 续读缓存，不会重新运行脚本。设计取舍见 [架构说明](docs/ARCHITECTURE.md#设计取舍)。

接管和普通输入不会主动激活标签或窗口；需要前台渲染时显式调用 `browser_tab_control(action="activate")`。操作结果未知时先重新观察，避免重复提交。完整参数、分页、上传与输入语义见 [使用指南](docs/USAGE.md)。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_discover` | `kind=browsers/tabs`，发现浏览器配置、标签身份及控制状态 |
| `browser_claim_tab` | 独占接管已发现的标签 |
| `browser_open_tab` / `browser_tab_control` | 创建标签；显式 `release/activate/close` 释放控制、激活或关闭已接管的标签 |
| `browser_snapshot` / `browser_read_text` | AX 快照、元素引用和正文 |
| `browser_wait` | 只读等待元素、文本、URL 或网络空闲 |
| `browser_click` / `browser_hover` / `browser_drag` / `browser_select_option` / `browser_type` / `browser_fill` / `browser_press_key` / `browser_scroll` | 原生/DOM 输入、指针悬停与拖拽、下拉选择、逐字输入与滚动 |
| `browser_batch` | 单队列顺序执行 1–20 步 click/fill/type/press_key/hover/scroll/select_option/wait，失败即停并返回部分结果 |
| `browser_navigate` | HTTP(S) 导航与加载等待 |
| `browser_handle_dialog` | alert、confirm、prompt |
| `browser_upload_file` | 原生文件 input 或拦截的文件选择器 |
| `browser_screenshot` | 视口或整页 PNG，附坐标映射 |
| `browser_evaluate` | 主页面 JS 求值、Promise 等待、有界结果 |
| `browser_logs` | 用 `kind=console/network` 选择控制台、异常或请求日志，支持过滤和游标续读 |

## 本机数据与升级

| 平台 | 默认数据目录 |
| --- | --- |
| Windows | `%USERPROFILE%/.browser-attach` |
| macOS / Linux | `${XDG_DATA_HOME:-~/.local/share}/browser-attach` |

可通过绝对路径 `BROWSER_ATTACH_HOME` 显式覆盖。Windows 默认避开可能被打包宿主虚拟化的 AppData；不会搜索或自动合并其他宿主的私有缓存。目录包含配对配置、Hub 日志及稳定的扩展副本；不依赖 clone 位置、客户端工作目录或 npm 缓存。已有自定义目录请继续使用相同环境变量或 `--config`，不要在新默认目录意外创建另一套配对。

`setup --nosis` 会备份配置并固定当前 Node、CLI 和实际配对文件的绝对路径，同时设置 MCP 的 `BROWSER_ATTACH_HOME`；支持与自定义 `--config` 一起使用。MCP 启动 Hub 时继续传入同一绝对配对路径及目录，避免不同启动环境重新推导出另一份配置。

```sh
browser-attach status
browser-attach stop
npm install --global @evan_zhong/browser-attach
browser-attach setup
```

升级后在浏览器扩展管理页重新加载扩展，再重启 MCP 连接。Hub 与扩展版本必须一致。首次使用本项目的新名称时，应停止之前运行的 Hub 并重新配对；默认端口为 `47831`，可用 `setup --port` 修改。

## 架构与使用边界

```text
MCP 客户端 → Node.js stdio MCP → 127.0.0.1 Hub
                                  ↕ 本机配对
                          Chrome / Edge MV3 扩展
                                  ↓ chrome.debugger / CDP
                              现有 HTTP(S) 标签页
```

每个 MCP 连接拥有独立控制权，句柄不能跨连接使用。断连或停止调试会释放控制。客户端端点要求 Bearer 密钥并拒绝网页 Origin；扩展验证固定 Origin、密钥和版本。`browser_evaluate` 可以使用页面现有登录态读写数据，执行后快照分页失效，原节点 refs 可继续解析；超时或报错前可能已产生作用，不应自动重放。未暴露通用 CDP 工具。

日志从接管开始采集，跨导航保留，释放时清除；每类最多保留 500 条、1,048,576 个 JSON 字符，超限淘汰会报告 `data_loss`。网络日志默认只记录生命周期元数据；显式 capture 才读取之后的 XHR/fetch 有界、脱敏 headers/正文，不改变缓存或拦截流量。完整参数及边界见[使用指南](docs/USAGE.md#诊断日志)。

浏览器扩展具有调试权限，客户端操作可使用现有网站登录态；只应将其接入你信任的 MCP 客户端。网页内容不应被视为用户授权。配对密钥和生成的 `config.generated.js` 不应提交或发布，打包检查会拒绝包含该文件的包。

目前仅支持 Chrome / Edge 的 HTTP(S) 页面。下载管理、网络拦截和 Firefox / WebKit 尚不支持。跨进程 iframe 使用递归 session 路由，覆盖快照、输入、上传和日志；透视变换的 iframe 点击会明确拒绝。原生指针输入要求活动且未暂停的标签及未最小化窗口，焦点和文档可见性只作诊断；不就绪时快速返回未派发及 tab_control(action=activate) 提示；不会自动抢焦点。后台截图可能因浏览器暂停渲染而超时；原生菜单和标签拖动也可能抑制输入。

## 本地开发

```sh
git clone https://github.com/EvannZhongg/BrowserAttach.git
cd BrowserAttach
npm ci
npm test
npm run test:package
```

直接运行源码并配对仓库中的扩展：

```sh
node bin/browser-attach.mjs setup --extension-dir ./extension
node bin/browser-attach.mjs mcp
```

开发模式有意使用仓库扩展路径。一般安装请使用不带 `--extension-dir` 的 setup，确保移动仓库后仍可运行。Windows 也可运行 `./scripts/install.ps1`，或添加 `-ConfigureNosis`。

真实浏览器测试需要一个允许命令行加载扩展的 Chromium / Edge 可执行文件，路径由开发者传入：

```sh
npm run test:live -- --executable /path/to/chromium --family chromium
npm run test:interaction -- --executable /path/to/chromium --family chromium
npm run test:interaction -- --tab-indicators --executable /path/to/chromium --family chromium
```

这些测试使用临时配置和本地 fixture。测试覆盖与限制见 [验证报告](docs/TEST-REPORT.md)，实现与设计取舍见 [架构与设计](docs/ARCHITECTURE.md)。

## 参与贡献

欢迎通过 [Issues](https://github.com/EvannZhongg/BrowserAttach/issues) 提交可复现问题，或提交 Pull Request。请附上 Node、系统、浏览器与扩展版本，移除配对密钥和网页隐私数据。具体流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目采用 [MIT License](LICENSE)。
