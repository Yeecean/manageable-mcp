import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { silentLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { createProxyServer } from '../src/mcp/proxy-server.js';
import { getToolDefinitions } from '../src/mcp/tools.js';

const root = path.resolve(__dirname, '..');

let manager: ServerManager | undefined;
let proxy: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  await manager?.closeAll();
  client = undefined;
  proxy = undefined;
  manager = undefined;
});

describe('proxy meta-tools', () => {
  it('exposes four tools and proxies invoke_command', async () => {
    manager = new ServerManager([
      {
        name: 'echo',
        description: 'Demo',
        enabled: true,
        command: process.execPath,
        args: [path.join(root, 'examples', 'echo-server.mjs')],
        cwd: root,
        env: {},
        headers: {},
        timeoutMs: 10_000,
        forwardPrompts: false,
      },
    ]);
    proxy = createProxyServer(manager, silentLogger);
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), proxy.connect(serverTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'list_servers',
      'list_commands',
      'describe_commands',
      'invoke_command',
    ]);

    const servers = await client.callTool({ name: 'list_servers', arguments: {} });
    expect(servers.content?.[0]).toMatchObject({ type: 'text' });

    const echo = await client.callTool({
      name: 'invoke_command',
      arguments: {
        server: 'echo',
        command_name: 'echo',
        parameters: { text: 'hello' },
      },
    });
    expect(echo.content?.[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('honors the embedServerSummaries switch in the list_servers description', async () => {
    const servers = [
      {
        name: 'echo',
        description: 'Demo server',
        enabled: true,
        command: process.execPath,
        args: [path.join(root, 'examples', 'echo-server.mjs')],
        cwd: root,
        env: {},
        headers: {},
        timeoutMs: 10_000,
        forwardPrompts: false,
        tags: [],
      },
    ];

    const withCatalog = new ServerManager(servers);
    const enabledDescription = getToolDefinitions(withCatalog)
      .find((tool) => tool.name === 'list_servers')?.description ?? '';
    expect(enabledDescription).toContain('- echo: Demo server');

    const withoutCatalog = new ServerManager(servers, {
      embedServerSummaries: { enabled: false },
    });
    const disabledDescription = getToolDefinitions(withoutCatalog)
      .find((tool) => tool.name === 'list_servers')?.description ?? '';
    expect(disabledDescription).not.toContain('- echo: Demo server');

    await withCatalog.closeAll();
    await withoutCatalog.closeAll();
  });
});
