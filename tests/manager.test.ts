import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerManager } from '../src/mcp/manager.js';
import type { ServerConfig } from '../src/config/types.js';

const root = path.resolve(__dirname, '..');

function echoConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
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
    ...overrides,
  };
}

let manager: ServerManager | undefined;

afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
});

describe('ServerManager', () => {
  it('lists tools lazily and calls a downstream tool', async () => {
    manager = new ServerManager([echoConfig()]);

    expect(manager.listServers()[0]).toMatchObject({ name: 'echo', status: 'idle' });
    const tools = await manager.listTools('echo');
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'add', 'fail']);
    expect(manager.listServers()[0]).toMatchObject({ status: 'ready', toolCount: 3 });

    const result = await manager.callTool('echo', 'add', { a: 2, b: 3 });
    expect(result.content?.[0]).toEqual({ type: 'text', text: '5' });
  });

  it('rejects unknown and disabled servers', async () => {
    manager = new ServerManager([
      echoConfig({ name: 'disabled', enabled: false }),
    ]);

    await expect(manager.listTools('missing')).rejects.toThrow(/Unknown server/);
    await expect(manager.listTools('disabled')).rejects.toThrow(/disabled/);
  });
});
