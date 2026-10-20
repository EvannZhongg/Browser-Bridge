# BrowserAttach 点击、快照与导航复核

日期：2026-10-20。当前正式实现为 0.3.0；以下先记录已完成的修复，再保留 0.2.0 的基线分析。工具集合仍为 14 个，无旧版兼容层。

**0.3.0 已完成**

- 点击：move/down/up 连续按序派发，明确 buttons 状态，标记绘制退出输入关键路径；可见/启用/稳定检查、裁剪后多边形中心点及隔离世界中的可信事件命中校验。目标在 hover 后移动 30 px 时，明确报错并阻止错误点击，不再返回 clicked。成功仅证明事件命中，业务结果仍需观察。
- 滚动坐标：DOM.getNodeForLocation 使用文档 CSS 坐标，因此加上 scrollX/Y；Input.dispatchMouseEvent 保持视口 CSS 坐标。后台滚动 500 px 后仍可点击固定定位的上传按钮并上传。
- 快照：移除 InlineTextBox、合并重复 StaticText 与纯文本列表项；默认每页 600 节点 / 24000 序列化字符，均可调整。预算耗尽时返回 next_cursor，续读保留同一 snapshot_id 和 refs，不静默丢失尾部。
- 导航：默认等待目标 loader 的 DOMContentLoaded 并返回快照、当前标题和 URL；支持 commit/load、100–40000 ms 超时及关闭附带快照。同文档导航不等待不存在的新 load。
- 本机：Hub、Chrome/Edge 扩展及 npm 命令均为 0.3.0；Nosis 配置删除已被其新架构禁止的 scope 字段。

**实测与可复现性**

scripts/interaction-smoke.mjs 在独立 Chromium 156 / Edge 155 窗口中验证后台 ref / 坐标点击、窗口失焦与遮挡、80% / 125% 缩放、动态偏移、后台填写/按键/滚动/上传、分页续读及导航。活动标签页不改变，原先失焦的窗口不被激活；可信 click 和页面计数均验证命中。

200 行列表及新增输入/上传控件合计约 206 个语义节点、约 16 KiB，一次返回全部；强制 10 节点 / 1000 字符预算时 21 页读全，第一页 ref 仍可使用。慢脚本响应延迟 1000 ms，navigate 约 1.04 秒后返回，立即即可读取 Ready 按钮、正确标题和 URL。后台静态点击耗时为几十毫秒（坐标点击更短），不是所有业务网站的耗时承诺。

原始结果：test-results/interaction-chromium.json、interaction-edge.json。自动测试、真实现有 profile 和 Nosis 数据链路见 TEST-REPORT.md / NOSIS-INTEGRATION.md。后台操作无需将浏览器置于前台，但浏览器要运行且页面未冻结；截图、原生权限 UI 及网站主动弹窗不能承诺完全静默。导航 ready 也不等于应用异步数据全部就绪。

**0.2.0 基线分析（历史行为，以下“当前”均指当时的 0.2.0）**

**结论**

| 反馈 | 判断 | 证据与边界 |
|---|---|---|
| 点击依赖前台，后台约 5 秒并静默失败 | 后台约 5 秒已复现；“必须前台”不能泛化；返回成功却未命中的缺陷另有明确复现 | 当前 Chrome 的静态按钮在后台仍 3/3 生效，但每次约 5 秒。独立 CDP 计时显示等待集中在 mouseMoved。动态目标可在可见页面失效，后台不是唯一条件 |
| ref 点击偏约 30 CSS px | 存在真实的坐标失效窗口；没有证据表明统一多乘/少乘了一个缩放系数 | 构造鼠标移入后移动 30 px 的按钮，Attach 对旧点返回 clicked，实际 pointerdown / click 落在空白处。80% / 125% 页面缩放的静态按钮没有固定偏移 |
| max_nodes 调大也无法读取完整列表 | 属实 | 200 行测试中，max_nodes=600 和 3000 都只返回 262 个输出节点、约 64 行，truncation_reason=text_budget，包含 65 行 InlineTextBox |
| navigate 异步，需要额外观察 | 属实 | 慢脚本测试中导航约 28 ms 返回；文档仍 loading，目标按钮尚未出现；立即 snapshot 同样没有目标。稍后才 complete。返回的 title/url 甚至可能仍是旧页面元数据 |

**点击：已定位的延迟与失败机制**

当前链路为：解析 ref → scrollIntoView → 获取 quad → 算中心点 → 命中检查 → 等待 mouseMoved → 等待可视标记更新 → mousePressed → mouseReleased → 更新标记 → 返回 clicked。

当前 Chrome 155 的同一配置、同一测试页面中：

| 状态 | 三次耗时 | 每次按钮计数增量 |
|---|---|---|
| active=true、页面 visible | 35 / 75 / 31 ms | 均为 1 |
| active=false、页面 hidden | 5051 / 5088 / 5149 ms | 均为 1 |

这证明后台延迟，并不证明后台必然无效。用户原测试中未观察到 clicked 文本的现象仍需解释，不能因本轮静态按钮成功而否定它；但现有证据不足以把所有失败归因于“后台不能点击”。

在独立 Chromium 156 配置中，通过扩展的原生 chrome.debugger 接口对同一后台静态按钮做对照：

| 输入发送方式 | 三次耗时 | 结果 |
|---|---|---|
| 每个事件单独 await，再发送下一个 | 5090 / 5020 / 5019 ms | 均命中 |
| 按 move/down/up 顺序连续发送，然后统一等待 | 14 / 12 / 9 ms | 均命中 |
| 连续发送，并明确 buttons 状态 | 9 / 22 / 17 ms | 均命中 |

其中一次逐命令计时为 mouseMoved 5015.4 ms、mousePressed 12.2 ms、mouseReleased 5.5 ms。该对照测量输入派发阶段，不能把 9–22 ms 直接当成完整 MCP click 的承诺。没有通过切换前台或更换网页取得这个差异，也没有用 DOM click() 替代原生输入。

Playwright 的普通无 delay 点击同样采用按顺序发出 move/down/up、最后 Promise.all 等待的方式。Attach 应优先借鉴这一点，并把标记绘制移出输入序列的关键路径。这是已通过对照的优化方向，仍需结合模态、导航、文件选择器和实际命中回归后再正式落地。

另一个已经复现的失败与坐标计算后的竞态有关：

1. 按钮最初位于 x=200..240，其中心是 (220,220)。Attach 在这个点做命中检查。
2. mouseMoved 触发 mouseenter，按钮右移 30 px，变为 x=230..270，新中心是 (250,220)。
3. Attach 仍在 (220,220) 按下并释放。页面记录 pointerdown、pointerup、click 的 target 均为空白元素，按钮计数保持 0。
4. 工具返回 clicked=(220,220)，没有说明目标未命中。

这准确证明缺少事件时刻的目标检查。单纯修改 DPI 或加 30 px 补偿既没有依据，也会破坏正常页面。ref 点击使用 DOM quad 的 CSS 坐标，不经过 PNG 像素到视口的换算；本轮静态缩放测试的事件点与按钮中心吻合。

值得落实的点击优化：

- 原生输入连续派发并统一等待，给 buttons / modifiers 一致的状态；可视标记不阻塞输入。
- 操作前检查 enabled、visible、stable、inert 与当前目标；对可见 quad 裁剪后选点，而非只检查完整 quad 中心。
- hover 后重新确认几何与命中，或建立事件时刻的目标拦截/反馈机制，检测“检查时正确、按下时错误”。
- 结果明确区分已派发、目标命中与业务完成。不能用“没有 DOM 变化”自动判失败，也不能把 CDP 响应等同于业务成功。
- 超时或输入结果未知时明确报错并重新观察；不要自动重放可能已经提交的动作。

源码：[Attach 点击](../extension/controller.js)、[Playwright Mouse.click](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/server/input.ts#L262)、[动作前检查](https://playwright.dev/docs/actionability)、[事件命中拦截](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/injected/src/injectedScript.ts#L1154)。Playwright 的命中检查也不等于验证任意网站的业务结果。

**快照：需要改善有效信息量与完整性**

Attach 的 14,000 字符限制作用于每行 JSON 序列化后的累积大小，独立于 max_nodes。实际 snapshot 文本约 13,200 字符就可能触发它，因为引号、反斜杠等占用转义预算。它不是“固定最多 50 行”；本轮为第 64 行，具体取决于文本长度和原生 AX 树结构。

当前代码将未被 ignored 的原生 AX 节点几乎逐个输出，其中包括 ListMarker、StaticText 和 InlineTextBox；同一段文字可能出现多次。Playwright 的 ARIA snapshot 是面向语义元素的 DOM 遍历与归并，移除等同于父名称的重复子文本，因此更紧凑。“207 个 ref”与原生 AX 输出节点数不属于同一个统计口径，但可以比较是否完整覆盖这 200 行。

建议在同一个 browser_snapshot 中优化：

1. 默认语义压缩：去掉 InlineTextBox 这类布局细节；合并重复文本，同时保留独立正文、列表次序和关键控件状态。
2. 提供可调字符预算，明确报告节点预算、字符预算、实际覆盖情况；不应把宿主的某个预算当作无法调整的常量。
3. 支持范围与续读，例如 root/ref、frame 或分页游标。截断后必须有取回尾部的路径，不能只返回 truncated=true。
4. 大结果交给宿主 Artifact 前，还需保证宿主能分页读取该表示；单纯把硬预算调大，可能只是把问题移到模型上下文或 Artifact 长行。

这些都不需要新增“查询列表”“读取下一屏”等一批工具。先对 200 行普通列表建立完整覆盖回归，再测试长文本、大 DOM、iframe、表格和重复标签。

源码：[Attach 预算](../extension/controller.js)、[Attach 原生 AX 渲染](../extension/controller.js)、[Playwright ARIA snapshot](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/injected/src/ariaSnapshot.ts#L98)。

**导航：等待与观察可以合并在现有工具中**

当前 Page.navigate 返回后就结束，没有等待 DOMContentLoaded / load，也不返回新快照。因此“navigate + snapshot”只是一种手动工作流，并非保证两步就能拿到就绪页面。本轮立即 snapshot 仍过早。

本机对照使用的 @playwright/mcp 0.0.83 会等待 domcontentloaded，并设置本次响应包含 snapshot。Playwright Library 的 page.goto 默认等待 load；不能把 Library 和 MCP 的默认值混为一谈。

建议给现有 browser_navigate 增加 wait_until、timeout_ms 和 include_snapshot：默认等待 DOMContentLoaded，返回当前 URL/title 和新快照；仍允许调用者显式只等 commit 或不带快照。用 loader/frame 生命周期绑定到这一次导航，处理跳转、同文档导航、加载错误与超时，避免等待到旧文档或其他 iframe 的事件。

DOMContentLoaded 只表示文档解析完成，不能证明 SPA 数据全部就绪。业务就绪应使用明确条件，不应为所有网页固定 sleep，或默认等待所有网络永久空闲。

源码：[Attach navigate](../extension/controller.js)、[Playwright MCP 导航等待](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/tools/backend/tab.ts#L348)、[导航响应含快照](https://github.com/microsoft/playwright/blob/58b93301d906b77a3854bc4d8ff4130f00a808ae/packages/playwright-core/src/tools/backend/navigate.ts#L20)、[page.goto 文档](https://playwright.dev/docs/api/class-page#page-goto)。

**优先级与测试结论的使用方式**

优先级建议为：P0 点击延迟及错误成功反馈、目标稳定性与实际命中；P1 快照语义压缩与尾部可达；P1 导航等待并附快照。优先修正现有操作的可靠性与观察质量，不增加 MCP 工具数量。

原始 benchmark 的 Playwright 是独立 headless 浏览器，Attach 接入的是当前用户浏览器；Playwright 默认启动参数还会调整部分后台节流行为，两边运行环境并不完全一致。当前 Playwright MCP 的动作包装默认还有约 500 ms settle 等待和快照输出。因此 604 ms 与 Attach 的事件派发耗时不是同一层级的度量。应分别比较传输、页面操作、就绪等待、快照生成，以及最后的实际页面状态。

本轮数据位于 test-results/connected-issue-probe.json 和 test-results/issue-probe-raw.json；复现脚本保存在私有 .local/connected-issue-probe.mjs 与 .local/issue-probe.mjs。临时 Chromium 扩展副本只增加计时记录，生产扩展未修改；Chrome 测试只操作新建本地页，结束后已释放控制，测试标签页保留。
