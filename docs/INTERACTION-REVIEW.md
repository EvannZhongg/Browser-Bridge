# 交互能力评估

评估日期：2026-10-21。依据当前仓库实现及本地 fixture 验证。

## 逐项结论

| 问题 | 核实与性质 | 当前实现 | 复杂度与取舍 |
|---|---|---|---|
| 坐标必须在视口内、不会自动滚动 | 对 viewport 坐标成立，是避免坐标含义变化的保守策略；原生 ref 点击已经调用 scrollIntoViewIfNeeded | 支持 coordinate_space=document，滚动顶层文档并换算到视口；默认使用 viewport | 低。嵌套容器、布局重排仍用元素定位，避免叠加自动猜测坐标系 |
| 无 CSS/XPath，evaluate 后 ref 失效 | 缺少可复用查询是能力缺口；ref 实际保存 backendNodeId/frame/session，操作时重新 resolve，并非持有瞬时 JS 句柄。求值后主动清空观察是有意策略 | click/fill 接受 selector、selector_type、frame_id，每次严格重新解析，恰好匹配一个元素；ref 仍随观察失效 | 中。独立 locator 模块，不把 ref 偷换成同名元素搜索，ref 不作为跨观察的长期身份 |
| el.click 打不进 React/Vue 事件 | 表述过于绝对；HTML click 可触发通常的框架 click 监听，但缺少可信指针序列和用户激活。字段直接赋 value 才常见框架不同步 | fill(dom) 使用原型原生 setter + input/change，并提供 selector 路径 | 低。不提供重复的 framework mode，不触碰框架私有 tracker；富文本仍可能需原生输入或专用 API |
| 没有多步脚本 | 部分成立：evaluate 已 await Promise，async IIFE 能执行多步 JS；不能调用原生 MCP 输入，也不是可恢复工作流 | 支持多步 IIFE 示例、30 秒硬上限与检查点拆分 | 文档成本低；通用 run(steps)/后台执行器会引入部分成功、队列、取消与未知结果恢复，当前不加入 |
| evaluate 截断不可控、半截 JSON | 转义后超预算时不能返回不完整 serialized_preview | 返回有界缓存结果，数组按项、对象按键值对、字符串按片段续读；报告 capture_truncated 和预算不足 | 中。每标签一份缓存，无持久化、无任务状态机；单个嵌套项不递归分页 |
| 长 evaluate 超时、状态不明 | 超时保护必要；异步 JS/网络不保证随工具超时取消。该边界需在工具发现和使用文档中突出 | schema 描述、错误与文档明确 max 30s、不要重放、按检查点拆分；结果游标不冒充任务续接 | job 化复杂度高。必须另外设计运行中状态、导航失效、取消与副作用语义，当前保留明确限制 |
| 参数边界反直觉 | evaluate/snapshot 的 1000 字符下限无必然依据；日志的元数据预算有独立约束 | evaluate/snapshot max_chars 下限为 1，snapshot max_nodes 下限为 1；边界错误带允许范围，放不下完整项会提示实际预算 | 低。日志仍为 1000..100000，使用指南单独说明；不强求不同结构统一预算 |
| 点击成功不代表正确目标 | 原生点击已做命中、遮挡和可信事件送达校验，不能说只有 CDP 成功；坐标仍无法表达业务意图 | hit_target 包含 tag/text/role/disabled/clickable_hint；application_result=not_checked | 低。DOM 变化、网络请求仅有相关性，后台轮询也会产生信号，不将它们包装成点击业务成功 |
| 框架 dirty / 对话框默认按钮不可观测 | 通用 dirty 无跨框架标准；注册 beforeunload 不等于未保存，未注册也不等于已保存；协议不提供原生默认按钮焦点 | handle_dialog 返回处理前类型、消息、默认 prompt 和 accepted；default_button=null。明确 beforeunload 只在实际打开时观察 | 低。没有给出“干净”假保证；任务需要保存确认时应检查站点保存标志或业务接口 |
| 虚拟化编辑器只能读到视口 | read_text 读取 body.innerText，无法保证虚拟化全文，是能力缺口 | 提供 visible/text_content/value/editor，selector 选择字段/编辑器，offset 续读；支持页面公开的 Monaco / CodeMirror 5 模型，报告 complete_source | 中且受控。未知编辑器报错；不扫描内存、猜测模块或依次滚动拼接“全文”，站点特殊情况用显式适配 |
| claim 必须精确 title/URL | 是主动身份校验策略，但对计数、通知、保存状态导致的标题漂移过于严格 | 已列出的 tab_id 可以单独接管；expected_url/title 为可选精确约束，扩展返回当前身份 | 低。不取消独占、连接归属、最近列表和浏览器实例隔离；需要身份约束时仍可显式提供 |
| navigate 后 observation_error 噪声 | 观察与导航分开报告是正确设计；文档/上下文切换的瞬时错误缺少有限恢复 | 只对已识别的瞬时观察错误重读一次，保留同一个 10 秒观察截止时间，绝不重放 Page.navigate | 低。权限、未知错误及预算耗尽保留错误；连续重定向仍可能需要重新 snapshot |

## 接口约定

定位参数与 mode 正交：`selector` 表示定位，`mode=native/dom` 表示输入派发方式。CSS/XPath 不跨 Shadow DOM；iframe 使用快照给出的 frame_id。selector 并非永久身份，解析后目标被重渲染替换仍会失败，并且不会自动重放。

evaluate 结果缓存上限为 1000000 个 JSON 字符、50000 个遍历节点、8 层。每页 value 上限 max_chars=1..100000，元数据另计。`next_cursor` 续读不执行脚本；新求值、主文档变化或释放清理缓存。`capture_truncated` 为 true 表示捕获阶段已有数据损失，分页不会恢复丢失部分。超大单项返回 required_chars 和游标；超过每页上限时须改变表达式的数据形状。

read_text 的 offset 是实时偏移，不是冻结快照。读取期间内容变化会影响拼接；需要一致性时，通过 evaluate 一次返回字段/模型文本并续读该次缓存。`complete_source=true` 只表示已读取所选字段或支持的模型，不证明页面其他编辑器、远程文档或业务保存状态已被覆盖。

输入准备阶段可等待；一旦派发，超时、导航、对话框或目标变化都可能留下部分副作用。命中守卫不能撤销此前已送达的 pointerdown 等事件。未知结果不重放的规则保持不变。

## 实现与验证

- `extension/locator.js`：严格选择器解析、frame/session 路由；隔离世界选择后重新解析到默认世界，避免跨世界对象比较错误。
- `extension/evaluate.js`：有界捕获、结构化截断、缓存游标与逐页预算。
- `extension/text.js`：字段/DOM/编辑器模型读取和偏移分页。
- `extension/controller.js`、`click.js`：身份约束、文档坐标、命中说明、原始 dialog 元数据与有限观察重试。
- 输入前释放上一操作的远端对象组，支持不取新快照的重复 selector 操作，避免对象句柄累积。

单元测试覆盖歧义拒绝、重新定位、预算过小后的缓存续读、求值只执行一次、缓存失效、文档坐标换算、仅观察重试和编辑器适配分支。真实浏览器通过 stdio MCP → Hub → 实际扩展链路，在临时 profile 和本地 fixture 验证 CSS/XPath、视口外点击、文档坐标、命中元数据、字段读取分页、求值续页以及既有输入、上传、弹窗和递归 OOPIF 路径。打包测试验证模块随包安装、无配对密钥泄露；当前工具数量为 19。

真实站点的框架版本、编辑器封装和服务端保存结果仍须按具体站点验证。

## 后台 click 与命中提示

后台/未渲染页面的原生点击需要派发前的 renderer 就绪条件；缺少该条件时，Input 可能在发送后等到回执超时。不能把派发后的 Outcome is unknown 改成“肯定没效果”。部分 Chromium 后台页面本来就能成功接收 CDP 输入，因此“后台必定零效果”也不能一概而论。

当前采用保守的派发前快速失败：准备前及派发前分别检查 active、discarded/frozen、窗口 focused/minimized 与文档 visibility，每次最多 500 ms，合用总输入预算。返回 TAB_NOT_READY、明确未派发及 activate_tab → snapshot → click 提示；不自动 bringToFront。显式 activate_tab 才请求窗口聚焦和 renderer 前台化。这会拒绝一部分原本可能成功的后台点击，以换取可预测的调用路径。

实测聚焦 iframe 导航后，document.hasFocus() 可以为 false，而主 tab 仍 active/visible 并能接受可信点击。因此读取并返回该信号用于诊断，但不单独用它拒绝操作；窗口焦点由浏览器 API 判断。就绪检查通过也不能排除派发瞬间切换标签或原生菜单捕获，故派发后的不确定性规则仍保留。有界前置检查的迟到响应不会继续进入点击派发。

命中提示沿父元素、Shadow host 与 slot 找到最近候选，将其放入 clickable_target，保留 hit_target.tag 等实际命中信息，不重定向真正的输入。hint=false 仅表示没有识别出 HTML/ARIA 候选，不能据此认定没有 JS 事件监听或一定不可点。

实现为一处共享的有界就绪检查、两个检查边界和祖先遍历；没有后台任务、自动重试或焦点抢占策略。验证覆盖未活动 tab 的三种定位方式、明确零派发、500 ms 无响应上限、迟到结果、准备中失焦、显式恢复与 span/button 提示。
