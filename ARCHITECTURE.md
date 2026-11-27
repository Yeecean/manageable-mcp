# 架构

本次重写让每类关注点保持独立边界，且不包含任何旧名称兼容分支。

## 模块

```text
src/
  index.ts                 CLI entry point
  cli.ts                   commands, flags, reload, process lifecycle
  config/
    types.ts               config model and policy/auth/health types
    paths.ts               platform config/state paths
    load.ts                parse, validate, expand secrets, resolve cwd
  core/
    errors.ts              AppError codes and OAuth authorization signal
    logger.ts              stderr logger
    timeout.ts             timeout helper
  mcp/
    downstream.ts          SDK client plus opt-in OAuth transport
    manager.ts             lazy connections, caches, prompts, health, reload
    tools.ts               four meta-tools, scoping, policy enforcement
    proxy-server.ts        MCP server factory and prompt handlers
    proxy-scope.ts         group scope construction and refresh
    prompt-namespace.ts    injective <server>::<prompt> codec
    permissions.ts         glob matching and last-match-wins resolution
  transports/
    stdio.ts               stdio transport
    http.ts                stateless Streamable HTTP, groups, health, admin
  client/
    endpoint.ts            owner-only CLI endpoint discovery file
    one-shot.ts            call/list-commands/describe/auth client
    attach.ts              stdio-to-HTTP bridge
    sanitize.ts            URL/error redaction
  admin/
    store.ts               raw config CRUD and atomic writes
    controller.ts          /admin and /api/admin routes
    ui.ts                  dependency-free browser panel
  oauth/
    provider.ts            OAuthClientProvider, PKCE, tokens, refresh
    callback-server.ts     shared loopback callback listener
    store.ts               token/client/verifier persistence
    sanitize.ts            OAuth-aware redaction
```

## 请求流程

1. `cli.ts` 在加载配置之前处理一次性命令和 attach 命令。
2. 守护进程加载 `servers.json`，创建一个 `ServerManager`，并选择 stdio 或 HTTP。
3. 启动、`tools/list` 和 `list_servers` 都不会连接下游。
4. `list_commands`、`describe_commands` 和 `invoke_command` 会按需懒加载连接。
   工具列表会被缓存；`refresh: true` 会绕过缓存。
5. `invoke_command` 在调用下游客户端之前检查服务器级/全局策略。拒绝时返回
   `POLICY_BLOCKED`。
6. HTTP 请求会创建新的代理服务器和可选的分组作用域。分组成员只会保留已启用的
   服务器。
7. Prompt 只从选择启用的服务器聚合，并使用可逆编解码器命名。只有当作用域内至少
   有一台选择启用的服务器时，才会声明 `prompts` 能力。
8. 健康探测仅在启用且工具活动发生后运行。探测会连接下游并调用 `tools/list`，
   同时回填工具数量和健康状态；显式管理探测还会返回完整工具摘要。
9. `closeAll()` 会阻止新连接、等待正在进行的连接、关闭所有客户端，然后清空缓存。
   配置重载在替换 manager map 之前，也会先按同样方式停止接收新连接并等待现有连接
   结束。

## HTTP 路由

```text
GET  /health                  cached health, no auth
     /admin                    admin UI shell
     /api/admin...             admin API (bearer or loopback)
POST /mcp                     unscoped MCP endpoint
POST /mcp/<group>             group-scoped MCP endpoint
```

HTTP transport 是无状态的：每个请求都会获得新的 `Server` 和 Streamable HTTP
transport，而所有请求共享同一个 `ServerManager`。

## OAuth 流程

每个远程服务器都会获得一个 OAuth provider；回调监听器只在确实需要授权时启动，
或在显式配置了 `oauth` 块时启动。SDK transport 会执行发现、按需动态客户端注册、
PKCE 授权，并在 `401`/`403` 时刷新 token。共享的 loopback 回调服务器负责交换
授权码。Token、客户端信息、verifier 和发现状态会持久化到应用状态目录。需要授权的
失败会以 `AUTH_REQUIRED` 传播，并在错误元数据中携带授权 URL。

## 结果模型

- 成功的下游结果会原样返回：保留 `content`、`isError`、`structuredContent` 和
  `_meta`。
- 代理侧失败返回 `isError: true`，并附带
  `_meta.manageableMcpProxyError = { code, message, ...details }`。
- 不存在旧版元数据别名。

## 安全模型

- stdio 以当前操作系统用户的信任级别运行。
- HTTP 默认绑定 loopback。
- HTTP 在路由前检查 `Host` 和 `Origin`，包括 `/health`。
- Bearer token 使用常量时间比较。
- 请求体默认限制为 4 MiB。
- 管理 API 使用相同的 bearer token 或仅允许 loopback 访问；HTML 外壳不包含任何
  服务器数据。
- OAuth token 和回调 code 会从日志和错误页面中脱敏。
- 在平台支持时，一次性端点文件会以仅所有者可访问的权限写入。
- 配置写入会经过校验、临时文件、fsync 和原子重命名。

## 非目标

- npm/PyPI/crates/Docker/Homebrew/Rust 打包
- 任何旧 `lazy-*` 兼容接口
- 多租户远程服务器；本工具面向本地信任边界
