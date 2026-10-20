# 验证报告

当前版本 **0.5.0**（2026-10-20）。历史版本的验证记录不再维护，可在 git 历史中查看。

## 自动测试

`npm test`：**89 项通过**。覆盖：

- 独占所有权、Origin / Bearer / 配对校验、连接断开的 claim 清理。
- ref / cursor 失效、分页不丢尾部、节点与字符双预算、超长节点报错。
- 可操作性等待：持续移动时不派发输入、派发后结果未知、超时后队列可继续使用且不重放。
- 键盘：F1–F12、Insert/Delete、导航键、全部 ASCII 可打印字符、US 标点的 key/code/Shift 映射、`+` 与 `Control++`、修饰键不插入文本、无效组合拒绝。
- 滚动：DOM 默认模式、wheel 参数与坐标、超时语义。
- 会话：递归附着 / 清理、重复 requestId 与 executionContextId 隔离。
- 快照、导航等待与观察预算、上传校验、选项卡分组恢复与回滚、Nosis 配置生成。

`npm run test:package`：在仓库外含空格路径安装 tgz，复制稳定扩展目录，从包内启动 stdio MCP 并确认 **20 个工具**；`prepack` 检查拒绝配对密钥与 `config.generated.js`。

## 真实浏览器

使用临时 profile、独立配对扩展与本地 fixture，经完整扩展 → Hub → stdio MCP 链路执行：

- Chromium 156 与 Edge 155 各 **143 次**真实工具调用，全部通过。
- 键盘：F8 / Insert / PageUp 的可信 keydown，Shift 标点实际输入。
- 滚动：DOM 滚动不触发 wheel 处理器；显式 wheel 收到正确的可信 `deltaX` / `deltaY`，含 OOPIF 内的事件。
- 点击、填充、单 / 多文件上传、隐藏 input、`showPicker`、Unicode / 空文件、清空、对话框继续通过。
- OOPIF（`--site-per-process`）：快照与 ref、顶层坐标点击、原生 / DOM 填充、焦点键盘、右键 / 中键 / 双击 / 修饰键、拦截 chooser 上传、子 session 日志、子 frame 导航及父页面遮挡拒绝。
- 标签组：无标题红色分组、导航保持、释放恢复用户分组、MCP 断连恢复、固定标签提示。

并行运行两套浏览器时曾出现一次 OOPIF 点击未收到可信回执，工具按设计报告"结果未知"并停止，没有重放输入；随后在独立 profile 中复跑通过。原生输入仍受浏览器渲染与输入状态影响，超时不等于动作未发生。

## Nosis 端到端

在 0.4.0 完成并通过，0.5.0 未改变工具集合与结果封装，因此未重跑：

- 运行中的 Nosis GUI（`127.0.0.1:8737`）经真实 Bridge / Runtime / MCP 启动链报告 `browser_attach` ready、`tool_count` 20。
- 通过 Nosis ToolCatalog 调用全部 20 个工具、34 次成功调用，覆盖截图到模型消息的图片适配、`isError` 后连接继续可用、失效句柄与 JS 弹窗错误路径。

复跑方式见 [Nosis 集成](NOSIS-INTEGRATION.md)。

## 已知限制

- 未覆盖：独立 worker / service worker、WebSocket 消息、`window.showOpenFilePicker()`、目录上传、下载管理、透视变换 iframe。
- 后台截图可能因浏览器暂停渲染而在 5 秒后超时；原生菜单与标签拖动可能抑制输入。
- 计时数据仅代表本机 fixture，不构成对任意网站的耗时承诺。
- `target_verified` / `delivery_verified` / `value_verified` 只证明事件送达或文本写入，不代表业务完成。

## 复跑

```sh
npm test
npm run test:package
npm run test:live -- --executable /path/to/chromium --family chromium
npm run test:interaction -- --executable /path/to/chromium --family chromium
npm run test:interaction -- --tab-indicators --executable /path/to/chromium --family chromium
```

真实浏览器测试需要一个允许命令行加载扩展的 Chromium / Edge 可执行文件，并只操作临时 profile 与本地 fixture。原始结果保存在被忽略的 `test-results/` 目录（`unit-*.txt`、`package-*.txt`、`live-*.txt`、`npm-live-*.json`、`nosis-*.json`）。
