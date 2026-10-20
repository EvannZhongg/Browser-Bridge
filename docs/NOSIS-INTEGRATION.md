# Nosis 集成

BrowserAttach 提供标准 stdio MCP，可通过 Nosis 的通用 MCP 配置接入。先安装并运行 `browser-attach setup`，然后运行 `browser-attach setup --nosis`，自动备份并更新当前用户的 `~/.nosis/agent_config.json`。

生成的服务器名是 `browser_attach`，命令固定为执行 setup 的 Node 可执行文件，参数固定当前包的 CLI 路径和 `mcp --config <绝对配对路径>`，工具审批策略为 `always`。MCP 环境始终包含指向配对文件目录的 `BROWSER_ATTACH_HOME`。重启或重建 Nosis Runtime 后重新发现工具。

## 自定义运行目录

Windows 默认目录是 `%USERPROFILE%/.browser-attach`，避开可能在 Codex 等打包应用与普通宿主间重定向到不同实际文件的 AppData。macOS/Linux 继续使用 XDG 用户数据目录。默认路径不依赖仓库或当前工作目录；`BROWSER_ATTACH_HOME` 必须是绝对目录。

已有可共享目录可以直接使用：

```sh
browser-attach setup --config /absolute/shared-directory/config.json --nosis
```

setup 写入实际解析后的配对路径，MCP 和 Hub 都明确传递该路径；因此即使普通 GUI 与打包终端的 LOCALAPPDATA 相同但文件系统视图不同，也不会再次回到 AppData。setup 不会搜索私有应用缓存或自动迁移、合并配对数据。已有配对应显式保留原目录，避免生成另一套 key。

本机验证使用 `F:\.nosis\browser-attach\config.json`，Nosis 位于 `F:\nosis`；这是本机部署选择，没有硬编码到产品源码。生成的 CLI 路径属于执行 setup 的安装位置；重新安装或移动该位置后应再次执行 setup --nosis 更新启动配置。请从长期保留的安装位置执行，而非临时解压目录。

## 可选集成验证

运行 Nosis 自己的 Python 环境，传入实际源码目录，例如：

```sh
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family chrome
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family edge
```

该测试读取本机 Nosis 配置，发现 20 个工具，通过 Nosis ToolCatalog 执行所有操作并验证结果与图片适配。它通过 browser_open_tab 在选定的已配对配置中创建本地 fixture；同一 family 有多个 profile 时传 `--browser-id <精确 browser_id>`，不会另行启动不确定的 OS 默认浏览器。结束后释放控制。Python 仅用于此集成测试，不是 BrowserAttach 的运行依赖。

## 数据与故障排查

- 工具结果为 MCP TextContent，截图使用标准 ImageContent；截图能否进入模型取决于宿主的图片适配、大小预算和模型能力。
- 工具错误通过 MCP `isError` 返回。失效句柄不能跨连接复用，错误后应重新观察。
- 文件上传传递浏览器本机绝对路径，不通过 Hub 中转文件内容。
- 宿主可能将较大结果保存为 Artifact。若正文变为转义 JSON 长行，应检查宿主的分页和截断逻辑；不能将宿主文本预算硬编码进 BrowserAttach。
- `Connection closed` 需要结合宿主 stderr、配对文件可见性、Hub 日志和版本信息排查。

历史集成测试的行为说明不替代当前版本验证；本次发布检查见 [测试报告](TEST-REPORT.md)。
