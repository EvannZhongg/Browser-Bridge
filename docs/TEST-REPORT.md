# BrowserAttach 验证报告

## 0.3.3（2026-10-20）

- 重命名 npm 包、CLI、MCP 服务名、运行数据目录和环境变量，新增品牌素材与 MIT 许可证。
- `npm test`：61 项通过。
- `npm run test:package`：在仓库外的含空格目录安装 tgz、运行已安装 CLI、创建稳定扩展副本并通过 stdio 发现全部 17 个工具。
- Chromium 156 真实扩展专项：红色分组和新标题、导航保持、释放恢复用户分组、MCP 断连恢复通过；页面无常驻徽标，默认截图隐藏临时点击反馈。
- Chromium 156 上传 fixture：54 次工具调用，单/多文件、Unicode 路径、空文件、隐藏 input、showPicker、清空、禁用/目录/缺失文件校验、导航后清理和对话框处理通过。
- Windows 安装脚本改用稳定用户目录，包校验从任意工作目录执行；通用配置无作者本机路径。

本轮使用临时 profile 和本地 fixture。以下保留的旧版本验证记录只说明当时覆盖，不等同于本轮重新执行了所有宿主或所有浏览器场景。

## 历史验证

**2026-10-20：0.3.2 原生标签栏标记与点击反馈**

控制状态改为绿色「🔴」原生标签分组，需要 `tabGroups` 权限。移除页面常驻徽标及原先的 3 秒刷新任务；保留原生点击后约 1.2 秒的箭头、光圈，节点随后移除。点击反馈依然在隔离世界中生成，未注册 document-start 脚本，默认截图隐藏反馈，`include_indicators: true` 可保留它。

新增分组测试覆盖逐标签标记、原分组恢复、空组重建、多标签恢复同组、用户改组/改名、窗口变化、扩展重载恢复、固定标签提示及设置失败回滚。Controller 验证默认截图隐藏点击反馈、调试停止后恢复分组、反馈初始化挂起时仍可释放且不会延后绘制。

Chromium 156 与 Edge 155 均通过 `node scripts/interaction-smoke.mjs --tab-indicators --executable <path> --family <family>`：原生分组标题/颜色正确，接管时没有页面常驻徽标，点击后存在临时反馈节点，默认截图不含反馈，主页面导航保留分组，释放后移除标记并恢复原有用户分组，MCP 断连同样恢复。测试只操作临时 profile 和本地 fixture，原始结果为 `test-results/tab-indicators-chromium.json`、`tab-indicators-edge.json`。

固定标签按浏览器限制保持固定，仅返回 `visual_warning` 和扩展按钮 RUN 状态；不自动取消固定。恢复分组不保证原始标签排列。用户手动修改过的标记组不会被强行还原。

`npm test`：61 项全部通过。Chromium 156 完整交互回归通过，后台填写/按键/上传、前后台及遮挡点击、缩放、动态目标拦截、闭合 Shadow DOM、分页和导航保持可用。`npm run test:package` 验证 0.3.2 安装包与仓库外安装，工具集合仍为 17 个。

**2026-10-20：0.3.1 输入捕获优化**

新增显式 click/fill `mode: "dom"`；默认保持原生输入。原生按键用隔离世界 binding 核验可信 keydown，输入发送阶段最多等待 5 秒；原生/DOM 填写核验字段实际文本。失败不自动重放，也不自动降级。

`npm test`：51 项全部通过。新增 DOM 激活/禁用校验、DOM 填写与事件通知、吞输入后的文本不匹配、伪造键盘回执拒绝、键盘超时后队列可用、down 失败仍发送 up、键盘弹窗及不可访问子 frame 的回归；stdio MCP 检查新增模式 schema 和 DOM 坐标拒绝。

新增 `node scripts/interaction-smoke.mjs --input-capture --executable <path> --family <family>`。测试在临时浏览器、独立配对扩展和本地 fixture 上执行，通过测试用 CDP `Input.setIgnoreInputEvents(true)` 主动抑制输入；被测操作仍通过真实 Hub/扩展。验证原生点击/按键明确失败、DOM 点击产生一次非可信 click 且没有 pointerdown、DOM 填写成功，以及解除抑制后原生填写/组合键/点击恢复，受控标签保持非活动。原始结果位于忽略目录 `test-results/input-capture-*.json`。

这是一项可重复的输入抑制测试，不是 Windows 原生菜单或真实标签拖动的逐场景 UI 复现。DOM 模式需要渲染进程仍能响应，不能据此承诺所有原生菜单或系统模态状态都可绕过。Chromium 的 `SetIgnoreInputEvents(false)` 只释放该 handler 自己的 `ScopedIgnoreInputEvents`，不能用于强行撤销其他浏览器 UI 的捕获状态，见 [源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc)。

Chromium 156 与 Edge 155 均通过上述输入抑制测试，并验证 textarea/contenteditable 的原生与 DOM 多行填写、子 frame 的可信键盘回执。Chromium 156 完整交互回归通过，包括后台输入/上传、前后台和遮挡点击、缩放、hover 位移拦截、闭合 Shadow DOM、21 页续读和导航。`npm run test:package` 通过，生成 0.3.1 安装包，仓库外安装后仍暴露 17 工具。

**2026-10-20 三项问题核验与修复后的最新结果**

`npm test`：44 项全部通过，新增 iframe 导航/移除/读取竞态、子树 ref 与 chooser 清理、cursor 保留、无限几何位移、标签管理及跨会话权限测试。`npm run test:package` 通过，仓库外安装的 stdio MCP 暴露 17 个工具。

`npm run test:interaction -- --regressions --executable <path> --family <family>` 在独立临时 profile 中通过真实扩展与 Hub，测试结果如下：

| 场景 | Chromium 156 | Edge 155 |
|---|---|---|
| 后台 ref / 坐标点击，目标标签保持非活动 | 43 / 11 ms，可信事件命中 | 77 / 25 ms，可信事件命中 |
| iframe 导航后使用先前主页面 ref | 命中 | 命中 |
| iframe 每 60 ms 刷新期间读取快照 | 连续 20 次成功 | 连续 20 次成功 |
| 无限 CSS transform 动画中的按钮 | 3 次各命中，344–691 ms | 3 次各命中，300–324 ms |
| 新建、claim、激活、聚焦窗口、关闭标签 | 成功；关闭后句柄失效 | 成功；关闭后句柄失效 |

原始专项结果：忽略目录 `test-results/regressions-chromium.json`、`regressions-edge.json`。计时仅代表本机 fixture。后台点击并非必然等 5 秒失败；claim 继续不抢焦点，需要前台渲染时可以显式调用 activate_tab。激活标签与聚焦窗口分开调用 Chrome API，依据 [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) 与 [Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)。

实测还确认 iframe 刷新会触发标签级 `tabs.onUpdated(status: loading)`；因此仅过滤 `Page.frameNavigated.parentId` 不足以修复，已同时删除 status-only 更新对整页观察的失效处理，主文档仍通过 CDP 事件及 URL 更新失效。

完整交互脚本首次在 Chromium 156 的后台 `Control+A` + `Z` 断言失败：预期 `z`，实际仍为原输入文本。随后在独立临时 profile 中分别验证 HEAD 基线扩展和当前修改后的扩展，均完整通过：后台填充/按键/上传、前后台/遮挡点击、缩放、hover 位移拒绝、闭合 Shadow DOM、21 页续读和导航。当前版本后台 ref 点击约 26–27 ms，坐标点击约 6–7 ms。键盘实现未修改；首次失败没有稳定复现，保留这条记录，不据复跑宣称排除了所有偶发焦点问题。当前原始结果为 `test-results/interaction-chromium.json`，基线结果为 `test-results/baseline-interaction-chromium.json`。

**以下为本轮修复之前的验证记录**

日期：2026-10-20。本轮覆盖点击派发和命中、滚动坐标、语义快照分页、导航等待，以及 Node/npm、上传和 Nosis 接入回归。工具集合为 14 个；没有旧版兼容层。

**自动测试**

`npm test`：37 项通过。覆盖 ownership、Origin/Bearer/配对、ref/cursor 失效、坐标边界、滚动换算、遮挡、原生输入按序连续派发、缺失/错误 click 回执、弹窗与截图超时恢复、200 行压缩、分页不丢尾部、导航 loader/frame 匹配及生命周期先于协议响应、同文档导航、加载超时、文档读取竞态、文件上传和当前 Nosis 配置生成。

`npm run test:package`：真实打包并在仓库外、含空格的 npm prefix 安装；生成独立扩展目录，从包启动 stdio MCP，发现 14 工具并调用模拟配对扩展。包内包含点击/导航/快照模块，不包含机器配对密钥、.local、.venv 或测试产物。当前本机全局命令指向此仓库，版本为 0.3.0。

**真实交互**

`scripts/interaction-smoke.mjs` 通过独立临时 profile 中真实扩展 → Hub 执行操作。私有 CDP 仅用于测试建立页面、切换测试标签/窗口和核验页面状态；没有代替 Attach 执行被测动作。

| 场景 | Chromium 156 | Edge 155 |
|---|---|---|
| 后台 ref 点击，三次 | 约 30–60 ms，全部命中 | 约 40–60 ms，全部命中 |
| 后台坐标点击，三次 | 约 7–25 ms，全部命中 | 约 10–25 ms，全部命中 |
| 目标窗口失焦并被测试窗口覆盖 | 三次命中，未激活目标窗口 | 三次命中，未激活目标窗口 |
| 80% / 125% 缩放 | 命中、页面计数各增 1 | 命中、页面计数各增 1 |
| hover 后按钮右移 30 px | 明确拒绝；计数 0，无错误 click | 明确拒绝；计数 0，无错误 click |
| 后台填充、组合键、滚动及上传 | 实际文本/文件内容正确，活动标签不变 | 实际文本/文件内容正确，活动标签不变 |
| 滚动 500 px 后点击固定上传按钮 | 命中并上传 | 命中并上传 |
| 200 行列表，加输入/上传控件 | 206 语义节点、约 16 KiB，一次读全 | 同左 |
| 强制 10 节点/1000 字符预算 | 21 页读全，第一页 ref 可继续使用 | 同左 |
| 1000 ms 慢脚本导航 | 约 1.04 秒后返回 Ready 和正确标题/URL | 约 1.04 秒后返回 Ready 和正确标题/URL |
| 同文档 fragment 导航、不附快照 | 正常返回 | 正常返回 |
| 闭合 Shadow DOM 内按钮、点击链接切换文档 | 命中验证成功，目的页就绪 | 命中验证成功，目的页就绪 |

计时为本机本地 fixture 的完整 Hub 调用，不是任意网站的性能保证。原始结果在忽略的 test-results/interaction-chromium.json、interaction-edge.json。早期只测点击的独立样本也验证过页面 visibility=hidden；完整输入后 Chromium 可能将受控页面呈现为 visible，因此测试还直接核验 chrome.tabs.active=false、活动标签未切换、失焦窗口未被前置，不能仅依赖 visibility 推断是否在后台。测试允许用户/系统让已聚焦窗口失焦，但不允许 Attach 激活原先失焦的窗口。

**当前 Chrome / Edge 与上传回归**

本机已通过扩展 options.html#reload 维护入口重载 Chrome 155、Edge 155，Hub 返回 extension_version=0.3.0。两者均通过 scripts/live-smoke.mjs 的 15 项真实 stdio MCP 检查：填写、点击、单/多文件、中文/空格路径、零字节文件、隐藏 input.click()、showPicker、清空、失效 ref、禁用/目录/缺文件拒绝、导航清理 chooser、确认框处理，以及页面无 JS 错误。最新报告每组约 54 次调用，包含页面异步状态观察。

文件路径由本机校验后传 CDP，页面读取实际文件内容；不将文件内容送进 MCP 参数或模型文本。普通文件使用 DOM.setFileInputFiles；空选择显式清空并派发 input/change。点击和上传是分别授权的动作。

**当前 Nosis 数据契约**

Nosis 工作区正在从共享 Broker 改为 Core McpClientManager。本轮只更新 Attach 的配置生成器和可选 scripts/verify-nosis.py，不修改 Nosis 源码或其未提交重构；生成配置已删除新架构禁止的 scope 字段。

Chrome / Edge 均经当前 McpClientManager → stdio MCP 调用全部 14 工具，验证 ToolSet、ToolResultNormalizer、截图附件、tool_media、Provider image_url、文本模型降级及 isError 后连接可继续使用。未向真实模型 API 发请求，也未覆盖 Nosis 前端审批交互。原始报告为 test-results/nosis-contract-*.json。

Nosis 大正文仍会生成完整 Artifact，但嵌套 JSON 长行被 read_file 截断后无法读到 TAILMARK；验证记录 artifact_paging_limitation=true。该 Nosis 通用读取缺陷未修复。本轮 Attach 的快照游标能在服务端预算内分多次读取，不等于修复宿主所有超大 JSON 产物。

**边界**

- 后台操作需要浏览器运行、页面可执行；休眠、冻结或浏览器权限 UI 不在常规页面输入范围内。
- 不切前台、不移动系统鼠标。网站自行弹窗、新窗口或权限 UI 仍可能改变焦点。后台截图可能等待渲染并在 5 秒超时，不自动前置页面。
- target_verified 只证明可信事件命中；不能据此宣称订单、提交或服务端上传完成。DOMContentLoaded 也不证明 SPA 数据已全部就绪。
- 未补齐 OOPIF、目录上传、File System Access API、下载管理、hover/drag 专用能力；没有扩展工具集合。
- npm registry 尚未发布；提供本地 0.3.0 tgz 和便携命令配置，不将未发布的 npx registry 示例写入本机正式配置。
