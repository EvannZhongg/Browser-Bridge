# Browser Bridge 实测报告

日期：2026-10-20。对象：`F:\BrowserBridge`，Windows、Chrome 155、Edge 155，已加载扩展的现有配置。测试创建临时本地 HTTP 页面，通过真实 stdio MCP → Hub → 扩展 → CDP 操作；没有在业务网页上执行写操作。Nosis 源码未修改。

## 结果和后台边界

| 验证层 | 结果 |
|---|---|
| Python Hub / MCP / 所有权与断连 | 7 项通过 |
| Node 控制器 / 引用 / 对话框 / 标记 / 截图超时恢复 | 16 项通过 |
| 真实浏览器工具调用与边界 | 171 次记录，含 43 次预期错误或截图超时 |
| Chrome 后台调用 | 69 次，调用前后前台 HWND/PID 不变 |
| Edge 后台调用 | 69 次，调用前后前台 HWND/PID 不变 |
| 目标标签页 | 后台阶段始终保持非活动，结束前再次检查 |
| 可见页面视口 / 整页截图 | Chrome、Edge 均通过 |
| Nosis 结果与媒体转换 | 13 个工具样本、图片附件、大文本 Artifact、错误路径通过 |

后台阶段先打开观察标签页，使被控页面不活跃，再把另一个浏览器的观察窗口放在前台。每次调用记录前台窗口身份，结束后验证目标页未变为活动页。这证明本机测试条件下不需要逐次切到前台；没有验证锁屏、最小化窗口、所有网站或企业策略环境，也不能阻止网站弹窗自行取得焦点。窗口检查为调用前后采样，并非连续的系统焦点事件追踪。

后台截图单独记录：Chrome 的视口和整页均在约 5 秒后返回超时；Edge 视口超时，整页约 2.5 秒成功。截图超时后仍能读取 DOM、点击和释放，标记会恢复，MCP 会话仍可用。因此不能承诺所有 13 个工具在后台始终成功。扩展没有调用 `Page.bringToFront`、激活标签页或置顶窗口 API。

隐藏页面的原生点击在本次测试中有的需要约 5 秒返回，虽未改变前台窗口，也不等于零延迟。后台优先走语义树和文字观察；截图错误后不自动切页或重放动作。

## 13 个工具的能力边界

表内工具均带 `browser_` 前缀；Nosis 中完整前缀为 `mcp__browser_bridge__browser_`。

| 工具 | 已验证 | 返回重点与限制 |
|---|---|---|
| list_browsers | 同时发现 Chrome、Edge 实例 | `browsers[]` 含实例/运行 ID、family、profile_name、capabilities；只发现连接的配置，不扫描安装列表 |
| list_tabs | 已打开标签页、标题、URL、活动状态、控制状态 | 不读取正文；浏览器内置页可列出，HTTP(S) 才允许接管；大量标签页可能触发 Nosis Artifact |
| claim_tab | 精确身份匹配、重复接管、两客户端互斥 | 返回 `tab_handle` 和 `activation_requested:false`；标题/URL 不一致拒绝，其他会话不能复用句柄 |
| release_tab | 释放与过期句柄报错 | 不关闭网页；解除调试与接管标记；连接关闭也释放本连接拥有的页 |
| snapshot | 主页面/同进程 iframe AX、引用失效、节点/文字预算 | `snapshot_id`、带 ref 的语义树、viewport、`truncated` / 原因、`omitted_frames`；跨进程 iframe 无法读取时显式报告 |
| read_text | 主页面中文、长度截断、非法参数拒绝 | `text` / `truncated`，默认 20000、可选 1–100000 字符；不是完整 HTML，也不承诺读取所有 iframe |
| click | ref 与截图坐标换算点击、同进程 iframe、计数器验证 | 拒绝过期 ref、坐标缺失/越界、ref 命中元素被遮挡；ref 模式尝试将元素滚入视口；坐标模式按命中位置点击，不作语义目标保证 |
| fill | 中文、textarea 换行、contenteditable、可信 input 事件 | 禁用、只读、number 输入拒绝；输入但不自动提交；不提供下拉框/上传 API |
| press_key | Control+A、Backspace、非法键拒绝 | 使用页面当前焦点，有限按键/组合键；不是 Windows 全局快捷键或任意系统输入 |
| scroll | 后台内部滚动容器，before/after 实际位移 | `method:dom_scroll`、`scope:element/document`、before/after；不模拟 wheel 处理器或 Canvas 缩放，跨源 iframe 内滚动不支持 |
| navigate | HTTP 导航、导航后旧 ref 失效、标记自动恢复 | 返回导航结果，需重新观察；拒绝 javascript 等协议，不等待网站业务流程完成 |
| handle_dialog | confirm 取消、prompt 中文提交、无对话框时拒绝 | 处理页面 JavaScript 对话框；动作可能已执行后才报告弹框，须观察并处理；不处理原生文件/权限窗口 |
| screenshot | 双浏览器视口/整页 PNG、标记包含/排除、缩放映射 | 文字元数据 + PNG 图片块；后台可能 5 秒超时，整页上限为 4000 万 CSS 平方像素；不是操作系统窗口截图 |

部分输入动作会使网页出现 JavaScript 对话框。此时工具返回错误说明“动作可能已执行”，下一次 snapshot 可以读取对话框，再用 handle_dialog 处理；不得把工具错误一律当作动作未执行并直接重试。

AX 覆盖测试包含同源 `127.0.0.1` iframe 和跨源 `localhost` iframe。后者在此 Chromium 配置下位于另一进程，已列在 `omitted_frames`，没有伪造语义树或静默漏报。隐藏页面的 scroll 事件处理器可能延后；滚动工具直接返回读取到的实际 scrollTop/scrollLeft。

## 接管和点击标记

页面右上角绿色机器人 + “Agent 已接管”，当前标签页扩展按钮 `RUN`；点击位置显示橙色光标和圆环约 1.2 秒。标记通过独立 JS world 和关闭的 Shadow DOM 绘制，`aria-hidden` / `inert` / `pointer-events:none`，不拦截输入、不进入读取到的正文或 AX 树。页面本身仍可能检测到标记宿主 DOM；这不是不可见的隐蔽控制机制。

显式释放清除标记和导航注入脚本；浏览器停止调试时页面标记约 9 秒租约过期，定时器受后台调度影响。截图默认排除标记，`include_indicators:true` 可显示。像素检查验证两浏览器预览中有绿色标记、干净截图中没有；截图失败后的恢复也有回归测试。

- [Chrome 标记预览](test-results/boundaries/chrome-indicators.png)
- [Edge 标记预览](test-results/boundaries/edge-indicators.png)
- [Chrome 干净截图](test-results/boundaries/chrome-clean.png)

## Nosis 数据形态

真实环境：Nosis 的 MCP SDK 2.2.0、`McpConnection`、`_adapt_result_media`、`ToolResultNormalizer`。运行时桥接代码没有导入 Nosis；只有独立集成测试脚本导入这些模块。

普通工具在 MCP 线上返回单个 JSON 文字块：

```json
{"content":[{"type":"text","text":"{\"filled\":true,\"observe_again\":true,\"tab_id\":123,\"tab_handle\":\"...\"}"}],"isError":false}
```

示例仅说明外层，不保证所有工具拥有相同内部字段。保留标准 MCP 内容块有利于其他客户端兼容；需要程序读取时对 `content[].text` 做 JSON 解析。没有重复的 `structuredContent`，也没有把页面正文无条件塞入初始上下文。

截图返回文字元数据 + `ImageContent`。元数据包含 tab_handle、标题/URL、活动状态、CSS 视口、滚动位置、PNG 实际尺寸和映射：

```text
viewport_x = image_x * scale_x + offset_x
viewport_y = image_y * scale_y + offset_y
```

实测设备缩放 1.5，CSS 视口 1707×842 对应 PNG 2561×1263；不能直接拿 PNG 像素当点击坐标。整页截图视口外的点应先滚动，随后重新截图/取快照。

Nosis 将图片保存为附件并转为 `ImagePart`，文字块保留元数据和附件路径。13 个代表性成功样本均内联，最大 Nosis 结果为 6536 字符；文字中没有 PNG base64。另构造超大正文验证 Nosis 自动写入 Artifact，未绕过其预算。

实际 stdio 连接调用过期句柄时，MCP `isError` 被 Nosis 转为 RuntimeError，模型错误结果为：

```json
{"ok":false,"error":{"type":"RuntimeError","message":"Error executing tool browser_read_text: Tab handle is absent, expired or belongs to another MCP session; list and claim again"}}
```

当前错误类型由 Nosis 统一包装为 RuntimeError，消息提供恢复建议，未设计稳定的业务错误码。对当前模型交互合理；如果将来做程序化重试，应增加明确错误码及“结果是否未知”字段，再建立重试策略。

原始数据：[调用与边界记录](test-results/boundaries/results.json)、[Nosis 数据与图片检查](test-results/boundaries/nosis-data.json)。这些文件可能含本机标签页标题/URL，不应不经脱敏公开。

## 本机配置和复验

两个浏览器均已加载最终扩展。扩展目录没有以下划线开头的临时文件；此前阻止加载的测试文件已清理。Nosis 配置更新为 `python -u -m browser_bridge.mcp_server`，仍保持 session 所有权和原审批配置，配置修改前已备份。重启 Nosis 后读取新的工具定义，无需再次重载浏览器扩展。

```powershell
cd F:\BrowserBridge
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/controller.test.mjs
.\.venv\Scripts\python.exe scripts/live_smoke.py
.\.venv\Scripts\python.exe scripts/verify_boundaries.py
F:\Nosis\.venv\Scripts\python.exe scripts/check_nosis_data.py --nosis-root F:\Nosis
```

后台焦点测试会创建并切换本地观察页；运行期间若用户切换窗口，焦点断言可能失败，应结合记录中的前后窗口身份判断。测试结束释放控制并关闭本地 HTTP 服务，保留测试标签页供用户自行关闭。

## Nosis 启动失败修复（2026-10-20）

用户报告 `MCP browser_bridge 不可用：Connection closed`。通过正在使用的 Nosis 常驻 Broker 复现，底层错误是读取配对文件时的 `FileNotFoundError`，MCP 在初始化期间退出。该子进程收到的中文路径正确，但对 `%LOCALAPPDATA%\BrowserBridge` 的存在检查返回 false；从本次开发工具直接启动时，同一路径返回 true。路径乱码来自 GBK 日志的显示解码，不能把它当作路径被改坏的证据。具体文件系统隔离来源未进一步确认。

配对配置已迁至 `F:\BrowserBridge\.local\config.json`，保留原密钥、端口和扩展 ID；此目录设为私有权限并忽略版本管理。MCP、setup 默认路径、通用 MCP 配置和 Nosis 配置均已更新。原 AppData 配对副本保留，正在运行的旧 Hub 暂时仍向旧日志写入；下次 Hub 启动使用新路径。

修复验证包括：

- 使用 Nosis 实际保存的配置，通过它正在使用的常驻 Broker 建立新会话，状态从 `connecting` 到 `ready`，工具数 13，查询返回 Chrome 和 Edge。
- Nosis GUI 的 `/api/settings` 读取到新 F 盘配对路径。
- 重新执行 Nosis SDK / 图片 / Artifact / 错误转换检查和 7 项 Python 测试，均通过。
- `scripts/check_nosis_data.py` 已改为读取真实保存配置，并增加常驻 Broker 检查，避免只测绕过 Broker 的直接启动。

Nosis 源码和浏览器扩展代码未因本修复修改，无需重载扩展。重启 Nosis 以重建此前已经标记为不可用的会话连接即可。
