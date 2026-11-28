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
    redaction.ts           URL/command display redaction
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
  integrations/
    config.ts              客户端配置定位、格式保留式编辑和校验
    service.ts             接入检查、备份、锁、原子写入与回滚
    cli.ts                 客户端接入命令
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
8. 健康探测仅在全局或某个服务器的 `healthCheck` 启用且工具活动发生后运行。默认
   调用 `tools/list` 并回填工具数量和健康状态；服务器可改用 `ping`，并覆盖超时与
   缓存时间。管理面板的工具探测固定执行 `tools/list`。单服务器管理探测返回完整
   工具摘要；批量探测只返回数量、耗时、授权/错误状态，避免一次响应携带所有工具。
9. `closeAll()` 会阻止新连接、等待在途的发现/调用/prompt 操作、关闭所有客户端，
   然后清空缓存。配置重载会先关闭并重建配置发生变化的服务器，未变化的服务器复用
   原有连接、工具数和健康状态；重载期间暂停接受新的 manager 操作。
10. 客户端接入通过独立模块编辑客户端的 JSONC/TOML，先验证代理启动，备份原文件并检查并发修改；
    默认拒绝覆盖同名的其他服务器。管理 API 复用同一实现，只有显式操作才写客户端配置。

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

HTTP 只允许绑定 loopback，除非同时配置 bearer token；空主机名和
`/health`、`/admin`、`/api/admin` 及其子路径会在配置层和启动层被拒绝。

## OAuth 流程

每个远程服务器都会获得一个 OAuth provider；回调监听器只在确实需要授权时启动，
或在显式配置了 `oauth` 块时启动。SDK transport 会执行发现、按需动态客户端注册、
PKCE 授权，并在 `401`/`403` 时刷新 token。共享的 loopback 回调服务器负责交换
授权码。Token、客户端信息、verifier 和发现状态会持久化到应用状态目录。需要授权的
失败会以 `AUTH_REQUIRED` 传播，并在错误元数据中携带授权 URL。

## 结果模型

- 成功的下游结果会原样返回：保留 `content`、`isError`、`structuredContent` 和
  `_meta`。下游 `isError: true` 的结果会保留结构，但对文本、结构化内容和
  `_meta` 递归脱敏。
- 代理侧失败返回 `isError: true`，并附带
  `_meta.manageableMcpProxyError = { code, message, ...details }`。
- 下游 `tools/list` 或 `prompts/list` 超过 100 页仍返回游标时抛出
  `PAGINATION_LIMIT`，不会把部分结果当作完整列表。
- 不存在旧版元数据别名。

## 安全模型

- stdio 以当前操作系统用户的信任级别运行。
- HTTP 默认绑定 loopback。
- 非 loopback 绑定必须配置 bearer token；管理 API 在无法确认回环地址时 fail closed。
- HTTP 在路由前检查 `Host` 和 `Origin`，包括 `/health`。
- Bearer token 使用常量时间比较。
- 请求体默认限制为 4 MiB。
- 管理 API 使用相同的 bearer token 或仅允许 loopback 访问；HTML 外壳不包含任何
  服务器数据。
- 下游 HTTP 错误只保留状态码；错误文本、工具错误结果、OAuth token 和回调 code
  会统一脱敏。
- 管理面板展示的 URL/命令目标会移除 userinfo、敏感查询值和敏感参数值。
- Windows 关闭 stdio 下游时用 `taskkill /T` 兜底清理 `.cmd`/`.bat` 进程树。
- 在平台支持时，一次性端点文件会以仅所有者可访问的权限写入。
- 配置写入会经过校验、临时文件、fsync 和原子重命名。

## 非目标

- npm/PyPI/crates/Docker/Homebrew/Rust 打包
- 任何旧 `lazy-*` 兼容接口
- 多租户远程服务器；本工具面向本地信任边界
