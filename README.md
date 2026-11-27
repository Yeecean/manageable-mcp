# manageable-mcp v2

一个仅在本地运行、优先支持 Windows 的 MCP 代理，提供懒加载式工具发现、分组作用域、
prompt 转发、策略规则、健康探测、OAuth、管理面板和一次性客户端。

本项目有意与旧代码树彻底划清界限：

- 不提供 `lazy-mcp` 别名、`lazy_mcp` 包或 `LAZY_MCP_*` 变量；
- 不提供 `_meta.lazyMcp*` 键，也不查找旧配置目录；
- 不包含包发布、Docker、Homebrew、Rust 或 Python 打包链路；
- 不提供任何形式的兼容层。

包版本：`0.2.0`。路线图 0.1–0.6 已完成，0.7 是本轮本地保真复查；
路线图编号不是 npm 发布版本（本项目不发布）。

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本
- npm

## 本地快速开始

```powershell
cd "E:\GitHub Clone\manageable-mcp-v2"
npm install
npm run build
npm test
npm run smoke
npm run smoke:http
npm run test:e2e
```

`test:e2e` 会启动一个真实的 HTTP 守护进程，验证一次性发现、策略拒绝、分组路由、
管理 API、健康探测、stdio attach 桥接和 prompt 转发，最后关闭所有相关进程。

## 配置

唯一的配置来源是 `servers.json`。默认路径如下：

- Windows：`%APPDATA%\manageable-mcp\servers.json`
- 其他平台：`$XDG_CONFIG_HOME/manageable-mcp/servers.json` 或
  `~/.config/manageable-mcp/servers.json`

`--config` 和 `MANAGEABLE_MCP_CONFIG` 可以覆盖该路径。

```json
{
  "servers": [
    {
      "name": "local-demo",
      "description": "本地 stdio MCP 服务器。",
      "command": "node",
      "args": ["examples/echo-server.mjs"],
      "cwd": ".",
      "forwardPrompts": true,
      "permissions": {
        "default": "allow",
        "rules": [
          { "pattern": "delete_*", "action": "deny", "message": "只读会话" }
        ]
      }
    },
    {
      "name": "remote-demo",
      "description": "远程 Streamable HTTP MCP 服务器。",
      "url": "https://example.com/mcp",
      "oauth": {
        "callbackPort": 8947,
        "scope": "mcp.read"
      }
    }
  ],
  "groups": {
    "read-only": {
      "description": "仅包含安全工具",
      "servers": ["local-demo"]
    }
  },
  "permissions": {
    "rules": [
      { "server": "*", "pattern": "delete_*", "action": "deny" },
      { "server": "remote-demo", "pattern": "search_*", "action": "allow" }
    ]
  },
  "health": {
    "enabled": false,
    "intervalMs": 30000,
    "idleTimeoutMs": 300000,
    "timeoutMs": 10000
  },
  "transport": {
    "host": "127.0.0.1",
    "port": 8080,
    "path": "/mcp",
    "admin": false,
    "cli": false
  }
}
```

每个服务器必须且只能设置 `command`（stdio）或 `url`（HTTP）中的一个。
`${VAR}` 会从环境变量展开；`{file:relative/or/absolute/path}` 会从文件读取密钥。
变量缺失或文件不可读会导致配置加载失败。Token 和密钥值绝不会写入日志。

### 分组

分组中只有已启用的成员可见。被禁用的成员在该作用域内的表现与未知服务器完全一致。

```powershell
node dist/index.js serve --config servers.json --group read-only
```

通过 HTTP 时，分组是一个路径别名：

```text
http://127.0.0.1:8080/mcp/read-only
```

未知分组返回 `404`。使用 stdio 时，未知的 `--group` 会导致启动失败。

### 权限

规则按以下顺序求值：

1. 服务器级规则，最后一条匹配的规则生效；
2. 全局规则，最后一条匹配的规则生效（`server` 是 glob，默认 `*`）；
3. 服务器级默认值；
4. 全局默认值；
5. 隐式 `allow`。

Glob 语法支持 `*`（任意字符）和 `?`（单个字符）。被拒绝的调用会返回
`isError: true`，并在 `_meta.manageableMcpProxyError.code` 中返回
`"POLICY_BLOCKED"`。

### Prompt 转发

Prompt 转发按服务器选择启用，配置项为 `forwardPrompts: true`。Prompt 按
`<server>::<prompt>` 的格式命名；编解码器会转义 `:` 和 `\`，确保名称能够无冲突地
往返。只有当所选作用域内至少有一台服务器选择启用时，才会声明 `prompts` 能力。

### OAuth

远程服务器在返回 `401`/`403` 时，会自动尝试 OAuth 2.0 + PKCE。只有在需要覆盖
OAuth 默认值（例如静态客户端凭证、回调端口、作用域或额外请求头）时，才需要添加
`oauth` 配置块。代理会执行 RFC 9728/8414 发现、可选的动态客户端注册
（RFC 7591）、本地回调交换、token 持久化和刷新。

- 默认回调地址：`http://127.0.0.1:8947/callback`
- `MANAGEABLE_MCP_OAUTH_CALLBACK_PORT` 可覆盖回调端口。
- `callbackPort: 0` 表示向操作系统申请临时端口（默认仅供测试使用）。
- 凭证存储在 `%APPDATA%\manageable-mcp\oauth.json`。
- `clientSecret` 必须与 `clientId` 一起使用。

需要授权时，工具调用会返回 `AUTH_REQUIRED` 和
`_meta.manageableMcpProxyError.authUrl`。在浏览器中打开该 URL，回调服务器会保存
token。随后重试调用，或使用 `manageable-mcp auth <server> --wait`。

### 健康探测

健康探测默认关闭，因此启动和 `list_servers` 绝不会连接下游服务器。可在配置中启用，
或使用 `--health` 启用。工具活动开始后，监控器会连接已启用的服务器并调用
`tools/list`，同时缓存工具数量和健康状态，并在超过 `idleTimeoutMs` 后休眠。
`/health` 只报告已缓存状态，不会触发探测。

每服务器的 `healthCheck` 字段会被解析和校验；当前后台监控仍统一使用全局
`health.timeoutMs`，单服务器/批量管理探测则由请求的 `timeoutMs` 控制。

管理面板首次打开时会对“已启用且工具数未知”的服务器自动发起一次探测。该探测会
真实连接下游服务器，服务器较多时可能需要几十秒；页面会逐张卡片显示进度和结果。

## 运行 HTTP 守护进程

```powershell
npm run demo:http
# or
node dist/index.js serve --transport http --port 8080
```

- MCP 端点：`http://127.0.0.1:8080/mcp`
- 分组端点：`http://127.0.0.1:8080/mcp/<group>`
- 健康检查：`http://127.0.0.1:8080/health`
- 管理面板：`http://127.0.0.1:8080/admin`

使用 `--ui` 启用管理面板，使用 `--cli` 发布一次性端点，使用 `--auth-token`
要求 bearer token。一次性端点仅绑定 loopback。任何非 loopback 地址都必须配置
token，否则拒绝启动；空主机名、`/health/` 以及 `/admin`、`/api/admin` 保留路径
也会被拒绝。

## 四个元工具

| 工具 | 用途 |
|---|---|
| `list_servers` | 列出可见服务器及缓存状态；支持 `filter` 按名称、描述或标签过滤，不会建立连接。 |
| `list_commands` | 用 `server` 查询单个服务器，或用 `servers` 批量查询；只返回名称和简短说明。 |
| `describe_commands` | 用 `command_names` 返回所选工具的完整 schema；支持 `refresh`。 |
| `invoke_command` | 用 `command_name` 调用下游工具；下游输入必须放在 `parameters` 中。 |

已启用的服务器目录会嵌入 `list_servers` 的描述中。完整 schema 仍保持懒加载，
直到调用 `describe_commands`。`list_servers` 同时保留旧契约字段
`tools_count`、`examples`、`tags` 和 `auth_required`，并返回
`{ servers, version }`；过滤会先应用当前 group scope。

## 一次性 CLI

使用 `--cli`（或 `transport.cli: true`）启动守护进程时，会发布
`%APPDATA%\manageable-mcp\cli-endpoint.json`。该文件包含 loopback URL，以及配置后
的 bearer token；请保持配置目录私有。

```powershell
node dist/index.js list-commands echo
node dist/index.js describe echo echo add
node dist/index.js call echo echo '{"text":"hello"}'
node dist/index.js call echo echo - --params-file params.json
node dist/index.js auth remote --wait
```

使用 `--url <url>` 显式选择守护进程，使用 `--auth-token` 指定其 token，使用
`--json` 输出完整结果，使用 `--timeout <seconds>` 设置客户端超时。

## 将 stdio 附加到运行中的守护进程

```powershell
node dist/index.js --attach http://127.0.0.1:8080/mcp
```

Attach 模式从不读取 `servers.json`，也从不启动下游服务器。它把工具和 prompt
转发给守护进程，并通过 URL（`/mcp/<group>`）使用分组。Loopback 地址受信任；
非 loopback 目标要求 `https://` URL 和 bearer token。记录日志前会对 URL 和错误
文本进行脱敏。

## 管理面板与 API

通过 `--ui` 或 `"transport": { "admin": true }` 启用。

- `GET /admin` — 无依赖的浏览器面板（不使用 CDN）。
- `GET /api/admin` — 概览。
- `POST /api/admin/servers` — 添加。
- `GET/PUT/DELETE /api/admin/servers/:name` — 读取/更新/删除。
- `POST /api/admin/servers/:name/toggle` — 启用/禁用。
- `POST /api/admin/servers/:name/auth` — 检查 OAuth 授权状态并返回授权链接。
- `POST /api/admin/servers/:name/probe` — 连接单个服务器并刷新工具列表。
- `GET /api/admin/servers/:name/tools` — 返回该服务器的工具名称和描述。
- `POST /api/admin/reload` — 从磁盘重载。
- `POST /api/admin/probe` — 批量检测工具；支持 `names`、`onlyUnknown`、
  `concurrency` 和 `timeoutMs`，返回 `results` 与
  `summary: { total, ok, authRequired, failed }`。`names` 与 `onlyUnknown`
  不能同时使用；批量检测不返回完整工具摘要，单服务器探测才返回。

API 要求提供已配置的 bearer token。未配置 token 时，仅接受 loopback 客户端。
配置变更会使用常规解析器校验并以原子方式写入；未知的原始字段会保留。

管理面板会显示每个服务器的类型、目标、标签、工具数量、健康状态和授权类型
（`OAuth`、`API Key`、`本地`、`自动检测`），并支持状态筛选、复制 MCP 端点、
单服务器/批量工具检测、工具列表弹窗和 OAuth 授权弹窗。
超长错误、保存失败和 OAuth 诊断会折叠为可展开详情，默认只显示一行摘要，
展开后可在限高区域内滚动查看完整文本。
卡片上的 URL 和命令目标会脱敏显示：URL userinfo 被移除，敏感查询参数和
`--token`/`--api-key` 等命令行参数的值替换为 `***`；完整值仍只保存在本地配置中。

## 安全模型

- stdout 是 MCP 协议通道；所有日志都写入 stderr。
- HTTP 默认绑定 `127.0.0.1`，并校验 `Host`/`Origin`。
- 请求体默认限制为 4 MiB。
- Bearer token 使用常量时间比较。
- 非 loopback 绑定必须提供 token；管理 API 在无法确认回环地址时拒绝访问。
- 下游错误、工具错误结果和 OAuth 诊断会统一脱敏；下游 HTTP 错误只保留状态码。
- Windows 关闭 stdio 下游时使用 `taskkill /T` 清理 `.cmd`/`.bat` 包装器产生的进程树。
- 管理/配置/token 文件均为本地文件；在平台支持时，CLI 端点使用仅所有者可访问的
  权限。
- OAuth token 和回调 code 会从诊断信息中脱敏。

## 开发

```powershell
npm run dev -- --help
npm run build
npm test
npm run smoke
npm run smoke:http
npm run test:e2e
```

源码布局和设计规则见 [ARCHITECTURE.md](./ARCHITECTURE.md)。分阶段重写计划见
[docs/ROADMAP.md](./docs/ROADMAP.md)。工程规则和必需工作流见
[RULE.md](./RULE.md)。

## 相对旧代码树的破坏性变更

| 旧接口 | 新行为 |
|---|---|
| `lazy-mcp` 命令 | 已移除。二进制名为 `manageable-mcp`。 |
| `lazy_mcp` Python 包 | 已移除。不再提供 Python 包。 |
| `LAZY_MCP_*` 变量 | 已移除。只读取 `MANAGEABLE_MCP_*`。 |
| `_meta.lazyMcp*` | 已移除。只输出 `_meta.manageableMcp*`。 |
| `~/.config/lazy-mcp/` | 已忽略。默认目录为 `%APPDATA%\manageable-mcp\`。 |
| `LazyMCPServer` 导出 | 已移除。请使用 `createProxyServer`。 |
| npm/PyPI/Docker/Homebrew/Rust 发布链路 | 不存在。 |
