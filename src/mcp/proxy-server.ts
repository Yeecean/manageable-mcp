import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../core/logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { getToolDefinitions, handleToolCall } from './tools.js';
import type { ServerManager } from './manager.js';
import type { ProxyScope } from './proxy-scope.js';

export function createProxyServer(
  manager: ServerManager,
  logger: Logger,
  scope?: ProxyScope,
): Server {
  const promptsEnabled = manager.hasPromptForwarding(scope);
  const server = new Server(
    { name: PACKAGE_NAME, version: VERSION },
    {
      capabilities: {
        tools: {},
        ...(promptsEnabled ? { prompts: {} } : {}),
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getToolDefinitions(manager, scope);
    logger.debug('tools/list handled', { tools: tools.length });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    logger.debug('tools/call start', { tool: name });
    const result = await handleToolCall(manager, name, args, extra.signal, scope);
    logger.debug('tools/call finish', { tool: name, isError: result.isError === true });
    return result;
  });

  if (promptsEnabled) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts = await manager.listPrompts(scope);
      logger.debug('prompts/list handled', { prompts: prompts.length });
      return { prompts };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      return await manager.getPrompt(
        request.params.name,
        request.params.arguments,
        scope,
        extra.signal,
      );
    });
  }

  return server;
}
