# Nosis 接入诊断与工具数据传递分析

日期：2026-10-20。分析对象为 F:/Nosis 的当前实现、用户目录 .nosis 中的实际配置，以及正在运行的共享 MCP Broker。已修复连接配置；本次没有修改 Nosis Core 或增加 MCP 工具。

**Connection closed 的原因与修复**

实际路径是：Nosis ExecutionPlaneManager → McpClient → 共享 Broker → McpConnection → browser-bridge mcp → 本地 Hub → 浏览器扩展。

前一轮使用 Nosis 的 McpConnection 直接启动命令，遗漏了 Runtime 的常驻 Broker 路径。因此“直接 MCP 正常”不能证明正在运行的 Nosis 能够启动同一个服务。本次通过 McpClient 连接正在运行的同一个 Broker，复现为 tools=0、status=unavailable、error=Connection closed。

Broker 的 stderr 显示 BrowserBridge 启动失败：无法读取 C:/Users/钟佳瑞/AppData/Local/BrowserBridge/config.json。补充文件错误码后确认是 ENOENT。文件在当前工具进程中存在，但 Broker 启动的子进程看不到；改为直接 node 启动、显式传同一个 --config 路径，仍然失败。因此有充分证据认定为文件系统可见性差异，而不是 npm 命令解析。没有把它进一步臆测为 ACL、中文路径编码或某一种 Windows 虚拟化机制。

已将当前 0.2 配对配置迁到双方可见的 F:/BrowserBridge/.local/runtime/config.json，并重启 Hub。没有读取旧 Python 实现的配对数据，没有新增搜索旧目录或回退路径的兼容逻辑。

用户目录 C:/Users/钟佳瑞/.nosis/agent_config.json 的 browser_bridge 配置已备份并更新为：

```json
{
  "command": "browser-bridge",
  "args": ["mcp"],
  "env": {"BROWSER_BRIDGE_HOME": "F:\\BrowserBridge\\.local\\runtime"},
  "scope": "session",
  "startup_timeout_seconds": 20,
  "call_timeout_seconds": 60,
  "tools": {"approval": "always"}
}
```

本机专用的共享目录通过已有 env 字段明确指定；仓库的通用 mcp-config.json 仍没有本机绝对路径。setup --nosis 会保存显式指定的 BROWSER_BRIDGE_HOME；Windows 安装脚本按实际 clone 目录自动设置 .local/runtime，避免下次安装覆盖回不可见的 AppData 配置。

修复后，同一个 Broker 返回 connecting → ready，发现 14 个工具，并列出 Chrome 和 Edge 0.2.0。配置变化会让 Nosis 在下一次用户 Turn 重建 ExecutionPlane；无需重启共享 Broker，也不影响其他 MCP 服务。如果界面仍保留旧状态，发送下一条消息或重新打开会话即可触发新的装配。

源码依据：[Runtime 连接描述](/F:/Nosis/agent_runtime/mcp/client.py:25)、[Broker 绑定](/F:/Nosis/agent_runtime/mcp/broker.py:65)、[MCP 初始化](/F:/Nosis/agent_core/mcp/connection.py:55)、[配置变化与 Plane 重建](/F:/Nosis/agent_runtime/plane_manager.py:84)。

**数据链路与合理性**

| 数据 | 真实传递过程 | 判断 |
|---|---|---|
| 普通工具结果 | Bridge 的单份 JSON TextContent → SDK 转换 → Broker JSON IPC → McpTool → ToolResult 的 ok/output 包装 | 合理。保留标准 MCP 外层，JSON 会有字符串转义成本，但没有同时发送重复 structuredContent；无需为 Bridge 增加专用解包分支 |
| 元素 ref / tab_handle | 字符串原样传递，受 MCP 物理连接 owner 约束 | 合理。不能把另一个 MCP 连接或旧 Broker 资源的 handle 带过来使用；本次测试在同一连接中完成发现、接管、动作和释放 |
| 文件上传 | 绝对路径 → Nosis 工具参数 → Bridge 校验 → 扩展 CDP；页面读到实际文件文本 | 合理。没有把文件内容塞进工具参数、模型上下文或 Broker 日志；本次只使用新建的本地测试文件 |
| 截图 | MCP ImageContent/base64 → SDK 的 mime_type 字段 → McpTool 解码为本地附件 → ToolResult.attachments → ToolBatch 的 tool_media 消息 → Provider image_url | 合理。base64 在 MCP/IPC 传输中存在，但不进入普通 tool 文本和 Session 文本；在最终 Provider 请求格式中才再次编码图片 |
| 工具错误 | MCP isError → McpConnection 抛出 RuntimeError → ToolSet 生成 ok=false/error → Normalizer | 合理。工具错误不会被伪装为成功，也不会自动标记整个 MCP 连接断开；失效 handle 后下一次 list_browsers 仍成功 |
| 超出 32 KiB 字符预算的结果 | ToolResultNormalizer 保存完整 Artifact，给模型返回路径、preview 和 read_instruction | 保存机制合理，但嵌套 JSON 的大文本存在分页缺陷，见下文 |

本次也简化了 Bridge 的错误 TextContent：直接返回可读错误文本和 isError=true。此前 JSON 包装的 error 又被 Nosis 放进 error.message，形成不必要的嵌套字符串转义；现在保持 MCP 和 Nosis 各自的错误语义，省去多余包装。

源码依据：[McpTool 与图片适配](/F:/Nosis/agent_core/mcp/tool.py:56)、[ToolSet 执行与错误转换](/F:/Nosis/agent_core/tools/catalog.py:111)、[ToolResult 包装](/F:/Nosis/agent_core/tools/base.py:137)、[tool_media 消息](/F:/Nosis/agent_core/tool_batch.py:232)、[Provider 图片编码](/F:/Nosis/agent_core/providers/base.py:408)。

**已经证明的边界与待改进项**

1. 超大 JSON 正文的 Artifact 不能保证完整分页读取。测试页提供约 4.8 万字符、350 行及尾部 TAILMARK。browser_read_text(max_chars=100000) 能返回完整正文，Artifact 文件也保留尾部，但 Nosis 将 MCP TextContent 中的 JSON 再次序列化：正文成为转义后的一个长行。连续按 read_file 的 offset 提示读完 3 页后，该长行被截断，模型仍读不到 TAILMARK。这是通用 MCP 产物的可读性问题，不是文件未保存；普通小结果不受影响。
2. 改进应优先放在 Nosis 的通用 MCP Artifact 呈现：保留必要元数据，并让长正文成为能分页读取的文本；内联 MCP 契约保持稳定。另一种方向是增强既有读取机制对超长行的分段能力。不要为 Bridge 增加专用工具，也不要在 Bridge 中硬编码 Nosis 的预算。
3. Nosis 图片附件的内联上限是 5 MiB。Bridge 的截图像素上限和 WebSocket 消息上限不是同一个约束，不能据此承诺任意整页截图都能进入模型。当前真实截图小于此限制；5 MiB 上限由源码确认，本轮没有生成超大截图来验证拒绝分支。
4. 支持视觉的 Provider 才会生成 image_url；文本模型得到图片附件路径与能力提示。本次分别验证两种消息格式，但没有向真实模型 API 发送请求。
5. UI 的 Connection closed 不是根因说明：实际启动错误在 Broker stderr 日志。当前排障应结合两层信息；不应通过延长超时或盲目重试掩盖缺失的配对文件。

源码依据：[32 KiB 工具预算](/F:/Nosis/agent_core/tools/budget.py:18)、[Artifact 渲染](/F:/Nosis/agent_core/tool_result.py:15)、[过长行处理](/F:/Nosis/agent_core/tools/builtin/read_file.py:165)、[5 MiB 图片上限](/F:/Nosis/agent_core/media.py:30)。

**验证方法与结果**

- BrowserBridge 自动测试：27 项通过。
- Nosis 相关现有测试：79 项通过，范围为 MCP 配置/工具、共享服务、媒体消息、ToolBatch、Artifact；没有宣称运行全部 Nosis 测试。
- 新增 scripts/verify-nosis.py，在 Chrome 和 Edge 当前配置中分别通过真实共享 Broker 调用全部 14 个工具。通过 Nosis ToolCatalog/ToolSet、McpTool、ToolResultNormalizer 和 ToolBatchExecutor 验证数据，而不止检查原始 MCP JSON。
- 截图：验证附件文件、坐标映射、tool_media 来源、普通工具文本无 PNG base64、视觉 Provider 的 image_url，以及文本 Provider 的文字降级。
- 错误：验证模态动作的结果未知提示、失效句柄的 ok=false，以及错误后的连接可继续使用。
- 大正文：验证完整 Artifact 已落盘，同时显式记录 artifact_paging_limitation=true；测试退出成功只表示已准确观测该限制，不表示分页缺陷已经修复。
- 本机配置更改已实际生效；Nosis 源码未作修改。测试不涉及真实模型 API、UI 审批或互联网文件上传，只在本地 fixture 页面上操作，结束后释放标签页。

复现：

```powershell
F:/Nosis/.venv/Scripts/python.exe scripts/verify-nosis.py --nosis-root F:/Nosis --family chrome
F:/Nosis/.venv/Scripts/python.exe scripts/verify-nosis.py --nosis-root F:/Nosis --family edge
```

这是可选的 Nosis 集成测试，使用 Nosis 自己的 Python 环境；BrowserBridge 的发布运行时仍只有 Node。原始指标位于忽略版本管理的 test-results/nosis-contract-chrome.json 和 nosis-contract-edge.json。截图、测试文件与 Session 产物保存在私有 .local/nosis-validation 下。
