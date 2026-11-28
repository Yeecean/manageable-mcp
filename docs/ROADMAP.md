# 重写路线图

目标是干净、本地优先的实现，而不是保留兼容性的升级。旧名称被有意移除。

## 0.1 — 可运行核心（已完成）

- [x] 严格配置解析和平台配置路径
- [x] 懒加载的 stdio 与 Streamable HTTP 下游客户端
- [x] `list_servers`, `list_commands`, `describe_commands`, `invoke_command`
- [x] stdio 与本地 HTTP transport
- [x] bearer 认证、Host/Origin 检查、请求体限制
- [x] 示例、smoke 脚本、单元测试和集成测试
- [x] 无旧别名、无发布工具链

## 0.2 — 客户端易用性（已完成）

- [x] 服务器分组和 `--group`
- [x] HTTP `/mcp/<group>` 路由
- [x] 一次性 `list-commands`、`describe`、`call`、`auth` 命令
- [x] 基于 `--attach` 的 stdio 到 HTTP 桥接
- [x] `SIGHUP` 重载（POSIX）和显式管理 API 重载

## 0.3 — 管理（已完成）

- [x] 用于服务器 CRUD、探测和重载的管理 HTTP API
- [x] `/admin` 无依赖管理 UI
- [x] 原子替换式配置回写
- [x] 带缓存工具计数的健康/状态端点

## 0.4 — 远程认证与策略（已完成）

- [x] OAuth 2.0 + PKCE，支持动态客户端注册
- [x] token 存储与刷新
- [x] 服务器级/全局 allow/deny 策略规则
- [x] 诊断信息中的密钥脱敏

## 0.5 — 保真度与规模

- [x] prompt 转发（按服务器选择启用）
- [x] 分页工具与 prompt 发现
- [x] 未知内容块规范化
- [x] 活动驱动的健康监控器
- [x] 并发与超时压力测试

## 0.6 — 架构保真补齐

- [x] 探测改为真正调用下游 `tools/list`，回填工具数量与工具摘要
- [x] 管理 API：单服务器 `auth` / `probe` / `tools`，批量 `onlyUnknown`、
      `concurrency`、`timeoutMs` 和 `summary`
- [x] 管理面板：状态筛选、工具列表弹窗、授权类型徽章、OAuth 授权弹窗、
      复制 MCP 端点、首载自动探测未知工具数
- [x] 配置字段：`tags`、`examples`、每服务器 `healthCheck`、
      `embedServerSummaries`（含 `maxDescriptionChars` / `maxCatalogChars`）。
      `healthCheck` 已接入后台监控：控制启用、`tools/list`/`ping`、超时和缓存。

## 0.7 — 本地保真复查（已完成）

- [x] 配置值任意位置的 `{file:...}` 展开，包括远程 URL 查询串
- [x] 元工具旧契约：`list_servers.filter`、`list_commands.servers[]`、
      `describe_commands.command_names[]`、`invoke_command.command_name`
- [x] 配置重载复用未变化服务器的连接、工具数和健康状态
- [x] 管理探测回填 `health`、工具数量、延迟和授权状态
- [x] 授权检查强制绕过工具缓存，OAuth 成功后清理旧授权状态
- [x] 管理面板并发刷新、工具弹窗竞态、错误折叠状态和双击门禁
- [x] 每服务器 `healthCheck` 真正控制后台探测方法、超时和缓存；管理工具探测固定
      执行 `tools/list`
- [x] 下游错误脱敏、URL/命令目标脱敏、非 loopback 强制 token
- [x] Windows `.cmd`/`.bat` 下游进程树清理

## 非目标

- 发布到 npm、PyPI、crates.io、Docker、Homebrew 或 Git 远程仓库
- Python 启动器 / wheel
- 旧 `lazy-*` 兼容别名
- 旧配置目录查找
