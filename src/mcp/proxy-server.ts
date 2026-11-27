import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../core/logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { getToolDefinitions, handleToolCall } from './tools.js';
import type { ServerManager } from './manager.js';

export function createProxyServer(manager: ServerManager, logger: Logger): Server {
  const server = new Server(
    { name: PACKAGE_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getToolDefinitions(manager);
    logger.debug('tools/list handled', { tools: tools.length });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    logger.debug('tools/call start', { tool: name });
    const result = await handleToolCall(manager, name, args, extra.signal);
    logger.debug('tools/call finish', { tool: name, isError: result.isError === true });
    return result;
  });

  return server;
}
