# Playwright 源码对照与 BrowserBridge 改造

分析日期：2026-10-20。检索的是 [microsoft/playwright](https://github.com/microsoft/playwright)，本地浅克隆并按目录读取源码，固定 commit 为 [58b93301d906b77a3854bc4d8ff4130f00a808ae](https://github.com/microsoft/playwright/tree/58b93301d906b77a3854bc4d8ff4130f00a808ae)。以下比较 Playwright 的库能力与本项目实际实现，不能把库的每个 API 都等同于应该增加的 MCP tool。

结论：Bridge 应保留“扩展接入已有登录配置、精确身份接管、跨会话互斥”的定位。最值得补齐的是现有操作的可靠性与常见表单能力。此次把上传与可移植分发落地，只增加一个 browser_upload_file；其余作为明确的后续优先级，没有凭分析扩大接口。

**差异、价值与接口选择**

| 领域 | Playwright 源码机制 | 本次完成后的 Bridge | 建议与优先级 |
|---|---|---|---|
| 文件上传 | 校验/重定位 input，处理 multiple/目录，原生 CDP 路径或文件 payload | 新增真实 input 上传、chooser 拦截、多文件、清空、路径校验；目录明确不支持 | 本次已完成，新增一个必要 tool；不暴露通用 CDP |
| 动作前等待 | visible/enabled/stable/non-inert、命中检查、有限等待循环 | click 做滚入视口与遮挡检查；fill 检查可编辑与焦点；仍缺完整稳定性/等待 | 最高后续优先级；增强 click/fill 的 timeout 参数与内部状态检查，不新增 wait/click 重试工具 |
| 定位与引用 | role/label/test id 等语义定位、严格匹配、重试解析及 ARIA refs | 原生 AX backendDOMNodeId 引用，动作后全部失效 | 保留 ref 默认；先改善快照里的状态、值和表单关联，再考虑现有工具中的可选 locator；不要马上加 find_* 工具族 |
| iframe / Shadow DOM | frame session 路由，注入层 DOM 与语义遍历 | 同进程 frame 尝试读取；OOPIF 在 omitted_frames 明示；上传继承相同边界 | 高优先级，但先统一 session+frame 路由，再复用到 snapshot/click/fill/upload，避免只补某一个 tool |
| select / checkbox 等表单 | 原生 selectOption、状态检查及对应事件 | 文本填写、键盘与点击；没有专用 select/checkbox 语义 | 有实际站点需求时扩展现有 fill 为有判别的表单操作；checkbox 可先用 click+snapshot 验证，不增加 check/uncheck 各一个工具 |
| 失败诊断 | 日志、console、request failures、trace recorder 与快照 | 明确错误、有限 AX/frame 覆盖及截图元数据，缺页面 console/error 缓冲 | 中高优先级；在 snapshot 的可选 diagnostics 中提供有限条数的错误与请求失败，不加全量网络监听工具 |
| 页面生命周期 | navigation/lifecycle 等待、popup/page 管理、download | navigate 只报告开始；既有标签页列表与身份接管 | 中优先级；navigate 增加明确等待条件和超时，popup 仍经 list_tabs/claim；有明确下载需求再补 |
| 视觉交互 | hover、drag、鼠标和触摸序列 | click、键盘、DOM scroll、截图；无 hover/drag | 有菜单/拖拽需求后扩展动作参数或收敛操作接口，不为每种鼠标事件新建工具 |
| 隔离与调试 | contexts、storageState、跨浏览器引擎、测试运行器、trace/video | 使用用户真实已有 profile，主要面向 Chrome/Edge | 当前不补 context 创建、cookie 导出、Firefox/WebKit、测试 runner；它们会改变产品定位 |
| 分发 | npm 包入口与依赖管理 | Node Hub/MCP + npm bin + 用户目录配对 | 本次已完成，删除 Python runtime 和绝对路径配置，无旧实现兼容层 |

**上传实现的源码依据**

[dom.ts 的 _setInputFiles](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/dom.ts#L748) 会跟随 label 到 input，检查 multiple 和目录语义，并对路径做存在性检查。[crPage.ts](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/chromium/crPage.ts#L343) 在 Chromium 上使用 DOM.setFileInputFiles。

[fileUploadUtils.ts](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/fileUploadUtils.ts) 区分本机路径、目录、payload 和跨主机传输；[client/elementHandle.ts](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/client/elementHandle.ts#L282) 将空数组走 payload 路径。[injectedScript.ts 的 setInputFiles](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/injected/src/injectedScript.ts#L1015) 会设置文件列表并派发 input/change。

Bridge 因为 Hub、MCP 和浏览器都在本机，只传文件路径，不增加 base64 文件内容、临时文件服务器或大文件传输协议。普通文件由 CDP 设置，空数组显式清空并发出 input/change；这是实测发现的 Chromium 差异所需处理，不是旧实现兼容。

[crPage.ts 的 _onFileChooserOpened](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/chromium/crPage.ts#L957) 使用 backendNodeId 定位真实 input；[同文件的 chooser interception](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/chromium/crPage.ts#L1100) 使用 Page.setInterceptFileChooserDialog。Bridge 在接管时开启拦截，将 chooser 状态附在已有 click/snapshot 结果中，upload_file 可以省略 ref 使用该状态。导航、文档更新、释放时清理状态。

直接传 ref 时支持 file input 与关联 label，允许隐藏 input 的 chooser 路径，不要求把系统文件窗口交给桌面控制。上传前检查文件可读及存在，浏览器层检查真实类型、连接状态、禁用及 multiple。输入动作使 ref 失效，工具不自动重新执行上传。

**等待、定位、frame 和诊断的源码依据**

[dom.ts 的 _retryAction](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/dom.ts#L330) 以逐步退避重试前置条件；[动作状态检查](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/dom.ts#L438) 检查可见、可用、稳定与 inert 状态。这值得借鉴，但 Bridge 的网页操作可能提交真实数据，因此只能重试“尚未派发输入”的检查；一旦事件已派发、模态阻塞或操作超时，就必须保留“结果未知，重新观察”语义，不能重放提交。

[selectorGenerator.ts](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/injected/src/selectorGenerator.ts) 包含 role、label、文本等候选与评分；[ariaSnapshot.ts](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/injected/src/ariaSnapshot.ts) 负责语义树和 ref。这表明更有价值的是定位与观察质量；照搬所有 selector engine 会增大维护成本，还可能让模型凭猜测跨页面定位。

[crPage.ts](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/chromium/crPage.ts) 根据 frame/handle 选择 CDP session，处理 OOPIF 生命周期。Bridge 目前 debugger target 只有 tabId，补跨进程 iframe 必须同时考虑 chrome.debugger 的子 session 支持、Chrome 最低版本、事件归属、导航清理和跨源坐标，不能仅给 AX 接口传一个 frameId 就宣称完整支持。

[trace/recorder](https://github.com/microsoft/playwright/tree/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/trace/recorder) 展示了完整诊断链。Bridge 更适合先做有大小上限的诊断字段；全量 trace/video 会保存大量网站内容，增加存储和维护负担，当前不纳入。

**“Choose file”报错的处理范围**

已复现验证的标准流程是原生 input、隐藏 input.click() 和 HTMLInputElement.showPicker()；在当前 Chrome 155、Edge 155 和 Chromium 156 中都能拦截，选择文件后测试页没有 window.onerror 或 unhandledrejection。

原始问题没有给出具体网站和异常堆栈，因此不能断言任何网站的“Choose file”错误都被修复。window.showOpenFilePicker() 属于不同的 File System Access API，不会被当作 HTML input chooser 承诺支持；跨进程 iframe 的上传也需要先补 frame 路由。若某站点仍报错，应先查看其实际异常和使用的 API。

**分发改造与实施结果**

- Hub、客户端、MCP、setup 全部改成 Node ESM，依赖标准 MCP SDK、ws、zod；未引入 Playwright 运行依赖。
- 删除原 Python 包、pyproject/uv.lock 和旧测试/脚本；没有 Python 启动包装或读取旧配对数据的兼容层。
- npm 包 @evan_zhong/browser-bridge 提供 browser-bridge bin；通用配置通过固定版本的 npx 启动 `browser-bridge mcp`。
- setup 将可重用扩展复制到用户数据目录，避免 npx 缓存目录变化造成失效；开发者也可显式选择仓库扩展目录。
- Windows 使用当前用户 SID 配置私有目录 ACL，避免中文账户名的控制台编码问题。
- 发布白名单、extension/.npmignore 和 prepack 检查共同防止把 config.generated.js 与配对密钥打进包。
- 包名 local-browser-bridge 已被另一个 Safari 项目使用，因此改用与仓库账号对应的 scope。当前仅构建安装包，不宣称已取得该 scope 的 registry 发布权限。
- 本机已全局安装、重新配对并重载 Chrome/Edge 0.2.0 扩展，Nosis 配置已备份并更新。MCP 客户端仍需重新连接以刷新 14 个工具。

验证细节见 [TEST-REPORT.md](TEST-REPORT.md)。

