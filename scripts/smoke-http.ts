import { loadConfig } from '../src/config/load.js';
import { createLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { startHttpServer } from '../src/transports/http.js';

const loaded = loadConfig('servers.example.json');
const manager = new ServerManager(loaded.config.servers);
const logger = createLogger('warn');
const running = await startHttpServer(manager, { ...loaded.config.transport, port: 0 }, logger);

async function mcp(body: unknown): Promise<any> {
  const response = await fetch(running.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

try {
  const health = await fetch(running.url.replace(/\/mcp$/, '/health'));
  if (!health.ok) throw new Error(`health failed: ${health.status}`);

  const listed = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = listed.result?.tools ?? [];
  if (tools.length !== 4) throw new Error(`expected 4 meta-tools, got ${tools.length}`);

  const called = await mcp({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'invoke_command',
      arguments: {
        server: 'echo',
        command: 'echo',
        parameters: { text: 'hello over http' },
      },
    },
  });
  const text = called.result?.content?.find((item: any) => item.type === 'text')?.text;
  if (!text?.includes('hello over http')) {
    throw new Error(`unexpected HTTP tool result: ${JSON.stringify(called)}`);
  }

  console.log(`http smoke ok: ${running.url}, 4 meta-tools, echo=${text}`);
} finally {
  await running.close();
}
