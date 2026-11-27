import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseConfig } from '../src/config/load.js';
import { getDefaultConfigPath } from '../src/config/paths.js';

const base = path.join(os.tmpdir(), 'manageable-mcp-v2-config.json');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config parsing', () => {
  it('normalizes a local server and resolves cwd relative to the config', () => {
    const config = parseConfig(
      {
        servers: [
          {
            name: 'echo',
            description: 'Demo',
            command: 'node',
            args: ['echo.mjs'],
            cwd: '.',
          },
        ],
      },
      base,
    );

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({
      name: 'echo',
      enabled: true,
      timeoutMs: 15_000,
      args: ['echo.mjs'],
      cwd: path.dirname(base),
    });
    expect(config.transport).toMatchObject({ host: '127.0.0.1', port: 8080, path: '/mcp' });
  });

  it('expands environment variables and secret files', () => {
    vi.stubEnv('DEMO_TOKEN', 'abc123');
    const secretPath = path.join(os.tmpdir(), 'manageable-mcp-v2-secret.txt');
    fs.writeFileSync(secretPath, 'file-secret\n');
    try {
      const config = parseConfig(
        {
          servers: [
            {
              name: 'remote',
              description: 'Remote',
              url: 'https://example.com/mcp',
              headers: {
                Authorization: 'Bearer ${DEMO_TOKEN}',
                'X-File-Secret': `{file:${secretPath}}`,
              },
            },
          ],
        },
        base,
      );
      expect(config.servers[0]?.headers.Authorization).toBe('Bearer abc123');
      expect(config.servers[0]?.headers['X-File-Secret']).toBe('file-secret');
    } finally {
      fs.rmSync(secretPath, { force: true });
    }
  });

  it('rejects duplicate names and ambiguous transports', () => {
    expect(() =>
      parseConfig(
        {
          servers: [
            { name: 'x', description: 'one', command: 'node' },
            { name: 'x', description: 'two', command: 'node' },
          ],
        },
        base,
      ),
    ).toThrow(/服务器名称 'x' 重复/);

    expect(() =>
      parseConfig(
        {
          servers: [
            {
              name: 'x',
              description: 'both',
              command: 'node',
              url: 'https://example.com/mcp',
            },
          ],
        },
        base,
      ),
    ).toThrow(/必须且只能设置 command 或 url/);
  });

  it('rejects unknown group members', () => {
    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node' }],
          groups: { dev: { servers: ['missing'] } },
        },
        base,
      ),
    ).toThrow(/未知服务器 'missing'/);
  });

  it('rejects an empty token after environment expansion', () => {
    vi.stubEnv('EMPTY_TOKEN', '');
    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node' }],
          transport: { authToken: '${EMPTY_TOKEN}' },
        },
        base,
      ),
    ).toThrow(/展开后不能为空/);
  });

  it('rejects reserved health paths and oversized timeouts', () => {
    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node' }],
          transport: { path: '/health' },
        },
        base,
      ),
    ).toThrow(/健康检查保留路径/);

    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node', timeoutMs: 2_147_483_648 }],
        },
        base,
      ),
    ).toThrow(/timeoutMs 必须 <=/);
  });
});

describe('default config path', () => {
  it('uses the platform config root and never the legacy directory', () => {
    if (process.platform === 'win32') {
      vi.stubEnv('APPDATA', 'C:\\Users\\demo\\AppData\\Roaming');
      expect(getDefaultConfigPath()).toBe(
        path.join('C:\\Users\\demo\\AppData\\Roaming', 'manageable-mcp', 'servers.json'),
      );
    } else {
      vi.stubEnv('XDG_CONFIG_HOME', '/home/demo/.config');
      expect(getDefaultConfigPath()).toBe('/home/demo/.config/manageable-mcp/servers.json');
    }
  });
});

describe('config file loading', () => {
  it('accepts a UTF-8 BOM written by Windows editors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-v2-bom-'));
    const file = path.join(dir, 'servers.json');
    try {
      fs.writeFileSync(
        file,
        '\uFEFF' + JSON.stringify({ servers: [{ name: 'x', description: 'one', command: 'node' }] }),
      );
      expect(loadConfig(file).config.servers[0]?.name).toBe('x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
