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
  it('parses tags, examples, per-server health checks, and embed summaries', () => {
    const config = parseConfig(
      {
        embedServerSummaries: { enabled: false, maxDescriptionChars: 120 },
        servers: [
          {
            name: 'enriched',
            description: 'Enriched server',
            command: 'node',
            tags: ['files', ' local '],
            examples: [{ command: 'read_file', description: '读取一个文件' }],
            healthCheck: { enabled: true, method: 'ping', timeoutMs: 3_000 },
          },
        ],
      },
      base,
    );

    expect(config.embedServerSummaries).toEqual({
      enabled: false,
      maxDescriptionChars: 120,
    });
    expect(config.servers[0]).toMatchObject({
      tags: ['files', ' local '],
      examples: [{ command: 'read_file', description: '读取一个文件' }],
      healthCheck: {
        enabled: true,
        method: 'ping',
        timeoutMs: 3_000,
        cacheDurationMs: 60_000,
      },
    });
  });

  it('defaults embed summaries on and rejects invalid health check methods', () => {
    const config = parseConfig(
      { servers: [{ name: 'echo', description: 'Demo', command: 'node' }] },
      base,
    );
    expect(config.embedServerSummaries).toEqual({ enabled: true });
    expect(config.servers[0]?.tags).toEqual([]);

    expect(() =>
      parseConfig(
        {
          servers: [
            {
              name: 'bad',
              description: 'Bad',
              command: 'node',
              healthCheck: { enabled: true, method: 'wat' },
            },
          ],
        },
        base,
      ),
    ).toThrow(/healthCheck\.method/);
  });

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

  it('accepts an array command and a zero health-cache duration', () => {
    const config = parseConfig(
      {
        servers: [
          {
            name: 'array-command',
            description: 'Array command',
            command: ['node', 'server.mjs'],
            args: ['--flag'],
            healthCheck: {
              enabled: true,
              cacheDurationMs: 0,
            },
          },
        ],
      },
      base,
    );

    expect(config.servers[0]).toMatchObject({
      command: 'node',
      args: ['server.mjs', '--flag'],
      healthCheck: { enabled: true, cacheDurationMs: 0 },
    });
  });

  it('expands environment variables and secret files', () => {
    vi.stubEnv('DEMO_TOKEN', 'abc123');
    vi.stubEnv('OAUTH_ID', 'oauth-client');
    vi.stubEnv('OAUTH_SCOPE', 'mcp.read');
    const secretPath = path.join(os.tmpdir(), 'manageable-mcp-v2-secret.txt');
    fs.writeFileSync(secretPath, 'file-secret\n');
    try {
      const config = parseConfig(
        {
          servers: [
            {
              name: 'remote',
              description: 'Remote',
              url: `https://example.com/mcp?key={file:${secretPath}}`,
              headers: {
                Authorization: 'Bearer ${DEMO_TOKEN}',
                'X-File-Secret': `{file:${secretPath}}`,
              },
              oauth: {
                clientId: '${OAUTH_ID}',
                clientSecret: `{file:${secretPath}}`,
                scope: '${OAUTH_SCOPE}',
              },
            },
          ],
        },
        base,
      );
      expect(config.servers[0]?.headers.Authorization).toBe('Bearer abc123');
      expect(config.servers[0]?.headers['X-File-Secret']).toBe('file-secret');
      expect(config.servers[0]?.url).toBe(
        'https://example.com/mcp?key=file-secret',
      );
      expect(config.servers[0]?.oauth).toMatchObject({
        clientId: 'oauth-client',
        clientSecret: 'file-secret',
        scope: 'mcp.read',
      });
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
    for (const pathValue of ['/health', '/health/', '/health//']) {
      expect(() =>
        parseConfig(
          {
            servers: [{ name: 'x', description: 'one', command: 'node' }],
            transport: { path: pathValue },
          },
          base,
        ),
      ).toThrow(/健康检查保留路径/);
    }

    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node', timeoutMs: 2_147_483_648 }],
        },
        base,
      ),
    ).toThrow(/timeoutMs 必须 <=/);
  });

  it('rejects empty expanded hosts and oversized health-check timers', () => {
    vi.stubEnv('EMPTY_HOST', '   ');
    vi.stubEnv('SPACE_TOKEN', '   ');
    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node' }],
          transport: { host: '${EMPTY_HOST}' },
        },
        base,
      ),
    ).toThrow(/transport\.host 展开后不能为空/);

    expect(() =>
      parseConfig(
        {
          servers: [{ name: 'x', description: 'one', command: 'node' }],
          transport: { authToken: '${SPACE_TOKEN}' },
        },
        base,
      ),
    ).toThrow(/transport\.authToken 展开后不能为空/);

    expect(() =>
      parseConfig(
        {
          servers: [
            {
              name: 'x',
              description: 'one',
              command: 'node',
              healthCheck: { enabled: true, timeoutMs: 2_147_483_648 },
            },
          ],
        },
        base,
      ),
    ).toThrow(/healthCheck\.timeoutMs 必须 <=/);
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
