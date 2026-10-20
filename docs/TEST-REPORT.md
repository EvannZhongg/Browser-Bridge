# 验证报告

当前源码基于 **0.6.0**（2026-10-21，含诊断合并、描述精简与 click 就绪检查修复，尚未发布）。逐项设计判断见 [交互能力评估](INTERACTION-REVIEW.md)，日志合并理由见 [架构说明](ARCHITECTURE.md#诊断模型)。历史版本的验证记录可在 git 历史中查看。

## 自动测试

`npm test`：**110 项通过**。覆盖：

- 独占所有权、Origin / Bearer / 配对校验、连接断开的 claim 清理。
- ref / cursor 失效、分页不丢尾部、节点与字符双预算、超长节点报错。
- 可操作性等待：持续移动时不派发输入、派发后结果未知、超时后队列可继续使用且不重放。
- 键盘：F1–F12、Insert/Delete、导航键、全部 ASCII 可打印字符、US 标点的 key/code/Shift 映射、`+` 与 `Control++`、修饰键不插入文本、无效组合拒绝。
- 滚动：DOM 默认模式、wheel 参数与坐标、超时语义。
- 会话：递归附着 / 清理、重复 requestId 与 executionContextId 隔离。
- 快照、导航等待与观察预算、上传校验、选项卡分组恢复与回滚、Nosis 配置生成。
- 严格 CSS/XPath 的歧义拒绝、每次重定位、文档坐标滚动与视口换算、按 tab_id 接管及可选身份约束。
- 求值结果缓存续读不重放、字符串转义/Unicode 拼接、对象项预算不足后续读、捕获裁剪标志、主文档失效、释放后迟到结果不复活。
- 导航只重试瞬时观察一次；字段 value 分页、Monaco / CodeMirror 5 适配分支及不支持编辑器明确拒绝。
- 统一 `browser_logs` 的必填 kind、过滤条件互斥、19 个工具发现、旧命令拒绝、独立续读和淘汰状态；网络流量不能淘汰控制台消息。
- click 对后台、hidden、未聚焦窗口及 discarded/frozen 状态零派发拒绝；无响应检查在 500 ms 结束、迟到结果不点击、准备中失焦再次检查、激活恢复、显式后台 DOM 模式、hasFocus=false 的 iframe 导航边界。
- span/button、Shadow host、slot 的命中祖先提示与禁用状态，不改变实际命中节点。

`npm run test:package`：在仓库外含空格路径安装 tgz，复制稳定扩展目录，从包内启动 stdio MCP 并确认 **19 个工具**、仅有统一日志工具且无旧名称；`prepack` 检查拒绝配对密钥与 `config.generated.js`。

## MCP 描述精简

通用调用规则集中到初始化 `instructions`，工具 description 保留自身用途与差异，参数专属限制写在 schema，完整边界和示例保留在使用指南。通过 SDK 客户端初始化握手确认 instructions 可接收，并逐项比较 19 个工具：去除 description 字段后，名称及 schema（类型、枚举、范围、必填项、默认值）完全一致。

| 测量范围 | 调整前字符数 | 调整后字符数 | 减少 |
|---|---:|---:|---:|
| click/evaluate/navigate/fill/press_key 描述合计 | 2606 | 1105 | 57.6% |
| instructions + 全部工具 description | 8308 | 5328 | 35.9% |
| 序列化 `{instructions, tools}`（含参数 schema） | 17338 | 14390 | 17.0% |

这些数值为描述精简轮的字符数，不是 token 数，测量点早于后续 click 就绪规则补充。该轮只调整元数据和文档，不改变执行逻辑；当时复跑 103 项测试与仓库外安装包验证，没有为文字调整重复运行实机交互。

## 真实浏览器

使用临时 profile、独立配对扩展与本地 fixture，经完整扩展 → Hub → stdio MCP 链路执行：

- Chromium 156 与 Edge 155 各 **191 次**真实工具调用，全部通过（2026-10-21 使用 click 就绪检查修复后的源码扩展复跑）；发现列表为 19 个工具。
- 新增后台 native ref/selector/坐标点击在 30 秒输入预算下快速失败、没有点击副作用，显式 DOM 模式可用，activate_tab → snapshot → click 恢复成功；实际命中 span 时 clickable_target 指向 button。
- `browser_logs` 的 console/network 分支、返回 kind、分页过滤、弹窗打开时读取、跨导航保留和 OOPIF 日志；旧日志工具不再出现在发现列表。
- CSS/XPath 视口外点击、文档坐标自动滚动、命中 tag/text/clickable_hint、重复 selector 操作，以及 OOPIF 内明确 frame_id 的 click/fill。
- textarea/input 完整 value 与 offset 续读、成功 evaluate 的缓存分页只执行一次、对话框原始类型/acceptance 元数据。
- 键盘：F8 / Insert / PageUp 的可信 keydown，Shift 标点实际输入。
- 滚动：DOM 滚动不触发 wheel 处理器；显式 wheel 收到正确的可信 `deltaX` / `deltaY`，含 OOPIF 内的事件。
- 点击、填充、单 / 多文件上传、隐藏 input、`showPicker`、Unicode / 空文件、清空、对话框继续通过。
- OOPIF（`--site-per-process`）：快照与 ref、顶层坐标点击、原生 / DOM 填充、焦点键盘、右键 / 中键 / 双击 / 修饰键、拦截 chooser 上传、子 session 日志、子 frame 导航及父页面遮挡拒绝。
- 标签组独立交互测试已在 2026-10-20 验证：无标题红色分组、导航保持、释放恢复用户分组、MCP 断连恢复、固定标签提示；本轮相关单元回归继续通过，没有重跑独立交互脚本。

2026-10-20 并行运行两套浏览器时曾出现一次 OOPIF 点击未收到可信回执，工具按设计报告"结果未知"并停止，没有重放输入；随后在独立 profile 中复跑通过。本轮 Chromium / Edge 并行回归均通过。原生输入仍受浏览器渲染与输入状态影响，超时不等于动作未发生。

本轮另以 `--headless` 复跑 Chromium `--regressions` 和 Edge 完整交互脚本：后台点击拒绝实测为数毫秒且计数为 0，前台、缩放、Shadow DOM、hover 目标变化与导航继续验证。持续动画按 compositor 时序可能通过稳定性检查后成功，也可能在派发前拒绝；测试不允许把未知结果或重复效果当作成功。Headless 多窗口不一定产生真实遮挡，因此按可观察窗口焦点/文档可见性判断预期，没有声称复现操作系统遮挡渲染。

首次有界面运行时系统未给测试窗口前台焦点，原生 click 明确返回 TAB_NOT_READY、未派发；该次不计为完整交互通过。系统禁止程序切换焦点时仍须用户恢复窗口。无响应和真正失焦的快速拒绝另有受控单元测试覆盖。

## Nosis 端到端

在 0.4.0 完成并通过。2026-10-21 未重跑 Nosis GUI 端到端；本轮 schema 与部分结果结构已变化，需要客户端重新发现工具，不以历史 GUI 记录替代本轮兼容性验证：

- 0.4.0 历史记录：运行中的 Nosis GUI（`127.0.0.1:8737`）经真实 Bridge / Runtime / MCP 启动链报告 `browser_attach` ready、`tool_count` 20。
- 0.4.0 历史记录：通过 Nosis ToolCatalog 调用全部 20 个工具、34 次成功调用，覆盖截图到模型消息的图片适配、`isError` 后连接继续可用、失效句柄与 JS 弹窗错误路径。

当前源码为 **19 个工具**；更新扩展、重启 Hub/MCP 后需重新跑 Nosis 端到端。

复跑方式见 [Nosis 集成](NOSIS-INTEGRATION.md)。

## 已知限制

- 未覆盖：独立 worker / service worker、WebSocket 消息、`window.showOpenFilePicker()`、目录上传、下载管理、透视变换 iframe。
- 后台截图可能因浏览器暂停渲染而在 5 秒后超时；原生菜单与标签拖动可能抑制输入。
- readiness 是派发前的保守条件，不保证 compositor 或业务处理；输入真正派发后丢失可信回执仍报告 Outcome is unknown，不把“没观察到效果”当作零效果证明。
- 计时数据仅代表本机 fixture，不构成对任意网站的耗时承诺。
- `target_verified` / `delivery_verified` / `value_verified` 只证明事件送达或文本写入，不代表业务完成。
- Monaco / CodeMirror 5 分支通过接口级测试；未针对第三方生产编辑器或 React/Vue 的具体版本做站点验收。dirty 状态、后台 job 与超时任务续接未实现。

## 复跑

```sh
npm test
npm run test:package
npm run test:live -- --executable /path/to/chromium --family chromium
npm run test:interaction -- --executable /path/to/chromium --family chromium
npm run test:interaction -- --tab-indicators --executable /path/to/chromium --family chromium
```

真实浏览器测试需要一个允许命令行加载扩展的 Chromium / Edge 可执行文件，并只操作临时 profile 与本地 fixture。原始结果保存在被忽略的 `test-results/` 目录（`unit-*.txt`、`package-*.txt`、`live-*.txt`、`npm-live-*.json`、`nosis-*.json`）。
