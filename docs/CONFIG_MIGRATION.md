# 旧 `servers.json` 到 v2 配置迁移

> 权威依据：v2 的 `src/config/load.ts`、`src/config/types.ts` 和 `README.md`。
> 旧仓库 `doc/CONFIGURATION.md` 仅用于识别旧字段，不能作为 v2 能力依据。

v2 是破坏性重写，没有旧配置兼容层，也没有自动迁移器。旧文件不能假定“能解析就等于行为不变”：
v2 只读取已知字段，未识别字段不会进入运行时配置；旧 `healthMonitor`、`transport.ui` 等配置
可能被静默忽略并回退到 v2 默认值。请按本文逐项手工迁移。

## 先做四件事

1. 备份旧配置，并复制到 v2 的默认位置或显式 `--config` 路径：
   - Windows：`%APPDATA%\manageable-mcp\servers.json`
   - 其他平台：`$XDG_CONFIG_HOME/manageable-mcp/servers.json` 或
     `~/.config/manageable-mcp/servers.json`
2. 删除旧品牌字段、旧环境变量和旧目录依赖；v2 不会回退查找 `~/.config/lazy-mcp/`。
3. 将健康、transport 和 examples 字段按下面的表改名或重写。
4. 启动后检查 stderr 和 `list_servers`；v2 对已知字段的校验是严格的，配置错误会直接拒绝加载。

## 服务器级字段

状态说明：**兼容**表示同名同义；**需改名**表示必须改字段；**不支持**表示 v2 无对应能力；
**v2 新增**表示旧配置没有、按需添加。

| 旧字段 | v2 写法 | 状态 | 说明 |
| --- | --- | --- | --- |
| `name` | `name` | 兼容 | 必须唯一，且匹配 `[A-Za-z0-9][A-Za-z0-9._-]*` |
| `description` | `description` | 兼容 | v2 仍为必填非空字符串；建议按目标一的目录规范撰写 |
| `type: "local" \| "remote"` | 无 | 不支持 | v2 不再读取 `type`，而是要求且只允许 `command` 或 `url` 二选一；请删除旧字段 |
| `command`（字符串） | `command` + `args` | 兼容 | `"command": "npx", "args": [...]` 可继续使用 |
| `command`（字符串数组） | `command`（数组） | 兼容 | 第一个元素是可执行文件，其余元素作为参数；若同时写 `args`，v2 会把 `args` 追加在数组参数之后 |
| `args` | `args` | 兼容 | 必须是字符串数组；可继续与字符串形式 `command` 搭配 |
| `url` | `url` | 兼容 | 仅支持 `http://` 或 `https://` 的 Streamable HTTP MCP 端点；WebSocket URL 不支持 |
| `cwd` | `cwd` | v2 新增 | 旧服务器级配置没有该字段；相对路径按配置文件所在目录解析，也可写绝对路径 |
| `env` | `env` | 兼容 | 字符串键值对象；v2 支持 `${VAR}` 与 `{file:...}` 展开 |
| `headers` | `headers` | 兼容 | 主要用于远程服务器，字符串键值对象；同样支持展开 |
| `enabled` | `enabled` | 兼容 | 默认 `true`；分组只暴露已启用成员 |
| `tags` | `tags` | 兼容 | 字符串数组 |
| `examples` | `examples` | 需改写 | 旧结构是 `{ title, commands[], description? }`；v2 只读取 `{ command?, description? }`，旧 `title`/`commands` 不会迁移 |
| 无 | `timeoutMs` | v2 新增 | 每服务器请求超时，默认 `15000` 毫秒，最大 `2147483647`；不是旧顶层 `requestTimeout` 的同名替代 |
| `healthCheck` | `healthCheck` | 部分需改名 | 见下节 |
| `oauth` | `oauth` | 部分需改名 | 见 OAuth 小节 |
| `permissions` | `permissions` | 兼容但更严格 | 见权限小节 |
| `forwardPrompts` | `forwardPrompts` | 兼容 | 默认 `false`，按服务器选择启用 |

### 每服务器 `healthCheck`

| 旧字段 | v2 写法 | 状态 | 说明 |
| --- | --- | --- | --- |
| `healthCheck.enabled` | `healthCheck.enabled` | 兼容 | 默认仍为 `false`；设为 `true` 可在全局健康关闭时让该服务器参与后台探测 |
| `healthCheck.method` | `healthCheck.method` | 兼容 | `"tools/list"` 或 `"ping"`；默认 `tools/list` |
| `healthCheck.timeout` | `healthCheck.timeoutMs` | 需改名 | v2 默认 `5000` 毫秒 |
| `healthCheck.cacheDuration` | `healthCheck.cacheDurationMs` | 需改名 | v2 默认 `60000` 毫秒；设为 `0` 表示不复用缓存 |

## 全局健康配置

旧 `healthMonitor` 必须整体改名为 v2 的 `health`。

| 旧字段 | v2 写法 | 状态 | 说明 |
| --- | --- | --- | --- |
| `healthMonitor.enabled` | `health.enabled` | 需改名，且默认值变化 | 旧版默认开启；v2 默认 **关闭**。要保留旧行为必须显式写 `true` |
| `healthMonitor.interval` | `health.intervalMs` | 需改名 | 旧默认 30000 毫秒，v2 相同 |
| `healthMonitor.timeout` | `health.timeoutMs` | 需改名 | 旧默认 10000 毫秒，v2 相同 |
| `healthMonitor.idleTimeout` | `health.idleTimeoutMs` | 需改名 | 旧默认 300000 毫秒，v2 相同；`0` 仍表示不休眠 |

旧顶层 `healthMonitor` 不会被 v2 识别。只改 `enabled` 而保留旧块，会让 v2 使用“健康关闭”的默认值。

## Transport 字段

| 旧字段 | v2 写法 | 状态 | 说明 |
| --- | --- | --- | --- |
| `transport.type` | 无配置字段 | 不支持 | 启动方式改用 `--transport stdio\|http` 或 `MANAGEABLE_MCP_TRANSPORT`；v2 默认 stdio |
| `transport.host` | `transport.host` | 兼容 | 默认 `127.0.0.1` |
| `transport.port` | `transport.port` | 兼容 | 默认 `8080` |
| `transport.path` | `transport.path` | 兼容 | 默认 `/mcp`；`/health`、`/admin`、`/api/admin` 为保留路径 |
| `transport.authToken` | `transport.authToken` | 兼容 | 支持 `${VAR}` 和 `{file:...}`；空 token 会被拒绝 |
| `transport.ui` | `transport.admin` | 需改名 | v2 使用 `admin: true` 提供 `/admin` 和 `/api/admin` |
| `transport.allowedOrigins` | `transport.allowedOrigins` | 兼容 | 字符串数组，完整 Origin（含协议和端口） |
| `transport.allowedHosts` | `transport.allowedHosts` | 兼容 | 字符串数组，用于反向代理或自定义 Host |
| `transport.maxPayloadSize` | `transport.maxBodyBytes` | 需改名 | 请求体上限，默认 `4194304`（4 MiB）；旧字段名不会生效 |
| 无 | `transport.cli` | v2 新增 | 启用一次性 CLI 端点发现文件，仅回环地址 |

HTTP 仍默认只绑定回环地址；非回环绑定必须提供 bearer token。`transport.type` 不会从配置启动 HTTP，
请使用 CLI 或环境变量。

## OAuth

| 旧字段 | v2 写法 | 状态 | 说明 |
| --- | --- | --- | --- |
| `oauth.clientId` | `oauth.clientId` | 兼容 | 省略时尝试动态客户端注册 |
| `oauth.clientSecret` | `oauth.clientSecret` | 兼容 | 必须与 `clientId` 一起使用 |
| `oauth.callbackPort` | `oauth.callbackPort` | 兼容 | 默认监听端口仍为 `8947`；`0` 表示临时端口 |
| `oauth.callbackAddress` | 无 | 不支持 | v2 没有该字段，只保留 `callbackPort`；需要改变端口时改 `callbackPort` |
| 无 | `oauth.scope` | v2 新增 | 覆盖请求的 OAuth scope |
| `oauth.extraHeaders` | `oauth.extraHeaders` | 兼容 | 字符串键值对象，支持 `${VAR}` 和 `{file:...}` |
| 旧 `tokens.json` 凭证 | `oauth.json` | 不支持自动迁移 | v2 不读取旧 token 文件；迁移后按需重新授权 |

远程服务器遇到 `401`/`403` 会自动尝试 OAuth 2.0 + PKCE。`oauth` 块只用于覆盖默认值，
不是启用 OAuth 的前提。

## 权限

`permissions` 的规则结构兼容旧版：服务器级与全局级都使用 `default`、`rules[]`、
`pattern`、`action`、`message`；全局规则还可带 `server` glob。

- `action` 仍只支持 `allow` 和 `deny`；`ask` 不支持，也不会被当作未来能力预先接受。
- 评估顺序仍为服务器规则 → 全局规则 → 服务器默认 → 全局默认 → 隐式允许。
- v2 的校验更严格：非法权限块会拒绝整份配置，而旧版的按服务器软失败不能照搬。
- 被拒绝时 v2 返回 `isError: true`，错误码在 `_meta.manageableMcpProxyError.code` 中为
  `POLICY_BLOCKED`；旧 `_meta.manageableMcpPolicy` 契约已不存在。

## 分组

`groups` 的 `servers[]` 和 `description` 结构兼容，但语义更严格：

- 分组名必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`。
- `servers` 必须是非空数组，不能有重复成员。
- 引用未知服务器会使整份配置加载失败；旧版的“丢弃并警告”软失败不再适用。
- 分组只暴露已启用成员；被禁用成员与未知服务器在作用域内表现一致。
- `--group` 用于 stdio，HTTP 使用 `/mcp/<group>`；未知 stdio 分组启动失败，未知 HTTP 分组返回 `404`。

## 顶层字段与其他差异

| 旧字段 | v2 处理 | 说明 |
| --- | --- | --- |
| `mode` | 不支持 | 删除；v2 固定为多服务器代理 |
| `cache` | 不支持 | 没有同名配置；v2 使用进程内工具缓存，`refresh: true` 绕过缓存 |
| `logging` | 不支持 | 删除；v2 日志级别用 `--log-level`，日志仍写 stderr |
| `requestTimeout` | 不支持 | 改为每个服务器的 `timeoutMs`；作用域不完全相同，需逐台验证 |
| `embedServerSummaries.enabled` | 兼容 | 默认 `true` |
| `embedServerSummaries.maxDescriptionChars` | 兼容 | 超限只加显式告警，不截断 |
| `embedServerSummaries.maxCatalogChars` | 兼容 | 超限只加显式告警，不截断 |
| `embedServerSummaries.maxServers` | 不支持 | v2 忽略该字段，不会按数量删除服务器 |

## 旧品牌、旧路径与环境变量

| 旧用法 | v2 |
| --- | --- |
| `lazy-mcp` 命令 / bin alias | 已移除；二进制为 `manageable-mcp` |
| `lazy_mcp` Python 包、Python 启动器 | 已移除 |
| `LAZY_MCP_*` 框架级环境变量 | 不读取，也不提供回退；只识别 `MANAGEABLE_MCP_*` |
| `~/.config/lazy-mcp/` | 不查找 |
| Windows 旧 `~/.config/manageable-mcp/` 习惯路径 | v2 默认使用 `%APPDATA%\manageable-mcp\` |
| `_meta.lazyMcp*` | 已移除；只输出 `_meta.manageableMcp*` |
| 旧 npm/PyPI/Docker/Homebrew/Rust 安装链路 | v2 不提供 |

配置值里的 `${LAZY_MCP_FOO}` 只是用户自定义占位符，会按环境变量名读取，不是 v2 的兼容承诺；
建议改成业务变量名或 `MANAGEABLE_MCP_*` 命名。必须通过 `--config` 或 `MANAGEABLE_MCP_CONFIG`
指向旧目录时，v2 只读取该文件，不会迁移其旁边的 OAuth 或状态文件。

## 迁移示例

旧配置片段：

```json
{
  "mode": "multi-server",
  "servers": [
    {
      "name": "local-demo",
      "description": "本地演示服务器",
      "type": "local",
      "command": ["npx", "-y", "example-mcp"],
      "healthCheck": {
        "enabled": true,
        "timeout": 3000,
        "cacheDuration": 60000
      }
    }
  ],
  "healthMonitor": {
    "enabled": true,
    "interval": 30000,
    "timeout": 10000,
    "idleTimeout": 300000
  },
  "transport": {
    "type": "http",
    "ui": true,
    "maxPayloadSize": 1048576
  },
  "requestTimeout": 10000
}
```

v2 配置：

```json
{
  "servers": [
    {
      "name": "local-demo",
      "description": "本地演示服务器",
      "command": ["npx", "-y", "example-mcp"],
      "timeoutMs": 10000,
      "healthCheck": {
        "enabled": true,
        "timeoutMs": 3000,
        "cacheDurationMs": 60000
      }
    }
  ],
  "health": {
    "enabled": true,
    "intervalMs": 30000,
    "timeoutMs": 10000,
    "idleTimeoutMs": 300000
  },
  "transport": {
    "admin": true,
    "maxBodyBytes": 1048576
  }
}
```

HTTP 启动方式另行指定，例如：

```powershell
node dist/index.js serve --transport http
```

## 迁移检查清单

- [ ] 每个服务器只有 `command` 或 `url` 之一，旧 `type` 已删除。
- [ ] `healthMonitor` 已改名为 `health`，并确认是否需要显式开启。
- [ ] `healthCheck.timeout`、`cacheDuration` 已改名。
- [ ] `transport.ui`、`maxPayloadSize` 已改名；HTTP 已通过 `--transport` 启动。
- [ ] `requestTimeout` 已按服务器拆到 `timeoutMs`，或接受 v2 默认 15 秒。
- [ ] `examples` 已从 `title/commands` 改为 `command/description`。
- [ ] 分组、权限和 OAuth 已按严格校验规则检查。
- [ ] 旧 `lazy-mcp`、`lazy_mcp`、`LAZY_MCP_*` 和旧目录依赖已移除。
- [ ] 启动日志无 `CONFIG_INVALID`，且 `list_servers` 返回预期服务器与分组。
