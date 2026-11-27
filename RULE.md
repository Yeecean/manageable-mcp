# RULE.md — 开发规则与工作流程

本文件是 `manageable-mcp-v2` 的唯一权威开发规则。`AGENTS.md` 只负责把代理指向这里。

本项目是原 `manageable-mcp` 的破坏性重写：保留原项目的工程纪律、测试要求和提交工作流，
但明确去掉旧品牌兼容层和所有发布链路。规则与工作流程以本文件为准。

## 1. 项目边界

- 本地优先，Windows 10/11 + Node.js 20+ 是主要验证环境。
- TypeScript + ESM，包 `private: true`，只从源码本地运行。
- 不加入 npm/PyPI/crates.io 发布、Docker、Homebrew、Rust/Cargo 或 Python launcher。
- 不保留任何旧兼容层：
  - 没有 `lazy-mcp` 命令或 bin alias；
  - 没有 `lazy_mcp` Python 包；
  - 没有 `LAZY_MCP_*` 环境变量 fallback；
  - 没有 `_meta.lazyMcp*` 元数据别名；
  - 不读取 `~/.config/lazy-mcp/` 等旧目录；
  - 没有 `LazyMCPServer` 导出别名。
- 旧名称只能出现在 README/架构文档的“已移除”说明中，不能出现在运行代码、配置解析或测试断言的正向路径里。
- 配置只有一个真相：`servers.json`。默认路径：
  - Windows：`%APPDATA%\manageable-mcp\servers.json`
  - 其他平台：`$XDG_CONFIG_HOME/manageable-mcp/servers.json` 或 `~/.config/manageable-mcp/servers.json`
- 不写用户全局配置、不修改用户已有 MCP 客户端配置，除非用户明确要求。

## 2. 必须遵守的运行时约束

1. **stdout 是 MCP 协议通道**：业务日志、警告、错误、调试信息一律写 stderr；不要把日志打到 stdout。
2. **懒加载**：启动、`tools/list`、`list_servers` 不得连接任何下游服务器。第一次
   `list_commands`、`describe_commands` 或 `invoke_command` 才允许建立连接。
3. **工具缓存**：`list_commands` 默认使用缓存；`refresh: true` 必须真正绕过缓存。
4. **关闭顺序**：`closeAll()` 必须先阻止新连接，再等待在途连接，再关闭所有下游 client，
   最后清空工具缓存。SIGINT/SIGTERM 必须走同一套清理。
5. **HTTP 默认只绑 loopback**：默认 `127.0.0.1`；`Host`/`Origin` 必须校验；
   bearer token 不能为空；请求体默认上限 4 MiB；`/health` 是保留路径，不能作为 MCP path。
6. **错误结构**：代理侧失败返回 `isError: true`，并写入
   `_meta.manageableMcpProxyError = { code, message, ...details }`。不要再添加旧别名。
7. **配置严格校验**：每个 server 必须且只能有 `command` 或 `url` 之一；名称唯一；
   group 成员必须存在；空 token、非法路径、超过 `2_147_483_647` 的 timeout 必须拒绝。
8. **Windows 细节**：路径要兼容空格；配置文件要容忍 UTF-8 BOM；子进程通过 SDK 的
   stdio transport 启动，不要在业务层手写 shell 字符串拼接。
9. **秘密不落日志**：`${VAR}`、`{file:...}` 解析后的值不得写入日志、错误文本或测试快照。

## 3. 代码风格

- TypeScript 5.x，`strict`、`noUncheckedIndexedAccess` 开启。
- ESM + `module: NodeNext`；本地 import 必须带 `.js` 后缀。
- import 顺序：Node 内置模块 → 第三方包 → 本地模块。
- 类/接口使用 PascalCase；函数/变量使用 camelCase；常量使用 UPPER_SNAKE_CASE。
- 优先 interface 描述对象形状；公共函数写明确返回类型。
- 只用 `async/await`，不要回调或裸 Promise 链。
- 错误必须带上下文：`new AppError('CODE', 'message', { ... })`；不要抛裸字符串。
- 捕捉外部错误时包装原因，但不要把下游秘密拼进错误文本。
- 只在必要处写注释，解释“为什么”，不写逐行翻译代码的注释。
- 不添加版权头或许可证头，除非用户明确要求。
- 不使用单字母变量名，循环索引 `i` 除外。

## 4. 目录职责

```text
src/config/       配置模型、平台路径、解析与校验
src/core/         AppError、logger、timeout 等无业务依赖的基础设施
src/mcp/          下游 client、ServerManager、四个元工具、MCP server 工厂
src/transports/   stdio 与 Streamable HTTP 传输
tests/            Vitest 测试与 fixture
scripts/          smoke 等本地验证脚本
examples/         可直接运行的示例 MCP server
docs/             路线图与补充文档
```

跨层规则：

- `transports` 只负责协议接入，不直接实现工具逻辑。
- `mcp/tools` 负责参数校验和结果整形，不直接 spawn 子进程。
- `mcp/manager` 负责生命周期和缓存，不打印协议输出。
- `config` 不依赖 `mcp` 或 `transports`。

## 5. 测试规则

- 使用 Vitest；测试文件放在 `tests/*.test.ts`。
- 每个行为变化至少补一个对应测试；错误路径和成功路径都要覆盖。
- 配置测试必须覆盖：默认路径、BOM、环境变量、secret file、重复名称、
  `command`/`url` 冲突、group 未知成员、空 token、保留路径、timeout 上界。
- HTTP 测试必须覆盖：health、无 token/wrong token、正确 token、Host/Origin 拒绝、
  四个元工具、一次真实 `invoke_command`。
- Manager 测试必须覆盖：懒加载、工具缓存、unknown/disabled server、下游失败后的状态。
- 不 mock 掉被测核心逻辑；只 mock 外部进程/网络边界。
- 常用命令：

```powershell
npm test
npm test -- tests/config.test.ts
npm run test:watch
```

## 6. 工作流程（与原项目一致）

1. 第一次进入项目：`npm install`。
2. 开始改动前先跑基线：`npm run build`、`npm test`。
3. 小步修改；代码和测试一起改，不把测试留到最后补。
4. 提交前必须跑完整验证：

```powershell
npm run build
npm test
npm run smoke
npm run smoke:http
git diff --check
```

5. 只提交本次相关的文件；不要提交 `node_modules/`、`dist/`、日志、临时配置或秘密。
6. 使用 Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`。
7. 一个提交只做一件连贯的事；提交信息写“做了什么”，不写“改了一下”。
8. 行为、配置、CLI 或安全边界变化时，同步更新 `README.md`、`ARCHITECTURE.md` 或
   `docs/ROADMAP.md`。
9. 不创建发布 tag、不推送 registry、不修改用户全局环境。
10. 合并/交付前确认 `git status` 干净，且最后一轮全量测试通过。

## 7. 绝对禁止

- 禁止恢复任何旧品牌/旧配置/旧环境变量的兼容代码。
- 禁止把 `dist/`、`node_modules/`、真实 token 或用户配置提交进仓库。
- 禁止在 stdout 输出日志或调试信息。
- 禁止在未测试的情况下宣称“全盘通过”。
- 禁止为了通过测试而缩小功能、伪造结果或跳过错误路径。
- 禁止在没有用户明确要求时执行发布、上传或远程推送。

## 8. 完成定义

一项改动只有在以下条件同时满足时才算完成：

- 代码符合本文件的边界与风格；
- 相关测试已新增/更新并通过；
- `npm run build` 通过；
- `npm test` 全部通过；
- 两条 smoke 通过；
- 文档已同步；
- `git diff --check` 无输出；
- `git status` 只剩预期的提交内容。
