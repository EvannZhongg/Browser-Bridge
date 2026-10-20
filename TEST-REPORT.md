# Browser Bridge 0.2 验证报告

日期：2026-10-20。报告对应 Node/npm 运行时替换与文件上传改造；旧 Python 测试报告不代表本版本。

**自动测试**

`npm test`：27 项通过（19 项扩展控制器测试，8 项真实 Hub/MCP、上传路径与安装测试）。

覆盖范围：

- 接管精确 URL/title 校验、跨连接互斥、句柄归属、释放和浏览器重启。
- Origin + Bearer 认证、扩展配对、独立浏览器配置发现。
- AX ref 失效、遮挡、坐标边界、文本填写、键盘、滚动、截图超时恢复。
- JavaScript 对话框不阻塞后续处理、标记显示、iframe 遗漏与快照预算。
- 文件选择器拦截、pending 状态、真实 DOM.setFileInputFiles 参数、清空、导航/释放清理。
- 上传的相对路径、目录和不存在文件拒绝；中文路径与空文件接受。
- 真实 stdio MCP 初始化、14 工具发现、单份 JSON 内容、标准 PNG ImageContent、MCP isError。
- 操作超时断开并释放控制，不重放动作。
- 用户目录扩展安装、重复 setup 保留同版本配对及生成配置。
- Windows 中文账户 SID ACL 的真实执行。

**真实浏览器**

使用 stdio MCP 调用已加载的真实 MV3 扩展，不用 mock 或 Playwright 代替 Bridge 操作。测试页由临时 loopback HTTP 服务提供，文件均为脚本新建的非用户数据。

| 浏览器 | 模式 | 检查 | 最终调用数 |
|---|---|---|---|
| Chromium 156 | 独立临时 profile，headless | 15 项通过 | 53 |
| Chrome 155 | 用户当前已配对 profile，新建本地 fixture tab | 15 项通过 | 约 50–60，含异步状态轮询 |
| Edge 155 | 用户当前已配对 profile，新建本地 fixture tab | 15 项通过 | 约 50–60，含异步状态轮询 |

每组检查：

1. 既有 fill 行为。
2. 既有 click 行为。
3. 单文件：中文/空格路径，网页读取实际文件文本。
4. 上传后旧 ref 被拒绝。
5. multiple：两个文件及零字节文件。
6. “Choose file”调用隐藏 input.click()，拦截后上传两个文件。
7. HTMLInputElement.showPicker() 拦截与赋值。
8. files: [] 清空，网页状态更新。
9. 单文件 input 拒绝多个文件。
10. 禁用 input 拒绝上传。
11. webkitdirectory 拒绝普通文件。
12. 不存在文件在 MCP 层拒绝。
13. 导航后 pending chooser 被清理。
14. 原有 confirm 模态观察与拒绝。
15. window.onerror / unhandledrejection 为空。

预期失败通过 MCP isError 返回，包括失效 ref、禁用/目录/多文件冲突和对话框造成的“动作结果可能未知”。这些不是测试失败。Chooser 点击会在 click 结果或后续 snapshot 中报告；不要求浏览器打开系统文件对话框。

实测发现原生 CDP 空路径赋值不会触发页面 input/change，因此空数组现在用显式清空与事件通知；修正后页面观察与文件列表一致。

本机 Chrome/Edge 重载：桌面 computer-use 管道不可用，改为启动已安装扩展的本地 options.html#reload 入口。重载后 Hub 回报两者 extension_version = 0.2.0、capabilities 包含 upload_file。未安装额外浏览器扩展。

原始报告在忽略的 test-results/npm-live-*.json，包含工具调用的成功/预期错误标记；连接浏览器的测试页保留，调试控制已经释放。

**npm 包与安装**

- npm install / npm ci 使用 lockfile 固定依赖。
- npm pack 的 prepack 在真实打包前检查内容，已验证没有 extension/config.generated.js、.local、.venv、test-results 或 node_modules。
- 真实生成 evannzhongg-browser-bridge-0.2.0.tgz；在仓库外、包含空格的临时 npm global prefix 中安装成功。已安装包独立生成用户目录扩展，并从仓库外启动 stdio MCP、发现 14 工具和模拟配对浏览器。
- 本机 npm 全局 bin 可被 PATH 解析；Nosis 保存的 MCP 配置改为 browser-bridge mcp，旧配置修改前已备份。
- 初轮验证使用 Nosis 的直接 McpConnection，未覆盖常驻 Broker 的文件系统视图。后续已复现 Broker 读取 AppData 配对文件 ENOENT，并将本机配对目录改为双方可见的 F 盘目录；真实 Broker 及全部 14 工具的数据链路验证见 [Nosis 接入分析](NOSIS-INTEGRATION.md)。大正文 Artifact 已保存但无法完整分页读取的问题仍未修复。
- npm registry 尚未发布；本机 npm whoami 返回 401。README 中的 npx registry 示例明确要求先登录并发布，不把不存在的远端包写入当前配置。

**验证边界**

这些测试证明 Bridge 可将本机文件交给网页原生 input，页面可读取其真实内容。没有向互联网服务上传用户文件，也不代表任何业务网站的服务端处理已经完成。原问题网站及堆栈未提供，不能推断其所有脚本错误均被修复。

本轮未宣称补齐 OOPIF、目录上传、File System Access API、浏览器权限弹窗、下载或全部 Playwright API。后台截图等原有局限仍按 README 描述。
