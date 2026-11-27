import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOAuthStorePath } from '../src/config/paths.js';
import type { ServerConfig } from '../src/config/types.js';
import { AppError, OAuthAuthorizationRequiredError } from '../src/core/errors.js';
import { silentLogger, type Logger } from '../src/core/logger.js';
import { ServerManager } from '../src/mcp/manager.js';
import {
  createOAuthProvider,
  oauthStoreKey,
  readOAuthStoreEntry,
  resetOAuthProvidersForTests,
  sanitizeErrorMessage,
  type ManageableOAuthProvider,
} from '../src/oauth/index.js';

interface TokenRequestRecord {
  authorization: string | undefined;
  body: URLSearchParams;
}

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}

interface FakeOAuthOptions {
  registration?: boolean;
  staticClient?: { clientId: string; clientSecret: string };
  failCodeExchange?: boolean;
}

function jsonResponse(
  response: http.ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', String(body.byteLength));
  for (const [key, headerValue] of Object.entries(extraHeaders)) {
    response.setHeader(key, headerValue);
  }
  response.end(body);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createSpyLogger(): {
  logger: Logger;
  text(): string;
} {
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, ...(fields === undefined ? {} : { fields }) });
  };
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    text: () => JSON.stringify(entries),
  };
}

class FakeOAuthMcpServer {
  readonly registrationRequests: Array<Record<string, unknown>> = [];
  readonly authorizeRequests: URL[] = [];
  readonly tokenRequests: TokenRequestRecord[] = [];
  lastAccessToken?: string;

  private readonly server: http.Server;
  private readonly options: FakeOAuthOptions;
  private readonly clientIds = new Set<string>();
  private readonly accessTokens = new Set<string>();
  private readonly refreshTokens = new Set<string>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private dynamicClientId?: string;
  private tokenCounter = 0;
  private baseUrl = '';
  private mcpUrl = '';

  constructor(options: FakeOAuthOptions = {}) {
    this.options = options;
    if (options.staticClient !== undefined) {
      this.clientIds.add(options.staticClient.clientId);
    }
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          jsonResponse(response, 500, { error: 'server_error' });
        } else {
          response.destroy();
        }
      });
    });
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
    this.mcpUrl = `${this.baseUrl}/mcp`;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  get resourceUrl(): string {
    return this.mcpUrl;
  }

  get authorizationServerUrl(): string {
    return this.baseUrl;
  }

  get registeredClientId(): string | undefined {
    return this.dynamicClientId;
  }

  private metadata(): Record<string, unknown> {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/authorize`,
      token_endpoint: `${this.baseUrl}/token`,
      ...(this.options.registration === false
        ? {}
        : { registration_endpoint: `${this.baseUrl}/register` }),
      scopes_supported: ['mcp.read'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported:
        this.options.staticClient === undefined ? ['none'] : ['client_secret_basic'],
    };
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', this.baseUrl);

    if (
      requestUrl.pathname === '/.well-known/oauth-protected-resource' ||
      requestUrl.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      jsonResponse(response, 200, {
        resource: this.baseUrl,
        authorization_servers: [this.baseUrl],
        scopes_supported: ['mcp.read'],
      });
      return;
    }

    if (
      requestUrl.pathname === '/.well-known/oauth-authorization-server' ||
      requestUrl.pathname === '/.well-known/oauth-authorization-server/mcp'
    ) {
      jsonResponse(response, 200, this.metadata());
      return;
    }

    if (requestUrl.pathname === '/register') {
      await this.handleRegister(request, response);
      return;
    }

    if (requestUrl.pathname === '/authorize') {
      this.handleAuthorize(request, response, requestUrl);
      return;
    }

    if (requestUrl.pathname === '/token') {
      await this.handleToken(request, response);
      return;
    }

    if (requestUrl.pathname === '/mcp') {
      await this.handleMcp(request, response);
      return;
    }

    jsonResponse(response, 404, { error: 'not_found' });
  }

  private async handleRegister(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST' || this.options.registration === false) {
      jsonResponse(response, 404, { error: 'not_found' });
      return;
    }

    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    this.registrationRequests.push(body);
    this.dynamicClientId = `dynamic-client-${randomUUID()}`;
    this.clientIds.add(this.dynamicClientId);

    jsonResponse(response, 201, {
      client_id: this.dynamicClientId,
      client_id_issued_at: Math.floor(Date.now() / 1_000),
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
      grant_types: body.grant_types,
      response_types: body.response_types,
      client_name: body.client_name,
      scope: body.scope,
    });
  }

  private handleAuthorize(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    requestUrl: URL,
  ): void {
    if (request.method !== 'GET') {
      jsonResponse(response, 405, { error: 'method_not_allowed' });
      return;
    }

    this.authorizeRequests.push(requestUrl);
    const clientId = requestUrl.searchParams.get('client_id') ?? '';
    const redirectUri = requestUrl.searchParams.get('redirect_uri') ?? '';
    const responseType = requestUrl.searchParams.get('response_type');
    const codeChallenge = requestUrl.searchParams.get('code_challenge') ?? '';
    const codeChallengeMethod = requestUrl.searchParams.get('code_challenge_method');
    const state = requestUrl.searchParams.get('state') ?? '';
    const scope = requestUrl.searchParams.get('scope') ?? 'mcp.read';

    let parsedRedirect: URL;
    try {
      parsedRedirect = new URL(redirectUri);
    } catch {
      jsonResponse(response, 400, { error: 'invalid_redirect_uri' });
      return;
    }

    if (
      !this.clientIds.has(clientId) ||
      responseType !== 'code' ||
      codeChallenge.length === 0 ||
      codeChallengeMethod !== 'S256' ||
      state.length === 0 ||
      parsedRedirect.hostname !== '127.0.0.1' ||
      parsedRedirect.pathname !== '/callback'
    ) {
      jsonResponse(response, 400, { error: 'invalid_request' });
      return;
    }

    const code = `code-${++this.tokenCounter}-${randomUUID()}`;
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      scope,
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    response.statusCode = 302;
    response.setHeader('Location', target.toString());
    response.end();
  }

  private async handleToken(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: 'method_not_allowed' });
      return;
    }

    const body = new URLSearchParams(await readBody(request));
    const authorization = request.headers.authorization;
    this.tokenRequests.push({ authorization, body });

    if (!this.authenticateClient(authorization, body)) {
      jsonResponse(response, 401, { error: 'invalid_client' });
      return;
    }

    const grantType = body.get('grant_type');
    if (grantType === 'authorization_code') {
      if (this.options.failCodeExchange === true) {
        jsonResponse(response, 400, {
          error: 'invalid_request',
          error_description: 'token rejected access_token=leaked-token client_secret=leaked-secret',
        });
        return;
      }

      const code = body.get('code') ?? '';
      const record = this.codes.get(code);
      if (record === undefined) {
        jsonResponse(response, 400, { error: 'invalid_grant', error_description: 'unknown code' });
        return;
      }
      this.codes.delete(code);

      const verifier = body.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        record.codeChallenge !== challenge ||
        record.redirectUri !== (body.get('redirect_uri') ?? '') ||
        record.clientId !== (body.get('client_id') ?? record.clientId)
      ) {
        jsonResponse(response, 400, { error: 'invalid_grant', error_description: 'PKCE check failed' });
        return;
      }

      this.issueTokens(response, record.scope);
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = body.get('refresh_token') ?? '';
      if (!this.refreshTokens.has(refreshToken)) {
        jsonResponse(response, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
        return;
      }
      this.refreshTokens.delete(refreshToken);
      this.issueTokens(response, body.get('scope') ?? 'mcp.read');
      return;
    }

    jsonResponse(response, 400, { error: 'unsupported_grant_type' });
  }

  private authenticateClient(
    authorization: string | undefined,
    body: URLSearchParams,
  ): boolean {
    const staticClient = this.options.staticClient;
    if (staticClient !== undefined) {
      if (authorization !== undefined && authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
        return decoded === `${staticClient.clientId}:${staticClient.clientSecret}`;
      }
      return (
        body.get('client_id') === staticClient.clientId &&
        body.get('client_secret') === staticClient.clientSecret
      );
    }

    const clientId = body.get('client_id') ?? '';
    return clientId.length > 0 && this.clientIds.has(clientId);
  }

  private issueTokens(response: http.ServerResponse, scope: string): void {
    const accessToken = `access-${++this.tokenCounter}-${randomUUID()}`;
    const refreshToken = `refresh-${++this.tokenCounter}-${randomUUID()}`;
    this.accessTokens.add(accessToken);
    this.refreshTokens.add(refreshToken);
    this.lastAccessToken = accessToken;
    jsonResponse(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3_600,
      refresh_token: refreshToken,
      scope,
    });
  }

  private async handleMcp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: 'method_not_allowed' });
      return;
    }

    const authorization = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const token = match?.[1];
    if (token === undefined || !this.accessTokens.has(token)) {
      response.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource", scope="mcp.read"`,
      );
      jsonResponse(response, 401, { error: 'unauthorized' });
      return;
    }

    const payload = JSON.parse(await readBody(request)) as unknown;
    const messages = Array.isArray(payload) ? payload : [payload];
    const responses: unknown[] = [];

    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue;
      const record = message as Record<string, unknown>;
      const id = record.id;
      const method = record.method;
      if (typeof method !== 'string') continue;
      if (id === undefined) continue;

      const params = (record.params ?? {}) as Record<string, unknown>;
      if (method === 'initialize') {
        responses.push({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === 'string'
              ? params.protocolVersion
              : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-oauth-mcp', version: '1.0.0' },
          },
        });
        continue;
      }
      if (method === 'tools/list') {
        responses.push({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo text',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          },
        });
        continue;
      }
      if (method === 'tools/call') {
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        responses.push({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(args.text ?? '') }],
          },
        });
        continue;
      }
      if (method === 'ping') {
        responses.push({ jsonrpc: '2.0', id, result: {} });
        continue;
      }
      responses.push({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
    }

    if (responses.length === 0) {
      response.statusCode = 202;
      response.end();
      return;
    }

    jsonResponse(response, 200, Array.isArray(payload) ? responses : responses[0]);
  }
}

async function startProvider(
  name: string,
  serverUrl: string,
  config: { callbackPort?: number; scope?: string; clientId?: string; clientSecret?: string } = {},
  logger?: Logger,
): Promise<ManageableOAuthProvider> {
  const provider = createOAuthProvider(name, serverUrl, config, logger);
  await provider.ready;
  return provider;
}

async function captureAuthorizationError(
  provider: ManageableOAuthProvider,
  serverUrl: string,
): Promise<OAuthAuthorizationRequiredError> {
  try {
    await auth(provider, { serverUrl });
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthAuthorizationRequiredError);
    return error as OAuthAuthorizationRequiredError;
  }
  throw new Error('expected an OAuth authorization redirect');
}

const originalStateDir = process.env.MANAGEABLE_MCP_STATE_DIR;
let stateDir: string;
let fakeServer: FakeOAuthMcpServer | undefined;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manageable-mcp-v2-oauth-'));
  process.env.MANAGEABLE_MCP_STATE_DIR = stateDir;
});

beforeEach(async () => {
  await resetOAuthProvidersForTests();
  fs.rmSync(getOAuthStorePath(), { force: true });
  fakeServer = undefined;
});

afterEach(async () => {
  if (fakeServer !== undefined) {
    await fakeServer.close();
    fakeServer = undefined;
  }
});

afterAll(async () => {
  await resetOAuthProvidersForTests();
  if (originalStateDir === undefined) delete process.env.MANAGEABLE_MCP_STATE_DIR;
  else process.env.MANAGEABLE_MCP_STATE_DIR = originalStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('OAuth provider', () => {
  it('completes discovery, DCR, PKCE, callback exchange, persistence, and reconnection', async () => {
    fakeServer = new FakeOAuthMcpServer({ registration: true });
    await fakeServer.start();
    const spy = createSpyLogger();
    const provider = await startProvider(
      'dynamic',
      fakeServer.resourceUrl,
      { callbackPort: 0, scope: 'mcp.read' },
      spy.logger,
    );

    expect(createOAuthProvider('dynamic', fakeServer.resourceUrl, { callbackPort: 0 }, spy.logger)).toBe(provider);
    expect(provider.callbackPort).toBeGreaterThan(0);

    const client = new Client(
      { name: 'oauth-e2e', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(fakeServer.resourceUrl), {
      authProvider: provider,
    });

    let authorizationError: unknown;
    try {
      await client.connect(transport);
    } catch (error) {
      authorizationError = error;
    }
    expect(authorizationError).toBeInstanceOf(OAuthAuthorizationRequiredError);
    const authUrl = (authorizationError as OAuthAuthorizationRequiredError).authUrl;
    expect(authUrl).toContain('/authorize?');
    expect(authUrl).toContain('code_challenge_method=S256');
    expect(authUrl).toContain('state=');
    expect(fakeServer.registrationRequests).toHaveLength(1);
    expect(fakeServer.authorizeRequests).toHaveLength(0);

    const authorizationResponse = await fetch(authUrl, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const callbackLocation = authorizationResponse.headers.get('location');
    expect(callbackLocation).toBeTruthy();
    const callbackResponse = await fetch(callbackLocation as string);
    const callbackHtml = await callbackResponse.text();
    expect(callbackResponse.status, callbackHtml).toBe(200);
    expect(callbackHtml).toContain('Authorization complete');

    expect(fakeServer.tokenRequests).toHaveLength(1);
    expect(fakeServer.tokenRequests[0]?.body.get('code_verifier')).toBeTruthy();
    expect(fakeServer.tokenRequests[0]?.body.get('resource')).toBe(fakeServer.authorizationServerUrl);

    const stored = await readOAuthStoreEntry('dynamic', fakeServer.resourceUrl);
    expect(stored?.clientInformation?.client_id).toBe(fakeServer.registeredClientId);
    expect(stored?.tokens?.access_token).toBe(fakeServer.lastAccessToken);
    expect(stored?.tokens?.refresh_token).toBeTruthy();
    expect(stored?.tokens?.issuer).toBe(fakeServer.authorizationServerUrl);
    expect(stored?.codeVerifier).toBeTruthy();
    expect(provider.lastAuthorizationUrl).toBe(authUrl);

    expect(spy.text()).not.toContain(stored?.tokens?.access_token);
    expect(spy.text()).not.toContain(stored?.tokens?.refresh_token);
    expect(spy.text()).not.toContain(stored?.codeVerifier);

    const reconnectClient = new Client(
      { name: 'oauth-e2e-reconnect', version: '1.0.0' },
      { capabilities: {} },
    );
    const reconnectTransport = new StreamableHTTPClientTransport(
      new URL(fakeServer.resourceUrl),
      { authProvider: provider },
    );
    await reconnectClient.connect(reconnectTransport);
    const tools = await reconnectClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('echo');
    await reconnectClient.close();

    expect(await auth(provider, { serverUrl: fakeServer.resourceUrl })).toBe('AUTHORIZED');
    expect(fakeServer.tokenRequests.some((request) => request.body.get('grant_type') === 'refresh_token')).toBe(true);
    expect(fakeServer.lastAccessToken).toBeDefined();

    const pathToStore = getOAuthStorePath();
    expect(fs.existsSync(pathToStore)).toBe(true);
    expect(fs.readdirSync(stateDir)).toEqual(['oauth.json']);

    await resetOAuthProvidersForTests();
    const restored = await startProvider('dynamic', fakeServer.resourceUrl, { callbackPort: 0 }, spy.logger);
    const restoredTokens = await restored.tokens();
    expect(restoredTokens?.access_token).toBe(fakeServer.lastAccessToken);
    expect(restoredTokens?.issuer).toBe(fakeServer.authorizationServerUrl);
  });

  it('uses static client credentials without dynamic registration and refreshes saved tokens', async () => {
    fakeServer = new FakeOAuthMcpServer({
      registration: false,
      staticClient: { clientId: 'static-client', clientSecret: 'static-secret' },
    });
    await fakeServer.start();
    const provider = await startProvider('static', fakeServer.resourceUrl, {
      callbackPort: 0,
      clientId: 'static-client',
      clientSecret: 'static-secret',
    });

    const authorizationError = await captureAuthorizationError(provider, fakeServer.resourceUrl);
    expect(fakeServer.registrationRequests).toHaveLength(0);
    expect(authorizationError.authUrl).toContain('client_id=static-client');

    const authorizationResponse = await fetch(authorizationError.authUrl, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const callbackResponse = await fetch(
      authorizationResponse.headers.get('location') as string,
    );
    const callbackHtml = await callbackResponse.text();
    expect(callbackResponse.status, callbackHtml).toBe(200);

    expect(fakeServer.tokenRequests).toHaveLength(1);
    const authorizationHeader = fakeServer.tokenRequests[0]?.authorization ?? '';
    expect(authorizationHeader).toMatch(/^Basic\s+/);
    const decoded = Buffer.from(authorizationHeader.replace(/^Basic\s+/, ''), 'base64').toString('utf8');
    expect(decoded).toBe('static-client:static-secret');
    expect(fakeServer.registrationRequests).toHaveLength(0);

    expect(await auth(provider, { serverUrl: fakeServer.resourceUrl })).toBe('AUTHORIZED');
    const refreshRequest = fakeServer.tokenRequests.at(-1);
    expect(refreshRequest?.body.get('grant_type')).toBe('refresh_token');
    expect(refreshRequest?.authorization).toMatch(/^Basic\s+/);

    const stored = await readOAuthStoreEntry('static', fakeServer.resourceUrl);
    expect(stored?.clientInformation?.client_id).toBe('static-client');
    expect(stored?.tokens?.access_token).toBe(fakeServer.lastAccessToken);
  });

  it('surfaces AUTH_REQUIRED through ServerManager and succeeds after the callback', async () => {
    fakeServer = new FakeOAuthMcpServer({ registration: true });
    await fakeServer.start();
    const config: ServerConfig = {
      name: 'managed-oauth',
      description: 'OAuth MCP',
      enabled: true,
      args: [],
      env: {},
      headers: {},
      timeoutMs: 15_000,
      forwardPrompts: false,
      url: fakeServer.resourceUrl,
      oauth: { callbackPort: 0, scope: 'mcp.read' },
    };
    const manager = new ServerManager([config], { logger: silentLogger });
    try {
      let authorizationError: unknown;
      try {
        await manager.listTools('managed-oauth');
      } catch (error) {
        authorizationError = error;
      }
      expect(authorizationError).toBeInstanceOf(AppError);
      expect(authorizationError).toMatchObject({ code: 'AUTH_REQUIRED' });
      const authUrl = (authorizationError as AppError).details?.authUrl;
      expect(typeof authUrl).toBe('string');
      expect(manager.listServers()[0]).toMatchObject({ status: 'auth' });

      const authorizationResponse = await fetch(authUrl as string, { redirect: 'manual' });
      expect(authorizationResponse.status).toBe(302);
      const callbackResponse = await fetch(
        authorizationResponse.headers.get('location') as string,
      );
      const callbackHtml = await callbackResponse.text();
      expect(callbackResponse.status, callbackHtml).toBe(200);

      const tools = await manager.listTools('managed-oauth');
      expect(tools.map((tool) => tool.name)).toContain('echo');
      const result = await manager.callTool('managed-oauth', 'echo', { text: 'after-oauth' });
      expect(result.content[0]).toEqual({ type: 'text', text: 'after-oauth' });
      expect(manager.listServers()[0]).toMatchObject({ status: 'ready' });
    } finally {
      await manager.closeAll();
    }
  });

  it('rejects missing or mismatched callback state and redacts callback errors', async () => {
    fakeServer = new FakeOAuthMcpServer({ registration: true });
    await fakeServer.start();
    const spy = createSpyLogger();
    const provider = await startProvider('state', fakeServer.resourceUrl, { callbackPort: 0 }, spy.logger);
    const authorizationError = await captureAuthorizationError(provider, fakeServer.resourceUrl);
    const state = new URL(authorizationError.authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const missingState = await fetch(provider.redirectUrl + '?code=unused');
    expect(missingState.status).toBe(400);
    expect(await missingState.text()).toContain('Invalid or expired');

    const wrongState = await fetch(provider.redirectUrl + '?code=unused&state=wrong');
    expect(wrongState.status).toBe(400);
    expect(await wrongState.text()).toContain('Invalid or expired');
    expect(fakeServer.tokenRequests).toHaveLength(0);

    const denied = await fetch(
      provider.redirectUrl +
        `?error=access_denied&error_description=${encodeURIComponent(
          'access_token=leaked-token client_secret=leaked-secret',
        )}&state=${encodeURIComponent(state as string)}`,
    );
    expect(denied.status).toBe(400);
    const deniedHtml = await denied.text();
    expect(deniedHtml).not.toContain('leaked-token');
    expect(deniedHtml).not.toContain('leaked-secret');
    expect(spy.text()).not.toContain('leaked-token');
    expect(spy.text()).not.toContain('leaked-secret');
    expect(fakeServer.tokenRequests).toHaveLength(0);
  });

  it('sanitizes error text and never logs stored secrets', async () => {
    const sanitized = sanitizeErrorMessage(
      'failed access_token=abc123 Authorization: Bearer xyz789 secret=shh',
      ['shh'],
    );
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('xyz789');
    expect(sanitized).not.toContain('shh');
    expect(sanitized).toContain('[redacted]');

    const spy = createSpyLogger();
    const provider = await startProvider(
      'logging',
      'http://127.0.0.1:1/mcp',
      { callbackPort: 0, clientId: 'client', clientSecret: 'client-secret-value' },
      spy.logger,
    );
    await provider.saveClientInformation({
      client_id: 'client',
      client_secret: 'client-secret-value',
    });
    await provider.saveTokens({
      access_token: 'access-token-value',
      token_type: 'Bearer',
      refresh_token: 'refresh-token-value',
      expires_in: 60,
    });
    await provider.saveCodeVerifier('code-verifier-value');

    expect(spy.text()).not.toContain('client-secret-value');
    expect(spy.text()).not.toContain('access-token-value');
    expect(spy.text()).not.toContain('refresh-token-value');
    expect(spy.text()).not.toContain('code-verifier-value');
  });

  it('keys the store by server name and normalized URL', () => {
    const url = 'http://127.0.0.1:1234/mcp';
    expect(oauthStoreKey('one', url)).toBe(oauthStoreKey('one', url + '#fragment'));
    expect(oauthStoreKey('one', url)).not.toBe(oauthStoreKey('two', url));
  });
});
