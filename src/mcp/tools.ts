import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AppError, errorMessage } from '../core/errors.js';
import { sanitizeErrorMessage } from '../oauth/sanitize.js';
import { VERSION } from '../version.js';
import type { ServerManager } from './manager.js';
import { resolvePermission } from './permissions.js';
import type { ProxyScope } from './proxy-scope.js';

interface CommandInfo {
  name: string;
  description: string;
}

interface CommandSchema {
  name: string;
  title?: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
  annotations?: Tool['annotations'];
  _meta?: Tool['_meta'];
}

function textResult(value: unknown, structuredContent?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function errorResult(error: unknown): CallToolResult {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', errorMessage(error));
  const message = sanitizeErrorMessage(appError.message);
  return {
    content: [{ type: 'text', text: `${appError.code}: ${message}` }],
    isError: true,
    _meta: {
      manageableMcpProxyError: {
        code: appError.code,
        message,
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

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new AppError('INVALID_PARAMETERS', `${field} 必须是布尔值`);
  }
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_PARAMETERS', `${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function commandInfo(tool: Tool): CommandInfo {
  return {
    name: tool.name,
    description: tool.description ?? '',
  };
}

function commandSchema(tool: Tool): CommandSchema {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
  };
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
        `可用 filter 按名称、描述或标签进行不区分大小写的过滤。` +
        catalogSection +
        `此调用不会连接任何下游服务器。若服务器的 auth_required 已设置，` +
        `请立即把该 URL 展示给用户并请其在浏览器中打开。需要发现工具时请使用 list_commands。`,
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: '可选：按服务器名称、描述或标签关键词过滤。',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_commands',
      description:
        `列出服务器的工具名称和简短说明，不返回完整参数 schema。` +
        `单服务器使用 server，批量发现使用 servers；两者必须且只能提供一个。` +
        `refresh=true 会绕过工具缓存。调用 invoke_command 前请先使用 describe_commands。`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'list_servers 返回的精确服务器名称。' },
          servers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: '一次批量发现多个服务器；结果以服务器名称为键。',
          },
          refresh: { type: 'boolean', description: '绕过内存中的工具缓存。' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'describe_commands',
      description:
        `返回某个服务器上指定工具的完整输入 schema。` +
        `只请求你准备调用的工具；refresh=true 会先强制刷新工具列表。`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'list_servers 返回的精确服务器名称。' },
          command_names: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'list_commands 返回的工具名称。',
          },
          refresh: { type: 'boolean', description: '读取 schema 前强制刷新工具列表。' },
        },
        required: ['server', 'command_names'],
        additionalProperties: false,
      },
    },
    {
      name: 'invoke_command',
      description:
        `在某个服务器上调用一个工具。顶层只允许 server、command_name 和 parameters；` +
        `所有下游工具输入必须放在 parameters 内，下游结果会原样返回。`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'list_servers 返回的精确服务器名称。' },
          command_name: { type: 'string', description: 'list_commands 返回的工具名称。' },
          parameters: {
            type: 'object',
            description: '下游工具输入对象；不要把这些输入放到顶层。默认为空对象。',
            additionalProperties: true,
          },
        },
        required: ['server', 'command_name'],
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
      case 'list_servers': {
        if (input.filter !== undefined && typeof input.filter !== 'string') {
          throw new AppError('INVALID_PARAMETERS', 'filter 必须是字符串');
        }
        const servers = manager.listServers(scope, input.filter);
        return textResult({
          servers,
          version: VERSION,
        });
      }

      case 'list_commands': {
        const hasServer = input.server !== undefined;
        const hasServers = input.servers !== undefined;
        if (hasServer === hasServers) {
          throw new AppError(
            'INVALID_PARAMETERS',
            'list_commands 必须且只能提供 server 或 servers 之一',
          );
        }
        const refresh = optionalBoolean(input.refresh, 'refresh');
        if (hasServer) {
          const server = requireString(input.server, 'server');
          assertVisible(server, scope);
          const tools = await manager.listTools(server, refresh);
          manager.touchActivity();
          const commands = tools.map(commandInfo);
          return textResult(commands);
        }

        const servers = Array.from(new Set(requireStringArray(input.servers, 'servers')));
        const result: Record<string, CommandInfo[]> = {};
        for (const server of servers) {
          assertVisible(server, scope);
          const tools = await manager.listTools(server, refresh);
          result[server] = tools.map(commandInfo);
        }
        manager.touchActivity();
        return textResult(result, result);
      }

      case 'describe_commands': {
        const server = requireString(input.server, 'server');
        assertVisible(server, scope);
        const commands = requireStringArray(input.command_names, 'command_names');
        const refresh = optionalBoolean(input.refresh, 'refresh');
        const tools = await manager.listTools(server, refresh);
        manager.touchActivity();
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        const missing = commands.filter((command) => !byName.has(command));
        if (missing.length > 0) {
          throw new AppError(
            'TOOL_NOT_FOUND',
            `服务器 '${server}' 没有这些工具：${missing.join(', ')}`,
            { server, command_names: missing },
          );
        }
        return textResult(commands.map((command) => commandSchema(byName.get(command) as Tool)));
      }

      case 'invoke_command': {
        const server = requireString(input.server, 'server');
        assertVisible(server, scope);
        const commandName = requireString(input.command_name, 'command_name');
        const unexpectedKeys = Object.keys(input).filter(
          (key) => key !== 'server' && key !== 'command_name' && key !== 'parameters',
        );
        if (unexpectedKeys.length > 0) {
          throw new AppError(
            'INVALID_PARAMETERS',
            'invoke_command 要求把所有下游工具输入放在 parameters 内，不要把参数放到顶层',
            { server, unexpectedKeys },
          );
        }
        const parameters = optionalObject(input.parameters, 'parameters');
        const config = manager.getServerConfig(server);
        const decision = resolvePermission(
          server,
          commandName,
          config?.permissions,
          manager.getGlobalPermissions(),
        );
        if (decision.action === 'deny') {
          throw new AppError(
            'POLICY_BLOCKED',
            decision.message ?? `权限策略拒绝了 '${server}/${commandName}'。`,
            { server, command: commandName, policySource: decision.source },
          );
        }
        manager.touchActivity();
        return await manager.callTool(server, commandName, parameters, signal);
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
