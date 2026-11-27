import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Logger } from '../core/logger.js';
import { createProxyServer } from '../mcp/proxy-server.js';
import type { ServerManager } from '../mcp/manager.js';

export async function startStdioServer(manager: ServerManager, logger: Logger): Promise<void> {
  const server = createProxyServer(manager, logger);
  const transport = new StdioServerTransport();
  let stopping = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { reason });
    await manager.closeAll();
    await server.close().catch(() => undefined);
  };

  transport.onclose = () => {
    void shutdown('transport closed').finally(() => process.exit(0));
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });

  await server.connect(transport);
  logger.info('stdio server ready');
}
