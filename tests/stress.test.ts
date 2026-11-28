import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config/types.js';
import { ServerManager } from '../src/mcp/manager.js';

const root = path.resolve(__dirname, '..');

function config(name: string): ServerConfig {
  return {
    name,
    description: `${name} fixture`,
    enabled: true,
    command: process.execPath,
    args: [path.join(root, 'examples', 'echo-server.mjs')],
    cwd: root,
    env: {},
    headers: {},
    timeoutMs: 5_000,
    forwardPrompts: false,
    tags: [],
  };
}

let manager: ServerManager | undefined;

afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
});

describe('concurrency and timeout guards', () => {
  it('keeps batch probes within the requested concurrency', async () => {
    const names = ['one', 'two', 'three', 'four', 'five', 'six'];
    manager = new ServerManager(names.map(config));
    let active = 0;
    let maxActive = 0;

    for (const name of names) {
      const entry = (manager as unknown as {
        entries: Map<string, { client?: Record<string, unknown>; status: string }>;
      }).entries.get(name);
      if (!entry) throw new Error(`missing entry ${name}`);
      entry.status = 'ready';
      entry.client = {
        promptsSupported: false,
        listTools: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return [{ name: 'echo', inputSchema: { type: 'object' } }];
        },
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
      };
    }

    const results = await manager.probeServers(names, { concurrency: 2 });
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxActive).toBe(2);
  });

  it('turns a downstream probe timeout into a failed probe', async () => {
    manager = new ServerManager([config('slow')]);
    const entry = (manager as unknown as {
      entries: Map<string, { client?: Record<string, unknown>; status: string }>;
    }).entries.get('slow');
    if (!entry) throw new Error('missing slow entry');
    entry.status = 'ready';
    entry.client = {
      promptsSupported: false,
      listTools: async () => await new Promise<never>(() => undefined),
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    };

    const result = await manager.probeServer('slow', { timeoutMs: 25 });
    expect(result).toMatchObject({ name: 'slow', ok: false, toolsCount: null });
    expect(result.error).toContain('超时');
    expect(manager.listServers()[0]?.status).toBe('error');
  });
});
