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
    tags: [],
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

    await expect(manager.listTools('missing')).rejects.toThrow(/未知服务器/);
    await expect(manager.listTools('disabled')).rejects.toThrow(/已禁用/);
  });

  it('probes a server by pulling its tools and fills the summary count', async () => {
    manager = new ServerManager([echoConfig()]);

    const result = await manager.probeServer('echo', { includeTools: true });
    expect(result).toMatchObject({ name: 'echo', ok: true, toolsCount: 3 });
    expect(result.tools?.map((tool) => tool.name)).toEqual(['echo', 'add', 'fail']);

    expect(manager.listServers()[0]).toMatchObject({
      status: 'ready',
      toolCount: 3,
      loaded: true,
      healthy: true,
    });

    const withoutTools = await manager.probeServer('echo');
    expect(withoutTools.ok).toBe(true);
    expect(withoutTools.tools).toBeUndefined();
  });

  it('probes batches with bounded concurrency and keeps input order', async () => {
    manager = new ServerManager([
      echoConfig({ name: 'first' }),
      echoConfig({ name: 'second' }),
    ]);

    const results = await manager.probeServers(['second', 'first'], { concurrency: 2 });
    expect(results.map((result) => result.name)).toEqual(['second', 'first']);
    expect(results.every((result) => result.ok)).toBe(true);

    const unknown = await manager.probeServers(['missing']);
    expect(unknown[0]).toMatchObject({ name: 'missing', ok: false, toolsCount: null });
  });
});
