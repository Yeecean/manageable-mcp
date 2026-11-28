# 服务器目录说明与评测

代理会把启用服务器的 `name` 和 `description` 放进 `list_servers` 的工具说明。Agent 可以先读目录，
再按需调用 `list_commands` 和 `describe_commands`；读取目录本身不会连接下游服务器。

## 如何写描述

一条描述应回答四个问题：这个服务能做什么、适合什么任务、有哪些关键能力边界、什么时候应选择它。
先写用户能理解的动作和对象，再写易混淆的限制；需要时给一个典型任务。不要写密钥、登录信息、
内部地址或未经验证的能力，也不要靠堆砌标签掩盖边界。

例如：

```json
{
  "name": "library_docs",
  "description": "查询软件库和开发框架的官方文档及示例，例如查 React API；不负责普通新闻搜索。"
}
```

`tags` 和 `examples` 可以补充分类与示例，但不会替代 `description`。目录长度告警由
`embedServerSummaries.maxDescriptionChars` 和 `maxCatalogChars` 控制；超过时不会静默截断。

运行 `node dist/index.js catalog check` 可只读统计当前配置中各服务器的描述长度、示例和标签数量；
使用 `--config <路径>` 检查其他配置，或加 `--json` 输出机器可读结果。该命令不展开密钥、不连接服务器，
也不修改配置；“描述较短”只是人工复查提示，并不能自动判断语义质量。

## 代表性任务评测

仓库提供 8 个合成服务器及 18 个任务，覆盖相近工具的选择和没有合适服务器的情况。
先生成不含标准答案的提示，将其交给要评测的 Agent，要求它只返回任务编号到服务器名称的 JSON：

```powershell
node scripts/evaluate-catalog.mjs prompt
node scripts/evaluate-catalog.mjs score "C:\path\answers.json"
```

第二条命令检查任务编号、服务器名称和答案完整性，并列出正确数量与错题。标准答案保存在
`tests/fixtures/catalog-evaluation.json`，不应在作答前提供给被评测的 Agent。该工具只负责出题和
评分，不会自动调用模型；项目尚未完成真实 Agent 的代表性任务评测，也没有宣称某个准确率。
