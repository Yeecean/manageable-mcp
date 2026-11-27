import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('returns legacy server fields, filters case-insensitively, and redacts targets', () => {
    manager = new ServerManager([
      echoConfig({
        examples: [{ command: 'echo', description: 'Echo text' }],
        tags: ['Local', 'Fixture'],
      }),
      {
        name: 'remote',
        description: 'Remote API',
        enabled: true,
        url: 'https://url-user:url-pass-1@example.com/mcp?key=secret&region=cn',
        args: [],
        env: {},
        headers: {},
        timeoutMs: 10_000,
        forwardPrompts: false,
        tags: ['Remote'],
      },
      {
        name: 'secret-command',
        description: 'Command with a secret',
        enabled: true,
        command: 'node',
        args: ['server.mjs', '--api-key', 'super-secret'],
        env: {},
        headers: {},
        timeoutMs: 10_000,
        forwardPrompts: false,
        tags: [],
      },
    ]);

    const byTag = manager.listServers(undefined, 'fixture');
    expect(byTag).toHaveLength(1);
    expect(byTag[0]).toMatchObject({
      name: 'echo',
      tools_count: null,
      examples: [{ command: 'echo', description: 'Echo text' }],
      tags: ['Local', 'Fixture'],
    });

    const remote = manager.listServers().find((server) => server.name === 'remote');
    expect(remote?.target).toBe('https://example.com/mcp?key=***&region=cn');
    expect(remote?.target).not.toContain('url-user');
    expect(remote?.target).not.toContain('url-pass-1');

    const command = manager.listServers().find((server) => server.name === 'secret-command');
    expect(command?.target).toBe('node server.mjs --api-key ***');
    expect(command?.target).not.toContain('super-secret');
  });

  it('preserves unchanged server runtime state across reconfigure', async () => {
    const first = echoConfig({ name: 'first' });
    const second = echoConfig({ name: 'second' });
    manager = new ServerManager([first, second]);

    await manager.probeServers(['first', 'second'], { concurrency: 2 });
    expect(manager.listServers()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'first', status: 'ready', tools_count: 3 }),
        expect.objectContaining({ name: 'second', status: 'ready', tools_count: 3 }),
      ]),
    );

    const secondWithDifferentKeyOrder = Object.fromEntries(
      Object.entries(second).reverse(),
    ) as unknown as ServerConfig;
    await manager.reconfigure(
      [{ ...first, enabled: false }, secondWithDifferentKeyOrder],
      { groups: { remaining: { servers: ['second'] } } },
    );

    const after = manager.listServers();
    expect(after.find((server) => server.name === 'first')).toMatchObject({
      status: 'idle',
      tools_count: null,
    });
    expect(after.find((server) => server.name === 'second')).toMatchObject({
      status: 'ready',
      tools_count: 3,
      healthy: true,
      health: { healthy: true },
    });
    expect(manager.getGroups().remaining).toEqual({ servers: ['second'] });
  });

  it('clears stale OAuth health after successful requests', async () => {
    manager = new ServerManager([echoConfig()]);
    const entry = (manager as unknown as {
      entries: Map<string, {
        client?: Record<string, unknown>;
        status: string;
        health?: Record<string, unknown>;
      }>;
    }).entries.get('echo');
    expect(entry).toBeDefined();
    const close = vi.fn(async () => undefined);
    entry!.client = {
      listTools: async () => [{ name: 'echo', inputSchema: { type: 'object' } }],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      promptsSupported: false,
      close,
    };
    entry!.status = 'auth';
    entry!.health = {
      healthy: false,
      lastChecked: 1,
      authRequired: true,
      authUrl: 'https://auth.example/authorize',
    };
    expect(manager.listServers()[0]).toMatchObject({
      authRequired: true,
      auth_required: 'https://auth.example/authorize',
    });

    await manager.listTools('echo');
    expect(manager.listServers()[0]?.health).toMatchObject({ healthy: true });
    expect(manager.listServers()[0]?.health?.authRequired).toBeUndefined();
    expect(manager.listServers()[0]?.health?.authUrl).toBeUndefined();

    entry!.status = 'auth';
    entry!.health = {
      healthy: false,
      lastChecked: 1,
      authRequired: true,
      authUrl: 'https://auth.example/authorize',
    };
    await manager.callTool('echo', 'echo', {});
    expect(manager.listServers()[0]?.health).toMatchObject({ healthy: true });
    expect(manager.listServers()[0]?.auth_required).toBeUndefined();
  });

  it('closes a failed prompts client and waits for in-flight calls before closing', async () => {
    manager = new ServerManager([echoConfig({ forwardPrompts: true })]);
    const entry = (manager as unknown as {
      entries: Map<string, {
        client?: Record<string, unknown>;
        status: string;
      }>;
    }).entries.get('echo');
    expect(entry).toBeDefined();
    const promptsClose = vi.fn(async () => undefined);
    entry!.client = {
      promptsSupported: true,
      listPrompts: async () => {
        throw new Error('prompts exploded');
      },
      close: promptsClose,
    };

    await manager.listPrompts();
    expect(promptsClose).toHaveBeenCalledTimes(1);
    expect(manager.listServers()[0]).toMatchObject({ status: 'error' });

    let release!: (value: unknown) => void;
    const callClose = vi.fn(async () => undefined);
    const started = new Promise<void>((resolve) => {
      entry!.client = {
        callTool: async () => {
          resolve();
          return await new Promise((resolveCall) => {
            release = resolveCall;
          });
        },
        close: callClose,
      };
    });
    const call = manager.callTool('echo', 'echo', {});
    await started;
    const closeAll = manager.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const closedEarly = callClose.mock.calls.length > 0;
    release({ content: [{ type: 'text', text: 'done' }] });
    await expect(call).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    await closeAll;
    expect(closedEarly).toBe(false);
    expect(callClose).toHaveBeenCalledTimes(1);
  });
});
