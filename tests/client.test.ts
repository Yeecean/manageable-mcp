import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config/types.js';
import { getDefaultCliEndpointPath } from '../src/config/paths.js';
import { AppError } from '../src/core/errors.js';
import { createLogger, silentLogger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import { startHttpServer, type RunningHttpServer } from '../src/transports/http.js';
import {
  isLoopbackUrl,
  readCliEndpoint,
  removeCliEndpoint,
  writeCliEndpoint,
  type CliEndpoint,
} from '../src/client/endpoint.js';
import {
  ONE_SHOT_COMMANDS,
  extractAuthUrl,
  parseOneShotCommand,
  resolveOneShotEndpoint,
  runOneShotCommand,
  type OneShotToolResult,
} from '../src/client/one-shot.js';
import {
  runStdioAttached,
  sanitizeEndpoint,
  sanitizeErrorMessage,
} from '../src/client/attach.js';

const root = path.resolve(__dirname, '..');
const MANAGED_ENV = [
  'MANAGEABLE_MCP_STATE_DIR',
  'MANAGEABLE_MCP_URL',
  'MANAGEABLE_MCP_AUTH_TOKEN',
];

let stateDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const name of MANAGED_ENV) savedEnv[name] = process.env[name];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-client-'));
  process.env.MANAGEABLE_MCP_STATE_DIR = stateDir;
  delete process.env.MANAGEABLE_MCP_URL;
  delete process.env.MANAGEABLE_MCP_AUTH_TOKEN;
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function endpointFixture(overrides: Partial<CliEndpoint> = {}): CliEndpoint {
  return {
    url: 'http://127.0.0.1:4321/mcp',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: '0.1.0',
    ...overrides,
  };
}

function collector(): {
  output: string[];
  errors: string[];
  write: (line: string) => void;
  writeError: (line: string) => void;
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  };
}

describe('CLI 端点文件', () => {
  it('原子写入和读取且不留下临时文件', () => {
    const endpoint = endpointFixture({ authToken: 'endpoint-token' });
    writeCliEndpoint(endpoint);

    expect(readCliEndpoint()).toMatchObject(endpoint);
    const raw = fs.readFileSync(getDefaultCliEndpointPath(), 'utf8');
    expect(JSON.parse(raw)).toMatchObject(endpoint);
    expect(fs.readdirSync(stateDir)).toEqual(['cli-endpoint.json']);
  });

  it('替换现有端点文件', () => {
    writeCliEndpoint(endpointFixture({ url: 'http://127.0.0.1:4100/mcp' }));
    writeCliEndpoint(endpointFixture({ url: 'http://127.0.0.1:4200/mcp' }));

    expect(readCliEndpoint().url).toBe('http://127.0.0.1:4200/mcp');
    expect(fs.readdirSync(stateDir)).toEqual(['cli-endpoint.json']);
  });

  it('拒绝格式错误和非回环端点文件', () => {
    fs.writeFileSync(getDefaultCliEndpointPath(), '{');
    expect(() => readCliEndpoint()).toThrow(AppError);

    writeCliEndpoint(endpointFixture({ url: 'http://192.168.1.5:8080/mcp' }));
    expect(() => readCliEndpoint()).toThrow(/非回环/);
  });

  it('拒绝守护进程 PID 未运行的端点', () => {
    writeCliEndpoint(endpointFixture({ pid: 2_147_483_647 }));
    expect(() => readCliEndpoint()).toThrow(/已失效/);
  });

  it('写入前校验端点', () => {
    expect(() => writeCliEndpoint(endpointFixture({ url: '' }))).toThrow(AppError);
    expect(() => writeCliEndpoint(endpointFixture({ pid: 0 }))).toThrow(AppError);
    expect(() => writeCliEndpoint(endpointFixture({ version: '' }))).toThrow(AppError);
  });

  it('仅在 PID 和 URL 匹配时删除端点', () => {
    const endpoint = endpointFixture({ url: 'http://127.0.0.1:5555/mcp' });
    writeCliEndpoint(endpoint);

    expect(removeCliEndpoint({ url: endpoint.url, pid: process.pid + 1 })).toBe(false);
    expect(readCliEndpoint().url).toBe(endpoint.url);
    expect(removeCliEndpoint({ url: 'http://127.0.0.1:6666/mcp', pid: process.pid })).toBe(false);
    expect(readCliEndpoint().url).toBe(endpoint.url);
    expect(removeCliEndpoint({ url: endpoint.url, pid: process.pid })).toBe(true);
    expect(fs.existsSync(getDefaultCliEndpointPath())).toBe(false);
  });

  it('仅识别回环 URL', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8080/mcp')).toBe(true);
    expect(isLoopbackUrl('http://127.9.8.7:8080/mcp')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8080/mcp')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080/mcp')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.5:8080/mcp')).toBe(false);
    expect(isLoopbackUrl('http://example.com/mcp')).toBe(false);
    expect(isLoopbackUrl('http://localhost.evil.example/mcp')).toBe(false);
    expect(isLoopbackUrl('not a URL')).toBe(false);
  });
});

describe('一次性命令参数解析', () => {
  it('解析带内联 JSON 参数的 call', () => {
    const command = parseOneShotCommand(['call', 'echo', 'echo', '{"text":"hi"}']);
    expect(command).toMatchObject({
      kind: 'call',
      server: 'echo',
      command: 'echo',
      parameters: { text: 'hi' },
      json: false,
      wait: false,
      timeoutMs: 60_000,
    });
  });

  it('解析带 stdin 和文件参数的 call', () => {
    expect(parseOneShotCommand(['call', 'echo', 'echo', '-'])).toMatchObject({
      kind: 'call',
      paramsFile: '-',
    });
    expect(
      parseOneShotCommand(['call', 'echo', 'echo', '--params-file', 'params.json']),
    ).toMatchObject({
      kind: 'call',
      paramsFile: 'params.json',
    });
  });

  it('解析通用选项和 describe 命令', () => {
    const command = parseOneShotCommand([
      'list-commands',
      'echo',
      '--url',
      'http://127.0.0.1:9999/mcp',
      '--auth-token',
      'token-value',
      '--timeout',
      '2.5',
      '--json',
    ]);
    expect(command).toMatchObject({
      kind: 'list-commands',
      server: 'echo',
      url: 'http://127.0.0.1:9999/mcp',
      authToken: 'token-value',
      timeoutMs: 2_500,
      json: true,
    });

    expect(parseOneShotCommand(['describe', 'echo', 'echo', 'add'])).toMatchObject({
      kind: 'describe',
      server: 'echo',
      commands: ['echo', 'add'],
    });
    expect(parseOneShotCommand(['auth', 'echo', '--wait'])).toMatchObject({
      kind: 'auth',
      server: 'echo',
      wait: true,
    });
    expect(ONE_SHOT_COMMANDS.has('call')).toBe(true);
  });

  it('拒绝无效命令、参数数量、选项和 JSON', () => {
    const invalid: Array<[string, string[], RegExp]> = [
      ['未知命令', ['nope'], /未知客户端命令/],
      ['call 缺少命令', ['call', 'echo'], /用法：/],
      ['call 位置参数过多', ['call', 'echo', 'echo', '{}', 'extra'], /用法：/],
      ['list-commands 多出位置参数', ['list-commands', 'echo', 'extra'], /用法：/],
      ['describe 缺少命令', ['describe', 'echo'], /用法：/],
      ['auth 多出位置参数', ['auth', 'echo', 'extra'], /用法：/],
      ['超时为 0', ['list-commands', 'echo', '--timeout', '0'], /--timeout/],
      ['超时为负数', ['list-commands', 'echo', '--timeout', '-1'], /--timeout/],
      ['超时不是数字', ['list-commands', 'echo', '--timeout', 'abc'], /--timeout/],
      ['call 使用 --wait', ['call', 'echo', 'echo', '--wait'], /--wait 仅适用于 auth/],
      [
        'list-commands 使用 --params-file',
        ['list-commands', 'echo', '--params-file', 'params.json'],
        /--params-file 仅适用于 call/,
      ],
      [
        '同时使用内联参数和文件参数',
        ['call', 'echo', 'echo', '{}', '--params-file', 'params.json'],
        /位置参数与 --params-file 只能二选一/,
      ],
      ['无效 JSON', ['call', 'echo', 'echo', '{'], /有效的 JSON/],
      ['非对象 JSON', ['call', 'echo', 'echo', '[]'], /JSON 对象/],
      ['未知选项', ['list-commands', 'echo', '--nope'], /不支持选项/],
      ['选项缺少值', ['list-commands', 'echo', '--url'], /需要提供值/],
      ['空 token', ['list-commands', 'echo', '--auth-token', ''], /需要提供值/],
      ['把选项当作值', ['list-commands', 'echo', '--url', '--json'], /需要提供值/],
      [
        '把选项当作参数文件',
        ['call', 'echo', 'echo', '--params-file', '--json'],
        /需要提供值/,
      ],
    ];

    for (const [name, args, message] of invalid) {
      expect(() => parseOneShotCommand(args), name).toThrow(message);
    }
  });
});

describe('一次性命令端点优先级', () => {
  it('回退到端点文件', () => {
    writeCliEndpoint(endpointFixture({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
    }));

    expect(resolveOneShotEndpoint({})).toMatchObject({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
      source: 'CLI 端点文件',
    });
  });

  it('环境变量 URL 和 token 优先于端点文件', () => {
    writeCliEndpoint(endpointFixture({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
    }));
    process.env.MANAGEABLE_MCP_URL = 'http://127.0.0.1:4200/mcp';
    process.env.MANAGEABLE_MCP_AUTH_TOKEN = 'env-token';

    expect(resolveOneShotEndpoint({})).toMatchObject({
      url: 'http://127.0.0.1:4200/mcp',
      authToken: 'env-token',
      source: 'MANAGEABLE_MCP_URL',
    });
  });

  it('显式 URL 和 token 优先于环境变量和端点文件', () => {
    writeCliEndpoint(endpointFixture({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
    }));
    process.env.MANAGEABLE_MCP_URL = 'http://127.0.0.1:4200/mcp';
    process.env.MANAGEABLE_MCP_AUTH_TOKEN = 'env-token';

    expect(
      resolveOneShotEndpoint({
        url: 'http://127.0.0.1:4300/mcp',
        authToken: 'flag-token',
      }),
    ).toMatchObject({
      url: 'http://127.0.0.1:4300/mcp',
      authToken: 'flag-token',
      source: '--url',
    });
  });

  it('显式 URL 不使用端点文件中的 token', () => {
    writeCliEndpoint(endpointFixture({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
    }));

    expect(resolveOneShotEndpoint({ url: 'http://127.0.0.1:4300/mcp' })).toMatchObject({
      url: 'http://127.0.0.1:4300/mcp',
      source: '--url',
    });
    expect(resolveOneShotEndpoint({ url: 'http://127.0.0.1:4300/mcp' }).authToken).toBeUndefined();
  });

  it('无可用守护进程端点时给出友好错误', () => {
    expect(() => resolveOneShotEndpoint({})).toThrow(/没有可用的 manageable-mcp HTTP 守护进程/);
  });
});

describe('URL 与错误信息脱敏', () => {
  it('移除端点中的用户信息、查询字符串和片段', () => {
    expect(
      sanitizeEndpoint('http://user:pass@127.0.0.1:8080/mcp?token=abc#frag'),
    ).toBe('http://127.0.0.1:8080/mcp');
    expect(sanitizeEndpoint('http://[::1]:9000/mcp?x=1')).toBe('http://[::1]:9000/mcp');
    expect(sanitizeEndpoint('not a URL')).toBe('<无效 URL>');
  });

  it('脱敏 URL 凭据、查询值、bearer token 和秘密', () => {
    const message = sanitizeErrorMessage(
      '失败 http://user:pass@127.0.0.1:8080/mcp?token=abc: ' +
        'Authorization: Bearer abc.def-123 access_token=xyz',
    );

    expect(message).toContain('http://127.0.0.1:8080/mcp');
    expect(message).toContain('Bearer [已脱敏]');
    expect(message).toContain('access_token=[已脱敏]');
    expect(message).not.toContain('@');
    expect(message).not.toContain('user');
    expect(message).not.toContain('test-secret');
    expect(message).not.toContain('token=abc');
    expect(message).not.toContain('abc.def-123');
    expect(message).not.toContain('xyz');
  });

  it('连接前拒绝无效的 attach URL', async () => {
    await expect(
      runStdioAttached({ url: 'not a URL', logger: silentLogger }),
    ).rejects.toThrow(/无效的 --attach URL/);
    await expect(
      runStdioAttached({ url: 'ftp://127.0.0.1/mcp', logger: silentLogger }),
    ).rejects.toThrow(/http:\/\/ 或 https:\/\//);
  });
});

describe('授权 URL 提取', () => {
  const base: OneShotToolResult = {
    content: [{ type: 'text', text: 'AUTH_REQUIRED：需要授权' }],
    isError: true,
  };

  it('读取嵌套和扁平形式的代理错误详情', () => {
    expect(
      extractAuthUrl({
        ...base,
        _meta: {
          manageableMcpProxyError: {
            details: { authUrl: 'https://auth.example/nested' },
          },
        },
      }),
    ).toBe('https://auth.example/nested');

    expect(
      extractAuthUrl({
        ...base,
        _meta: {
          manageableMcpProxyError: { authUrl: 'https://auth.example/flat' },
        },
      }),
    ).toBe('https://auth.example/flat');
  });

  it('回退到文本标记', () => {
    expect(
      extractAuthUrl({
        content: [
          {
            type: 'text',
            text: 'Open this URL in your browser to authorize: https://auth.example/text',
          },
        ],
        isError: true,
      }),
    ).toBe('https://auth.example/text');
  });

  it('普通错误返回 undefined', () => {
    expect(extractAuthUrl(base)).toBeUndefined();
  });
});

describe('一次性命令往返', () => {
  const authToken = 'client-roundtrip-token';
  const echoConfig: ServerConfig = {
    name: 'echo',
    description: 'Echo 测试服务器',
    enabled: true,
    command: process.execPath,
    args: [path.join(root, 'examples', 'echo-server.mjs')],
    cwd: root,
    env: {},
    headers: {},
    timeoutMs: 10_000,
    forwardPrompts: false,
  };

  let manager: ServerManager;
  let server: RunningHttpServer;

  beforeAll(async () => {
    manager = new ServerManager([echoConfig]);
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
        admin: false,
        cli: true,
      },
      createLogger('error'),
    );
  });

  afterAll(async () => {
    await server.close();
  });

  function useDaemonEndpoint(): void {
    writeCliEndpoint(endpointFixture({ url: server.url, authToken }));
  }

  it('使用端点文件 token 通过实时守护进程列出命令', async () => {
    useDaemonEndpoint();
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['list-commands', 'echo']),
      io.write,
      io.writeError,
    );

    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    const text = io.output.join('\n');
    expect(text).toContain('"server": "echo"');
    expect(text).toContain('"name": "echo"');
    expect(text).toContain('"name": "add"');
  });

  it('通过实时守护进程描述命令', async () => {
    useDaemonEndpoint();
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['describe', 'echo', 'echo', 'add']),
      io.write,
      io.writeError,
    );

    expect(code).toBe(0);
    expect(io.output.join('\n')).toContain('"inputSchema"');
    expect(io.output.join('\n')).toContain('"add"');
  });

  it('使用内联参数调用工具', async () => {
    useDaemonEndpoint();
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['call', 'echo', 'echo', '{"text":"client-roundtrip"}']),
      io.write,
      io.writeError,
    );

    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.output.join('\n')).toBe('client-roundtrip');
  });

  it('使用文件参数调用工具', async () => {
    useDaemonEndpoint();
    const paramsPath = path.join(stateDir, 'params.json');
    fs.writeFileSync(paramsPath, JSON.stringify({ text: 'file-roundtrip' }));
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['call', 'echo', 'echo', '--params-file', paramsPath]),
      io.write,
      io.writeError,
    );

    expect(code).toBe(0);
    expect(io.output.join('\n')).toBe('file-roundtrip');
  });

  it('工具调用失败时返回退出码 1 并输出错误', async () => {
    useDaemonEndpoint();
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['call', 'echo', 'fail']),
      io.write,
      io.writeError,
    );

    expect(code).toBe(1);
    expect(io.output).toEqual([]);
    expect(io.errors.join('\n')).toContain('simulated downstream failure');
  });

  it('报告已完成认证的服务器', async () => {
    useDaemonEndpoint();
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['auth', 'echo']),
      io.write,
      io.writeError,
    );

    expect(code).toBe(0);
    expect(io.output.join('\n')).toContain("服务器 'echo' 已完成认证。");
  });

  it('报告授权 URL 并等待其消失', async () => {
    const authUrl = 'https://auth.example.test/authorize?state=abc';
    let failures = 1;
    const fakeManager = {
      listServers: () => [
        {
          name: 'remote',
          description: 'Remote 测试服务器',
          enabled: true,
          transport: 'http',
          status: failures > 0 ? 'auth' : 'ready',
        },
      ],
      hasPromptForwarding: () => false,
      getServerConfig: () => undefined,
      getGlobalPermissions: () => ({ rules: [] }),
      touchActivity: () => undefined,
      listTools: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new AppError(
            'AUTH_REQUIRED',
            "服务器 'remote' 需要 OAuth 授权。",
            { server: 'remote', authUrl },
          );
        }
        return [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }];
      },
      closeAll: async () => undefined,
    } as unknown as ServerManager;

    const authServer = await startHttpServer(
      fakeManager,
      {
        host: '127.0.0.1',
        port: 0,
        path: '/mcp',
        authToken: 'auth-test-token',
        allowedOrigins: [],
        allowedHosts: [],
        maxBodyBytes: 64 * 1024,
        admin: false,
        cli: true,
      },
      createLogger('error'),
    );

    try {
      const io = collector();
      const startedAt = Date.now();
      const code = await runOneShotCommand(
        parseOneShotCommand([
          'auth',
          'remote',
          '--url',
          authServer.url,
          '--auth-token',
          'auth-test-token',
          '--wait',
          '--json',
        ]),
        io.write,
        io.writeError,
      );

      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
      expect(io.errors).toEqual([]);
      const states = io.output.map(
        (line) => JSON.parse(line) as { server: string; authenticated: boolean; authUrl?: string },
      );
      expect(states[0]).toEqual({ server: 'remote', authenticated: false, authUrl });
      expect(states[states.length - 1]).toEqual({ server: 'remote', authenticated: true });
    } finally {
      await authServer.close();
    }
  });
});
