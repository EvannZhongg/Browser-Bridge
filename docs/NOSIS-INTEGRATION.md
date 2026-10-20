# Nosis 集成

BrowserAttach 提供标准 stdio MCP，可通过 Nosis 的通用 MCP 配置接入。先安装并运行 `browser-attach setup`，然后运行 `browser-attach setup --nosis`，自动备份并更新当前用户的 `~/.nosis/agent_config.json`。

生成的服务器名是 `browser_attach`，命令是 `browser-attach mcp`，工具审批策略为 `always`。重启 Nosis 后重新发现工具。

## 自定义运行目录

默认配置保存在用户数据目录，不依赖仓库位置。若宿主进程与终端的用户环境不同，可在两端显式设置同一个 `BROWSER_ATTACH_HOME`；路径由部署者选择，不应复制其他人的本机路径。`setup --nosis` 会将已设置的该变量写入 MCP 服务器的 `env`。

使用 `--config` 指定配对文件时，应手动向 MCP 命令添加相同参数；`--nosis` 只接受默认配对文件。

## 可选集成验证

运行 Nosis 自己的 Python 环境，传入实际源码目录，例如：

```sh
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family chrome
python scripts/verify-nosis.py --nosis-root /path/to/Nosis --family edge
```

该测试需要已连接的浏览器和 Nosis 配置，在浏览器中创建本地 fixture 页面；结束后释放控制。Python 仅用于此集成测试，不是 BrowserAttach 的运行依赖。

## 数据与故障排查

- 工具结果为 MCP TextContent，截图使用标准 ImageContent；截图能否进入模型取决于宿主的图片适配、大小预算和模型能力。
- 工具错误通过 MCP `isError` 返回。失效句柄不能跨连接复用，错误后应重新观察。
- 文件上传传递浏览器本机绝对路径，不通过 Hub 中转文件内容。
- 宿主可能将较大结果保存为 Artifact。若正文变为转义 JSON 长行，应检查宿主的分页和截断逻辑；不能将宿主文本预算硬编码进 BrowserAttach。
- `Connection closed` 需要结合宿主 stderr、配对文件可见性、Hub 日志和版本信息排查。

历史集成测试的行为说明不替代当前版本验证；本次发布检查见 [测试报告](TEST-REPORT.md)。
