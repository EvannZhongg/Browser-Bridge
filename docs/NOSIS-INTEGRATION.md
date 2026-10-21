# Nosis 集成

BrowserAttach 是标准 stdio MCP，也可以通过 `setup --nosis` 直接写入 Nosis 的用户配置。

## 写入内容

```sh
browser-attach setup --nosis
```

该命令在完成普通配对后，备份并更新 `~/.nosis/agent_config.json`（备份名为 `agent_config.json.browser-attach-<时间戳>.bak`），写入：

| 字段 | 值 |
|---|---|
| 服务器名 | `browser_attach` |
| `command` | 执行 setup 的 Node 可执行文件绝对路径 |
| `args` | 当前包 `bin/browser-attach.mjs` 绝对路径、`mcp`、`--config <绝对配对路径>` |
| `env.BROWSER_ATTACH_HOME` | 配对文件所在目录 |
| `startup_timeout_seconds` / `call_timeout_seconds` | `20` / `60` |
| `tools.approval` | `always` |

同时会设置 `mcp.enabled = true`。命令与配对路径都固定为绝对路径，因此本机安装位置变化后需要重新执行 `setup --nosis`；请从长期保留的位置安装，而不是临时解压目录。

重启或重建 Nosis Runtime 后重新发现工具。

## 自定义运行目录

Windows 默认目录是 `%USERPROFILE%/.browser-attach`，避开打包应用与普通宿主可能重定向到不同实际文件的 AppData；macOS / Linux 使用 XDG 用户数据目录。`BROWSER_ATTACH_HOME` 必须是绝对目录。

已有可共享目录可直接沿用：

```sh
browser-attach setup --config /absolute/shared-directory/config.json --nosis
```

setup 会把解析后的配对路径写进配置，MCP 与 Hub 后续都显式传递同一路径，不会在不同启动环境中重新推导出第二套密钥。setup 不会搜索或自动迁移其他应用的私有缓存；已有配对请显式保留原目录。

## 验证

```sh
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family chrome
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family edge
```

脚本读取本机 Nosis 配置，通过 Nosis ToolCatalog 发现并调用全部 20 个工具，其中 `browser_logs` 分别覆盖 console/network，验证结果封装、截图到模型消息的图片适配以及 `isError` 后连接仍可用。它用 `browser_open_tab` 在选定配置中创建本地 fixture；同一 family 有多个 profile 时用 `--browser-id <精确 browser_id>` 指定，结束后释放控制。Python 仅用于该测试，不是运行依赖。

## 故障排查

- 工具结果走 MCP 文本内容，截图走标准图片内容；能否进入模型取决于宿主的图片适配、大小预算与模型能力。
- 失效句柄不能跨连接复用，错误后应重新 list + claim。
- 文件上传只在浏览器本机读取路径，内容不经过 Hub 或模型。
- 宿主把大结果保存为 Artifact 时，嵌套 JSON 长行可能被宿主的读取工具截断；这是宿主的分页行为，不能靠调大 Attach 的预算解决，也不等同于快照游标分页。
- `Connection closed` 时依次检查：宿主的 stderr、配对文件是否可见、`hub.log`、以及 Hub 与扩展的版本是否一致（版本不一致会直接拒绝连接）。
