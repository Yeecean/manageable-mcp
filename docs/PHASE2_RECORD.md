# 阶段二实施记录

日期：2026-11-28。工作目标是补齐目录说明、代表性任务评测基础和客户端接入流程。

## 设计决策

- 继续由 `servers.json` 管理下游服务器；客户端配置只保存启动代理的命令，不复制服务器或密钥。
- Claude Code、Codex、OpenCode 2.x、Cursor 分别按各自用户配置格式写入；JSONC/TOML 编辑后复核
  除目标条目外的配置，格式不合法或存在同名冲突时默认拒绝修改。
- 显式替换时先保存原文件；操作使用锁和原子替换，回滚前校验文件及备份，避免覆盖后续改动。
- 接入前以真实 stdio MCP 握手检查代理和四个元工具。该检查不等同于各客户端内部的连接验收。
- 面板和命令行共享实现；接入操作只在用户主动触发时写入客户端配置。
- 目录评测集的标准答案与提供给 Agent 的提示分离，评分工具不代替真实模型测试。

## 执行指令

```powershell
npm run build
npm test
npm run smoke
npm run smoke:http
npm run test:e2e
node scripts/verify-client-apps.mjs
node scripts/evaluate-catalog.mjs prompt
git diff --check
```

## 实现和验证证据

- 修改前 Windows 基线：构建通过，16 个测试文件、136 项测试通过。
- 本轮 Windows 验证：构建通过，20 个测试文件、160 项测试通过；stdio smoke、HTTP smoke 和
  本地端到端测试通过，覆盖代理、分组、权限、管理 API、健康探测、attach 和 prompts。
- 客户端配置的安装、更新、冲突保护、回滚、备份校验、代理握手和管理界面有隔离测试。
- 浏览器中展开过客户端接入区域，确认四种客户端状态与操作按钮显示，未点击任何真实配置写入操作。
- Claude Code 2.1.325 在临时用户配置下识别并连接；Codex CLI 0.167.0 在临时配置下识别条目。
- OpenCode 2.2.7 在临时目录读取了生成的配置，但 `mcp list --standalone` 没有列出条目；其自身
  `mcp add --global` 新增的对照条目同样不显示。暂不能判断根因，也不能报告真实连接成功。
- Cursor 配置生成及代理握手通过隔离测试，尚未在 Cursor 图形界面验证连接。
- 18 个目录任务和计分程序已建立；尚未取得真实 Agent 作答结果。

## 验收结论

阶段二基础功能已经实现，但客户端真实连接和真实 Agent 目录选择评测尚未全部验证，因此本阶段
仍标记为“部分完成”。市场与运行模式属于后续阶段，尚未开始。
