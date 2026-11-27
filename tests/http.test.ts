import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config/types.js';
import { createLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { startHttpServer, type RunningHttpServer } from '../src/transports/http.js';

const root = path.resolve(__dirname, '..');
const authToken = 'test-secret';
let manager: ServerManager;
let server: RunningHttpServer;

const echo: ServerConfig = {
  name: 'echo',
  description: 'Demo',
  enabled: true,
  command: process.execPath,
  args: [path.join(root, 'examples', 'echo-server.mjs')],
  cwd: root,
  env: {},
  headers: {},
  timeoutMs: 10_000,
};

beforeAll(async () => {
  manager = new ServerManager([echo]);
  server = await startHttpServer(
    manager,
    {
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authToken,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 64 * 1024,
    },
    createLogger('error'),
  );
});

afterAll(async () => {
  await server.close();
});

async function rpc(body: unknown, token?: string): Promise<Response> {
  return await fetch(server.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('HTTP transport', () => {
  it('exposes health without auth', async () => {
    const response = await fetch(server.url.replace(/\/mcp$/, '/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', name: 'manageable-mcp' });
  });

  it('rejects health requests from a non-loopback origin', async () => {
    const response = await fetch(server.url.replace(/\/mcp$/, '/health'), {
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  it('rejects missing and wrong bearer tokens', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')).status).toBe(401);
  });

  it('serves four meta-tools and proxies a call with a valid token', async () => {
    const listed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, authToken);
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as any;
    expect(listBody.result.tools.map((tool: any) => tool.name)).toEqual([
      'list_servers',
      'list_commands',
      'describe_commands',
      'invoke_command',
    ]);

    const called = await rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'invoke_command',
          arguments: {
            server: 'echo',
            command: 'echo',
            parameters: { text: 'http-test' },
          },
        },
      },
      authToken,
    );
    expect(called.status).toBe(200);
    const callBody = await called.json() as any;
    expect(callBody.result.content[0]).toEqual({ type: 'text', text: 'http-test' });
  });
});
