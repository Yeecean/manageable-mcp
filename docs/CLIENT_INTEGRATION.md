# 本地客户端接入

管理面板中的“客户端一键接入”支持为 Claude Code、Codex、OpenCode 2.x 和 Cursor 写入本机配置。
展开面板即可查看状态；接入前会启动一次代理并检查四个元工具，之后才修改配置。
更新、移除和回滚也从同一处操作。配置变更后请重启对应客户端。

也可以使用命令行：

```powershell
npm run build
node dist/index.js connect status
node dist/index.js connect install codex
node dist/index.js connect verify codex
node dist/index.js connect uninstall codex
node dist/index.js connect rollback codex
```

将 `codex` 替换为 `claude`、`opencode` 或 `cursor` 即可选择其他客户端。默认使用当前
`servers.json`；使用其他配置或分组时：

```powershell
node dist/index.js connect install codex --config "C:\path\servers.json" --group demo
```

如果要连接已经运行的共享 HTTP 代理，可以使用 `--attach http://127.0.0.1:8080/mcp`，
分组写在 URL 路径中。非回环地址必须使用 HTTPS，认证令牌从启动客户端的环境变量
`MANAGEABLE_MCP_AUTH_TOKEN` 读取，不能写进 URL。`--attach` 不能与 `--config` 或 `--group` 同时使用。

`status` 中的“已接入”表示本项目的配置条目存在；`verify` 检查该条目启动的代理是否能够响应
并提供四个元工具。两者都不等于客户端内部已经连接，实际连接状态需在客户端内确认。

## 同名配置和回滚

默认不会覆盖或移除不属于当前项目的 `manageable-mcp` 条目。如果希望替换它，使用面板上的
“替换同名项”或明确指定 `--replace`：

```powershell
node dist/index.js connect install codex --replace
```

修改前会备份完整的客户端配置。备份放在应用状态目录的 `client-backups` 中，可能包含客户端原有的
密钥或其他私人设置，请按敏感文件保管。`rollback` 恢复最近一次修改前的完整文件；如果文件在那次
修改后又被其他程序更改，回滚会拒绝覆盖。回滚新建的配置文件时，会在内容未变的前提下移除该文件。

工具只在明确执行接入、更新、移除或回滚时修改客户端配置。`--client-config <路径>` 可用于隔离测试
或指定非默认配置文件；状态目录可通过 `MANAGEABLE_MCP_STATE_DIR` 指定。进行中的操作使用锁文件，
如进程异常退出导致锁残留，先确认没有接入操作运行，再在对应备份目录中处理 `operation.lock`。

## Windows 实测范围

- Claude Code 2.1.325：隔离配置被真实客户端识别，并显示已连接。
- Codex CLI 0.167.0：隔离配置被真实客户端的 `mcp get` 识别；尚未验证客户端对话内调用。
- OpenCode 2.2.7：客户端能读取生成的配置，但隔离的 `--standalone` MCP 列表为空；使用其自身
  `mcp add --global` 添加的对照条目同样不显示，真实连接尚未验证。
- Cursor 3.32.4：配置生成和代理握手通过隔离测试，Cursor 图形界面内的连接尚未验证。

可在安装了上述客户端的 Windows 环境中运行 `node scripts/verify-client-apps.mjs` 重现命令行检查。
该脚本只使用临时配置；OpenCode 列表异常时返回非零状态，不把读取配置当作连接成功。
