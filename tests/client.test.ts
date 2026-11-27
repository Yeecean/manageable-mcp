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

describe('CLI endpoint file', () => {
  it('writes and reads atomically without leaving temporary files', () => {
    const endpoint = endpointFixture({ authToken: 'endpoint-token' });
    writeCliEndpoint(endpoint);

    expect(readCliEndpoint()).toMatchObject(endpoint);
    const raw = fs.readFileSync(getDefaultCliEndpointPath(), 'utf8');
    expect(JSON.parse(raw)).toMatchObject(endpoint);
    expect(fs.readdirSync(stateDir)).toEqual(['cli-endpoint.json']);
  });

  it('replaces an existing endpoint file', () => {
    writeCliEndpoint(endpointFixture({ url: 'http://127.0.0.1:4100/mcp' }));
    writeCliEndpoint(endpointFixture({ url: 'http://127.0.0.1:4200/mcp' }));

    expect(readCliEndpoint().url).toBe('http://127.0.0.1:4200/mcp');
    expect(fs.readdirSync(stateDir)).toEqual(['cli-endpoint.json']);
  });

  it('rejects malformed and non-loopback endpoint files', () => {
    fs.writeFileSync(getDefaultCliEndpointPath(), '{');
    expect(() => readCliEndpoint()).toThrow(AppError);

    writeCliEndpoint(endpointFixture({ url: 'http://192.168.1.5:8080/mcp' }));
    expect(() => readCliEndpoint()).toThrow(/non-loopback/);
  });

  it('rejects an endpoint whose daemon pid is not running', () => {
    writeCliEndpoint(endpointFixture({ pid: 2_147_483_647 }));
    expect(() => readCliEndpoint()).toThrow(/stale/);
  });

  it('validates endpoints before writing', () => {
    expect(() => writeCliEndpoint(endpointFixture({ url: '' }))).toThrow(AppError);
    expect(() => writeCliEndpoint(endpointFixture({ pid: 0 }))).toThrow(AppError);
    expect(() => writeCliEndpoint(endpointFixture({ version: '' }))).toThrow(AppError);
  });

  it('only removes an endpoint when pid and url match', () => {
    const endpoint = endpointFixture({ url: 'http://127.0.0.1:5555/mcp' });
    writeCliEndpoint(endpoint);

    expect(removeCliEndpoint({ url: endpoint.url, pid: process.pid + 1 })).toBe(false);
    expect(readCliEndpoint().url).toBe(endpoint.url);
    expect(removeCliEndpoint({ url: 'http://127.0.0.1:6666/mcp', pid: process.pid })).toBe(false);
    expect(readCliEndpoint().url).toBe(endpoint.url);
    expect(removeCliEndpoint({ url: endpoint.url, pid: process.pid })).toBe(true);
    expect(fs.existsSync(getDefaultCliEndpointPath())).toBe(false);
  });

  it('recognizes loopback URLs only', () => {
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

describe('one-shot argument parsing', () => {
  it('parses call with inline JSON parameters', () => {
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

  it('parses call with stdin and file parameters', () => {
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

  it('parses shared flags and describe commands', () => {
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

  it('rejects invalid commands, arity, flags, and JSON', () => {
    const invalid: Array<[string, string[], RegExp]> = [
      ['unknown command', ['nope'], /Unknown client command/],
      ['call without a command', ['call', 'echo'], /Usage:/],
      ['call with too many positionals', ['call', 'echo', 'echo', '{}', 'extra'], /Usage:/],
      ['list-commands with an extra positional', ['list-commands', 'echo', 'extra'], /Usage:/],
      ['describe without commands', ['describe', 'echo'], /Usage:/],
      ['auth with an extra positional', ['auth', 'echo', 'extra'], /Usage:/],
      ['zero timeout', ['list-commands', 'echo', '--timeout', '0'], /--timeout/],
      ['negative timeout', ['list-commands', 'echo', '--timeout', '-1'], /--timeout/],
      ['non-numeric timeout', ['list-commands', 'echo', '--timeout', 'abc'], /--timeout/],
      ['wait on call', ['call', 'echo', 'echo', '--wait'], /--wait is only valid with auth/],
      [
        'params-file on list-commands',
        ['list-commands', 'echo', '--params-file', 'params.json'],
        /--params-file is only valid with call/,
      ],
      [
        'inline and file parameters together',
        ['call', 'echo', 'echo', '{}', '--params-file', 'params.json'],
        /Use either positional parameters or --params-file/,
      ],
      ['invalid JSON', ['call', 'echo', 'echo', '{'], /valid JSON/],
      ['non-object JSON', ['call', 'echo', 'echo', '[]'], /JSON object/],
      ['unknown flag', ['list-commands', 'echo', '--nope'], /Unknown flag/],
      ['missing flag value', ['list-commands', 'echo', '--url'], /requires a value/],
      ['empty token', ['list-commands', 'echo', '--auth-token', ''], /requires a value/],
      ['flag as value', ['list-commands', 'echo', '--url', '--json'], /requires a value/],
      [
        'flag as params-file',
        ['call', 'echo', 'echo', '--params-file', '--json'],
        /requires a value/,
      ],
    ];

    for (const [name, args, message] of invalid) {
      expect(() => parseOneShotCommand(args), name).toThrow(message);
    }
  });
});

describe('one-shot endpoint precedence', () => {
  it('falls back to the endpoint file', () => {
    writeCliEndpoint(endpointFixture({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
    }));

    expect(resolveOneShotEndpoint({})).toMatchObject({
      url: 'http://127.0.0.1:4100/mcp',
      authToken: 'file-token',
      source: 'CLI endpoint file',
    });
  });

  it('prefers environment URL and token over the endpoint file', () => {
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

  it('prefers explicit URL and token over environment and file', () => {
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

  it('does not use the endpoint file token with an explicit URL', () => {
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

  it('reports a friendly error when no daemon endpoint is available', () => {
    expect(() => resolveOneShotEndpoint({})).toThrow(/No manageable-mcp HTTP daemon is available/);
  });
});

describe('URL and error sanitization', () => {
  it('strips userinfo, query, and fragment from endpoints', () => {
    expect(
      sanitizeEndpoint('http://user:pass@127.0.0.1:8080/mcp?token=abc#frag'),
    ).toBe('http://127.0.0.1:8080/mcp');
    expect(sanitizeEndpoint('http://[::1]:9000/mcp?x=1')).toBe('http://[::1]:9000/mcp');
    expect(sanitizeEndpoint('not a URL')).toBe('<invalid URL>');
  });

  it('redacts URL credentials, query values, bearer tokens, and secrets', () => {
    const message = sanitizeErrorMessage(
      'failed http://user:pass@127.0.0.1:8080/mcp?token=abc: ' +
        'Authorization: Bearer abc.def-123 access_token=xyz',
    );

    expect(message).toContain('http://127.0.0.1:8080/mcp');
    expect(message).toContain('Bearer [REDACTED]');
    expect(message).toContain('access_token=[REDACTED]');
    expect(message).not.toContain('@');
    expect(message).not.toContain('user');
    expect(message).not.toContain('test-secret');
    expect(message).not.toContain('token=abc');
    expect(message).not.toContain('abc.def-123');
    expect(message).not.toContain('xyz');
  });

  it('rejects invalid attach URLs before connecting', async () => {
    await expect(
      runStdioAttached({ url: 'not a URL', logger: silentLogger }),
    ).rejects.toThrow(/Invalid --attach URL/);
    await expect(
      runStdioAttached({ url: 'ftp://127.0.0.1/mcp', logger: silentLogger }),
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });
});

describe('authorization URL extraction', () => {
  const base: OneShotToolResult = {
    content: [{ type: 'text', text: 'AUTH_REQUIRED: authorization required' }],
    isError: true,
  };

  it('reads nested and flattened proxy error details', () => {
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

  it('falls back to the text marker', () => {
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

  it('returns undefined for ordinary errors', () => {
    expect(extractAuthUrl(base)).toBeUndefined();
  });
});

describe('one-shot round trips', () => {
  const authToken = 'client-roundtrip-token';
  const echoConfig: ServerConfig = {
    name: 'echo',
    description: 'Echo fixture',
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

  it('lists commands through a live daemon using the endpoint file token', async () => {
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

  it('describes commands through a live daemon', async () => {
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

  it('invokes a tool with inline parameters', async () => {
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

  it('invokes a tool with parameters from a file', async () => {
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

  it('returns exit code 1 and prints the error for a failed tool call', async () => {
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

  it('reports an already-authenticated server', async () => {
    useDaemonEndpoint();
    const io = collector();

    const code = await runOneShotCommand(
      parseOneShotCommand(['auth', 'echo']),
      io.write,
      io.writeError,
    );

    expect(code).toBe(0);
    expect(io.output.join('\n')).toContain("Server 'echo' is authenticated.");
  });

  it('reports an authorization URL and waits for it to clear', async () => {
    const authUrl = 'https://auth.example.test/authorize?state=abc';
    let failures = 1;
    const fakeManager = {
      listServers: () => [
        {
          name: 'remote',
          description: 'Remote fixture',
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
            "Server 'remote' requires OAuth authorization.",
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
