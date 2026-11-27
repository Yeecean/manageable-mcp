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
  const servers = manager.listServers(scope).filter((server) => server.enabled);
  if (servers.length === 0) return 'No enabled servers are configured.';
  return servers.map((server) => `- ${server.name}: ${server.description}`).join('\n');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_PARAMETERS', `${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new AppError('INVALID_PARAMETERS', `${field} must be a non-empty array of strings`);
  }
  return value as string[];
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_PARAMETERS', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function getToolDefinitions(manager: ServerManager, scope?: ProxyScope): Tool[] {
  const serverCatalog = catalog(manager, scope);

  return [
    {
      name: 'list_servers',
      description:
        `List the configured MCP servers and their current state. ` +
        `The enabled server catalog is embedded here so you can choose without a tool call:\n\n${serverCatalog}\n\n` +
        `This call does not connect to any downstream server. Use list_commands to discover a server's tools.`,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_commands',
      description:
        `List tool names and short descriptions for one configured server. ` +
        `This connects lazily on first use. Call describe_commands before invoke_command.`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Exact server name from list_servers.' },
          refresh: { type: 'boolean', description: 'Bypass the in-memory tool cache.' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    {
      name: 'describe_commands',
      description:
        `Return the full input schema for specific tools on one server. ` +
        `Request only the tools you intend to call; schemas are the largest disclosure layer.`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Exact server name from list_servers.' },
          commands: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Tool names returned by list_commands.',
          },
        },
        required: ['server', 'commands'],
        additionalProperties: false,
      },
    },
    {
      name: 'invoke_command',
      description:
        `Invoke one tool on one server. Keep server, command, and parameters at the top level; ` +
        `all downstream tool inputs belong inside parameters.`,
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Exact server name from list_servers.' },
          command: { type: 'string', description: 'Tool name returned by list_commands.' },
          parameters: {
            type: 'object',
            description: 'Downstream tool arguments. Defaults to an empty object.',
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
    return errorResult(new AppError('INVALID_PARAMETERS', 'Tool arguments must be an object'));
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
            `Server '${server}' has no tool(s): ${missing.join(', ')}`,
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
            decision.message ?? `Permission policy denied '${server}/${command}'.`,
            { server, command, policySource: decision.source },
          );
        }
        manager.touchActivity();
        return await manager.callTool(server, command, parameters, signal);
      }

      default:
        throw new AppError('TOOL_NOT_FOUND', `Unknown meta-tool '${name}'`);
    }
  } catch (error) {
    return errorResult(error);
  }
}

function assertVisible(server: string, scope?: ProxyScope): void {
  if (scope !== undefined && !scope.allowedServers.has(server)) {
    throw new AppError(
      'SERVER_NOT_FOUND',
      `Unknown server '${server}' in group '${scope.group}'.`,
      { server, group: scope.group },
    );
  }
}
