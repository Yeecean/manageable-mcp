import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AppError, errorMessage } from '../core/errors.js';
import type { ServerManager } from './manager.js';
import { resolvePermission } from './permissions.js';
import type { ProxyScope } from './proxy-scope.js';

function textResult(value: unknown, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function errorResult(error: unknown): CallToolResult {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', errorMessage(error));
  return {
    content: [{ type: 'text', text: `${appError.code}: ${appError.message}` }],
    isError: true,
    _meta: {
      manageableMcpProxyError: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ?? {}),
      },
    },
  };
}

function catalog(manager: ServerManager, scope?: ProxyScope): string {
  const embed = manager.getEmbedServerSummaries();
  if (!embed.enabled) return '';
  const servers = manager.listServers(scope).filter((server) => server.enabled);
  if (servers.length === 0) return '当前没有已启用的服务器。';
  const lines = servers.map(
    (server) => `- ${server.name}: ${server.description.replace(/\s+/g, ' ')}`,
  );
  const text = lines.join('\n');
  const warnings: string[] = [];
  if (embed.maxDescriptionChars !== undefined) {
    const tooLong = servers.filter(
      (server) => server.description.length > (embed.maxDescriptionChars as number),
    );
    if (tooLong.length > 0) {
      warnings.push(
        `注意：${tooLong.length} 个服务器的描述超过 ${embed.maxDescriptionChars} 字符，未截断。`,
      );
    }
  }
  if (embed.maxCatalogChars !== undefined && text.length > embed.maxCatalogChars) {
    warnings.push(
      `注意：内嵌目录超过 ${embed.maxCatalogChars} 字符，未截断。`,
    );
  }
  return warnings.length === 0 ? text : `${text}\n\n${warnings.join('\n')}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_PARAMETERS', `${field} 必须是非空字符串`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new AppError('INVALID_PARAMETERS', `${field} 必须是非空字符串数组`);
  }
  return value as string[];
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_PARAMETERS', `${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function getToolDefinitions(manager: ServerManager, scope?: ProxyScope): Tool[] {
  const serverCatalog = catalog(manager, scope);
  const catalogSection = serverCatalog
    ? `这里直接内嵌已启用服务器目录，无需额外调用工具即可选择：\n\n${serverCatalog}\n\n`
    : '';

  return [
    {
      name: 'list_servers',
      description:
        `列出已配置的 MCP 服务器及其当前状态。` +
        catalogSection +
        `此调用不会连接任何下游服务器。需要发现某个服务器的工具时，请使用 list_commands。`,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_commands',
      description:
        `列出某个已配置服务器的工具名称和简短说明。` +
        `首次使用时会懒加载连接。调用 invoke_command 前请先使用 describe_commands。`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'list_servers 返回的精确服务器名称。' },
          refresh: { type: 'boolean', description: '绕过内存中的工具缓存。' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    {
      name: 'describe_commands',
      description:
        `返回某个服务器上指定工具的完整输入 schema。` +
        `只请求你准备调用的工具；schema 是暴露信息最多的一层。`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'list_servers 返回的精确服务器名称。' },
          commands: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'list_commands 返回的工具名称。',
          },
        },
        required: ['server', 'commands'],
        additionalProperties: false,
      },
    },
    {
      name: 'invoke_command',
      description:
        `在某个服务器上调用一个工具。server、command 和 parameters 保持在顶层；` +
        `所有下游工具输入都放在 parameters 内。`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'list_servers 返回的精确服务器名称。' },
          command: { type: 'string', description: 'list_commands 返回的工具名称。' },
          parameters: {
            type: 'object',
            description: '下游工具参数，默认为空对象。',
            additionalProperties: true,
          },
        },
        required: ['server', 'command'],
        additionalProperties: false,
      },
    },
  ];
}

export async function handleToolCall(
  manager: ServerManager,
  name: string,
  rawArgs: unknown,
  signal?: AbortSignal,
  scope?: ProxyScope,
): Promise<CallToolResult> {
  const args = rawArgs === undefined ? {} : rawArgs;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return errorResult(new AppError('INVALID_PARAMETERS', '工具参数必须是对象'));
  }
  const input = args as Record<string, unknown>;

  try {
    switch (name) {
      case 'list_servers':
        return textResult(
          { servers: manager.listServers(scope) },
          { servers: manager.listServers(scope) },
        );

      case 'list_commands': {
        const server = requireString(input.server, 'server');
        assertVisible(server, scope);
        const refresh = input.refresh === true;
        const tools = await manager.listTools(server, refresh);
        manager.touchActivity();
        const result = {
          server,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
          })),
        };
        return textResult(result, result);
      }

      case 'describe_commands': {
        const server = requireString(input.server, 'server');
        assertVisible(server, scope);
        const commands = requireStringArray(input.commands, 'commands');
        const tools = await manager.listTools(server);
        manager.touchActivity();
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        const missing = commands.filter((command) => !byName.has(command));
        if (missing.length > 0) {
          throw new AppError(
            'TOOL_NOT_FOUND',
            `服务器 '${server}' 没有这些工具：${missing.join(', ')}`,
            { server, commands: missing },
          );
        }
        const result = {
          server,
          tools: commands.map((command) => {
            const tool = byName.get(command) as Tool;
            return {
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema,
            };
          }),
        };
        return textResult(result, result);
      }

      case 'invoke_command': {
        const server = requireString(input.server, 'server');
        assertVisible(server, scope);
        const command = requireString(input.command, 'command');
        const parameters = optionalObject(input.parameters, 'parameters');
        const config = manager.getServerConfig(server);
        const decision = resolvePermission(
          server,
          command,
          config?.permissions,
          manager.getGlobalPermissions(),
        );
        if (decision.action === 'deny') {
          throw new AppError(
            'POLICY_BLOCKED',
            decision.message ?? `权限策略拒绝了 '${server}/${command}'。`,
            { server, command, policySource: decision.source },
          );
        }
        manager.touchActivity();
        return await manager.callTool(server, command, parameters, signal);
      }

      default:
        throw new AppError('TOOL_NOT_FOUND', `未知元工具 '${name}'`);
    }
  } catch (error) {
    return errorResult(error);
  }
}

function assertVisible(server: string, scope?: ProxyScope): void {
  if (scope !== undefined && !scope.allowedServers.has(server)) {
    throw new AppError(
      'SERVER_NOT_FOUND',
      `分组 '${scope.group}' 中不存在服务器 '${server}'。`,
      { server, group: scope.group },
    );
  }
}
