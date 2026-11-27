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

## 0.5 — 保真度与规模（当前）

- [x] prompt 转发（按服务器选择启用）
- [x] 分页工具与 prompt 发现
- [ ] 未知内容块规范化
- [x] 活动驱动的健康监控器
- [ ] 并发与超时压力测试

## 非目标

- 发布到 npm、PyPI、crates.io、Docker、Homebrew 或 Git 远程仓库
- Python 启动器 / wheel
- 旧 `lazy-*` 兼容别名
- 旧配置目录查找
