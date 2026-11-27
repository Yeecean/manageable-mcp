import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpTransportConfig, ServerConfig } from '../src/config/types.js';
import { AppError, errorMessage } from '../src/core/errors.js';
import { createLogger, silentLogger } from '../src/core/logger.js';
import { connectDownstream } from '../src/mcp/downstream.js';
import { ServerManager } from '../src/mcp/manager.js';
import { sanitizeErrorMessage } from '../src/oauth/sanitize.js';
import { startHttpServer, type RunningHttpServer } from '../src/transports/http.js';

const root = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

type FakeMode = 'http-error' | 'tool-error' | 'pagination';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(payload.byteLength),
  });
  response.end(payload);
}

class FakeMcpHttpServer {
  private readonly server: http.Server;
  private readonly mode: FakeMode;
  private page = 0;
  private baseUrl = '';

  constructor(mode: FakeMode) {
    this.mode = mode;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'test server error' });
        else response.destroy();
      });
    });
  }

  get url(): string {
    return `${this.baseUrl}/mcp`;
  }

  get pageCount(): number {
    return this.page;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('fake server has no port');
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, { error: 'invalid json' });
      return;
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    const replies: unknown[] = [];
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const result = this.handleMessage(message);
      if (result === undefined) continue;
      if (result.rawError !== undefined) {
        const body = Buffer.from(result.rawError, 'utf8');
        response.writeHead(result.status, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(body.byteLength),
        });
        response.end(body);
        return;
      }
      if (result.body !== undefined) replies.push(result.body);
    }

    if (replies.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    sendJson(response, 200, Array.isArray(payload) ? replies : replies[0]);
  }

  private handleMessage(
    message: Record<string, unknown>,
  ): { status: number; body?: unknown; rawError?: string } | undefined {
    const method = message.method;
    const id = message.id;
    if (typeof method !== 'string' || id === undefined) return undefined;

    if (method === 'initialize') {
      const params = isRecord(message.params) ? message.params : {};
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === 'string'
                ? params.protocolVersion
                : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-downstream', version: '1.0.0' },
          },
        },
      };
    }

    if (method === 'tools/list') {
      if (this.mode === 'http-error') {
        return {
          status: 500,
          rawError:
            'downstream failure access_token=leaked-token client_secret=leaked-secret ' +
            'Authorization: Bearer leaked-header',
        };
      }
      if (this.mode === 'pagination') {
        this.page += 1;
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id,
            result: { tools: [], nextCursor: `cursor-${this.page}` },
          },
        };
      }
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'leaky',
                description: 'Leaky tool',
                inputSchema: { type: 'object' },
              },
            ],
          },
        },
      };
    }

    if (method === 'tools/call') {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  '调用失败 access_token=leaked-token client_secret=leaked-secret ' +
                  'Authorization: Bearer leaked-header',
              },
            ],
            structuredContent: {
              detail: 'password=leaked-password',
              nested: { api_key: 'leaked-api-key' },
            },
            _meta: { token: 'leaked-meta-token' },
          },
        },
      };
    }

    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      },
    };
  }
}

function downstreamConfig(url: string): ServerConfig {
  return {
    name: 'fake-downstream',
    description: 'Fake downstream',
    enabled: true,
    args: [],
    env: {},
    headers: { Authorization: 'Bearer leaked-header' },
    url,
    timeoutMs: 10_000,
    forwardPrompts: false,
    tags: [],
  };
}

function transportOptions(overrides: Partial<HttpTransportConfig> = {}): HttpTransportConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    authToken: 'lowercase-token',
    allowedOrigins: [],
    allowedHosts: [],
    maxBodyBytes: 64 * 1024,
    admin: false,
    cli: false,
    ...overrides,
  };
}

const servers: RunningHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe('下游错误边界', () => {
  it('从 HTTP 状态错误中移除响应正文和认证秘密', async () => {
    const fake = new FakeMcpHttpServer('http-error');
    await fake.start();
    const manager = new ServerManager([downstreamConfig(fake.url)], { logger: silentLogger });
    try {
      let caught: unknown;
      try {
        await manager.listTools('fake-downstream');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppError);
      const message = errorMessage(caught);
      expect(message).toContain('HTTP 500');
      for (const secret of ['leaked-token', 'leaked-secret', 'leaked-header']) {
        expect(message).not.toContain(secret);
      }
    } finally {
      await manager.closeAll();
      await fake.close();
    }
  });

  it('脱敏工具错误结果中的正文、结构和元数据', async () => {
    const fake = new FakeMcpHttpServer('tool-error');
    await fake.start();
    const manager = new ServerManager([downstreamConfig(fake.url)], { logger: silentLogger });
    try {
      const result = await manager.callTool('fake-downstream', 'leaky', {});
      expect(result.isError).toBe(true);
      const serialized = JSON.stringify(result);
      for (const secret of [
        'leaked-token',
        'leaked-secret',
        'leaked-header',
        'leaked-password',
        'leaked-api-key',
        'leaked-meta-token',
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain('[已脱敏]');
    } finally {
      await manager.closeAll();
      await fake.close();
    }
  });

  it('脱敏 stdio 连接失败中的命令秘密', async () => {
    const config: ServerConfig = {
      name: 'missing-stdio',
      description: 'Missing stdio server',
      enabled: true,
      command: 'C:\\missing\\access_token=leaked-token-client_secret=leaked-secret.exe',
      args: [],
      env: {},
      headers: {},
      timeoutMs: 3_000,
      forwardPrompts: false,
      tags: [],
    };

    let caught: unknown;
    try {
      await connectDownstream(config, silentLogger);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const message = errorMessage(caught);
    expect(message).not.toContain('leaked-token');
    expect(message).not.toContain('leaked-secret');
    expect(sanitizeErrorMessage(JSON.stringify({
      access_token: 'leaked-token',
      client_secret: 'leaked-secret',
    }))).not.toMatch(/leaked-token|leaked-secret/);
    const sanitizedUrl = sanitizeErrorMessage(
      '失败 https://alice:userinfo-secret@example.test/mcp?access_token=query-token',
    );
    expect(sanitizedUrl).not.toMatch(/alice|userinfo-secret|query-token/);
    expect(sanitizedUrl).toContain('https://example.test/mcp');
  });

  it('分页超过上限时抛出 PAGINATION_LIMIT 而不是返回部分列表', async () => {
    const fake = new FakeMcpHttpServer('pagination');
    await fake.start();
    const manager = new ServerManager([downstreamConfig(fake.url)], { logger: silentLogger });
    try {
      let caught: unknown;
      try {
        await manager.listTools('fake-downstream');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe('PAGINATION_LIMIT');
      expect(errorMessage(caught)).toMatch(/PAGINATION_LIMIT|分页/);
      expect(fake.pageCount).toBe(100);
    } finally {
      await manager.closeAll();
      await fake.close();
    }
  });
});

describe('HTTP 启动防线', () => {
  it('拒绝空主机、非回环无令牌和保留路径', async () => {
    const manager = new ServerManager([], { logger: silentLogger });
    try {
      await expect(
        startHttpServer(manager, transportOptions({ host: '   ' }), silentLogger),
      ).rejects.toThrow(/不能为空/);
      await expect(
        startHttpServer(
          manager,
          transportOptions({ host: '0.0.0.0', authToken: undefined }),
          silentLogger,
        ),
      ).rejects.toThrow(/非回环主机.*认证令牌/);
      await expect(
        startHttpServer(manager, transportOptions({ path: '/health/' }), silentLogger),
      ).rejects.toThrow(/保留路径/);
      await expect(
        startHttpServer(manager, transportOptions({ path: '/api/admin/' }), silentLogger),
      ).rejects.toThrow(/保留路径/);
    } finally {
      await manager.closeAll();
    }
  });

  it('接受大小写不敏感的 bearer scheme', async () => {
    const manager = new ServerManager([], { logger: silentLogger });
    const server = await startHttpServer(
      manager,
      transportOptions({ authToken: 'lowercase-token' }),
      createLogger('error'),
    );
    servers.push(server);

    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        Authorization: 'bearer lowercase-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { tools: expect.any(Array) },
    });
  });
});

describe('Windows 进程树清理', () => {
  it.runIf(process.platform === 'win32')(
    '关闭 .cmd 包装器后孙进程不再运行',
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-taskkill-'));
      const pidFile = path.join(directory, 'grandchild.pid');
      const sentinel = path.join(directory, 'sentinel.mjs');
      const wrapper = path.join(directory, 'server.cmd');
      fs.writeFileSync(
        sentinel,
        [
          "import * as fs from 'node:fs';",
          'fs.writeFileSync(process.argv[2], String(process.pid));',
          'setInterval(() => undefined, 1_000);',
          '',
        ].join('\n'),
      );
      const echoServer = path.join(root, 'examples', 'echo-server.mjs');
      fs.writeFileSync(
        wrapper,
        [
          '@echo off',
          `start "" /B "${process.execPath}" "${sentinel}" "${pidFile}"`,
          `"${process.execPath}" "${echoServer}"`,
          '',
        ].join('\r\n'),
      );

      let grandchildPid: number | undefined;
      const config: ServerConfig = {
        name: 'windows-wrapper',
        description: 'Windows cmd wrapper',
        enabled: true,
        command: wrapper,
        args: [],
        cwd: directory,
        env: {},
        headers: {},
        timeoutMs: 10_000,
        forwardPrompts: false,
        tags: [],
      };

      try {
        const connection = await connectDownstream(config, silentLogger);
        try {
          await connection.listTools();
          for (let attempts = 0; attempts < 100; attempts += 1) {
            if (fs.existsSync(pidFile)) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(fs.existsSync(pidFile)).toBe(true);
          grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
          expect(Number.isInteger(grandchildPid)).toBe(true);
        } finally {
          await connection.close();
        }

        let alive = true;
        for (let attempts = 0; attempts < 100; attempts += 1) {
          try {
            process.kill(grandchildPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch {
            alive = false;
            break;
          }
        }
        expect(alive).toBe(false);
      } finally {
        if (grandchildPid !== undefined) {
          await execFileAsync(
            'taskkill',
            ['/PID', String(grandchildPid), '/T', '/F'],
            { timeout: 5_000, windowsHide: true },
          ).catch(() => undefined);
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
