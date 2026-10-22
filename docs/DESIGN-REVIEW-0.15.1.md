# 0.15.1 工具效率与设计取舍

本次对照 `src/mcp.mjs`、`src/hub.mjs`、扩展实现与现有测试核查九项建议。结论是：返回内容和失败诊断存在可直接改进之处；等待、显式 frame、接管和输入结果边界主要是有意的可靠性策略。不能单凭一次调用的字符数或延迟判定策略有缺陷。题述 BA/PW 对照未在同一页面、版本和序列化口径下重跑，以下不把这些数值当作本次验收结果。

## 逐项判断

| 建议 | 当前实现与性质 | 通用性、复杂度及本次选择 |
|---|---|---|
| 1. 默认精简、interactive、delta | full 同时服务阅读与交互，是覆盖面策略；每页重复规则和固定诊断元数据则是输出冗余。input/evaluate 使 cursor 失效，但仍连接且语义未变的 refs 可复用，并非每次输入都必须重新 snapshot。 | 精简通用且成本低，已移除重复说明，viewport/snapshot_id 改为 verbose 可选。保留 full 默认与结果验证字段。interactive 已有，按任务选择。delta 需处理新旧观察、删除/替换、祖先上下文和子 frame 失效，复杂度高，本次不引入。 |
| 2. AX 索引查询 | 当前只能把树传给客户端后查找，确有返回量缺口；read_text 不能替代可操作 ref。 | 已在现有 snapshot 加 query，复用渲染、ref、frame 和分页，工具仍为 23 个。查询新采集 AX，不引入可能过期的第二份索引缓存。仅支持字面子串；正则及独立 find 工具暂不增加。能省返回内容和一次往返，不能保证 AX 采集变快。 |
| 3. 日志摘要与明细 | 当前已有 after_seq、limit、max_chars、level、url_contains 与有界缓冲；默认不保存 headers/body，必须显式启用 capture。网络输出是 request/redirect/response/finished 等事件，并非一条完整请求对象。 | 请求摘要具有通用价值，但正确合并需要处理 session/request_id/hop、未完成请求、分页与淘汰；单次投影也不能自然变成完整请求的耗时列表。seq 明细可复用 logs 扩展，无须先增加工具。默认隐藏静态资源会漏掉 CSS/脚本故障，本次保留，先用现有过滤与预算。 |
| 4. 零命中立即失败、诊断原因 | resolveSelector 的零命中等待是支持异步渲染和 batch 前一步创建后一步目标的明确策略；多命中和语法错误已立即失败。deadline 已保留最后的 selector/可见性/尺寸等状态。遮挡分支却只给泛化错误，属于诊断不足。 | 已补实际 hit_target、点和受阻 frame，不增加准备重试或动作重放。普通点击明确未派发；drag 已按住后的目的节点准备失败仍报告结果未知。保留零命中等待，紧预算可用 timeout_ms（最小 100 ms），只读查询零命中不等待出现。 |
| 5. deep-css、自动跨 frame | 当前 CSS/XPath 明确只解析指定文档；ref 可操作 AX 暴露的 Shadow 节点；evaluate(result_type=element) 可显式选取 open shadow 元素，frame URL/title/path 已可逐次解析。属于范围和消歧策略。 | 显式 deep-css 对组件站点可能有用，但要定义复合选择器、遍历顺序、nth 和多 root 歧义，成本中等。跨 frame 再涉及 OOPIF、重复控件、未加载/分离文档和多层命中校验，成本更高。本次保留显式 frame 与现有 ref/element 路径。 |
| 6. batch 结果传递 | 当前 batch 是预检后的有限输入序列；没有 evaluate 或 drag 步骤，element 步骤只用 selector。因此单加占位符不能实现“evaluate 测量 → drag”。这是有限编排的边界，也确有限制。 | 动态数据流需增加结果生产步骤、类型/路径检查、替换后的再校验，以及部分完成的恢复规则，复杂度中高。原生输入仍不能由页面 JS 调用。常见“定位 → 输入”已可用 selector 或 evaluate 返回元素 ref；坐标测量保留独立检查点，本次不扩展 batch。 |
| 7. tabs 一站式 | MCP 已把浏览器/标签发现合并为 discover，把 release/activate/close 合并为 tab_control。发现后按本连接观察的 tab_id 独占 claim 是授权模型，激活则是另一个显式意图。 | 客户端可保存 profile 与连接内句柄减少重复 setup。再增加 tabs 聚合入口主要重复现有分支；若自动选标签或激活，反而改变边界。本次不改。工具入口数量与必须经过的授权步骤不能简单等同。 |
| 8. 渐进披露 schema | 描述已在 0.13.1 分层精简；本次修改前实际 tools/list 紧凑 JSON 为 36701 字符、36703 UTF-8 字节，格式化 JSON 为 75945 字节，正好对应题述约 75.9 KB，23 个工具。两种序列化是同一 schema，不意味着宿主实际省掉一半 token。是否每轮重新计入、是否缓存，取决于 MCP 宿主，仓库不能保证。 | 工具分组对更大工具集有价值，但会新增启动配置、发现差异和支持组合。当前不加 caps 开关；query 复用已有工具，新增少量 schema 描述以保持自描述。包内文档链接不能替代模型调用所需的关键约束。 |
| 9. 可回放执行记录 | 当前不持久化操作轨迹；batch 调用输入本身就是可保存的步骤 JSON，输出已有部分完成、failed_step/start_at 等恢复信息。缺少长期审计是能力缺口，不是当前执行可靠性缺陷。 | 审计记录与可重新执行的计划应区分：已送达的动作不能因“可回放”自动重发，ref 也不能跨观察/连接复用。默认回传完整 steps 又与节省输出冲突，持久化还会包含表单数据。需要明确的保存/导出需求后再做显式功能，本次不新增存储或回放引擎。 |

## 实际改动

- `extension/snapshot.js`：query 在当前视图的完整 AX 名称（包括合并正文）或 value 上做大小写不敏感的字面子串匹配，只为匹配行生成 refs。复用原预算和游标；query 绑定观察，零命中返回空结果。
- `extension/controller.js`：查询仅输出有匹配行的 frame 标题；仍报告不可读或失效的 frame。每个新查询沿用新快照的采集与 ref 生命周期，续页不重复采集。
- 快照默认不再输出 viewport、snapshot_id 和重复说明；verbose 可恢复前两项。保留 profile/text/text_limit、frame 覆盖与分页字段。click/evaluate 的事件送达、分页或捕获损失等语义字段继续保留。
- `extension/click.js`：当前 frame 直接复用已有命中诊断；祖先 frame 最多额外读 200 ms，失败时保留原遮挡错误。读取预算已派发标记，防止复用准备逻辑的 drag 被误标为“无输入”。
- 版本按本次明确要求设为 **0.15.1**。没有新增工具、运行依赖、扩展权限、用户 UI、自动重放或独立状态管理层。

使用示例和边界见 [使用指南](USAGE.md)，验证结果见 [验证报告](TEST-REPORT.md)。
