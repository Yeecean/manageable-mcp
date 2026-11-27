import { randomBytes } from 'node:crypto';
import {
  selectClientAuthMethod,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthConfig } from '../config/types.js';
import { AppError, OAuthAuthorizationRequiredError } from '../core/errors.js';
import { silentLogger, type Logger } from '../core/logger.js';
import {
  clearPendingOAuthFlows,
  closeAllOAuthCallbackServers,
  getOrStartOAuthCallbackServer,
  registerPendingOAuthFlow,
  resolveOAuthCallbackPort,
  type OAuthCallbackServerHandle,
  type OAuthFlowProvider,
} from './callback-server.js';
import { sanitizeErrorMessage, sanitizeUrlForLog } from './sanitize.js';
import {
  invalidateOAuthStoreEntry,
  oauthStoreKey,
  readOAuthStoreEntry,
  updateOAuthStoreEntry,
  type OAuthCredentialScope,
} from './store.js';
import type { OAuthStoreEntry, StoredOAuthTokens } from './types.js';

export interface ManageableOAuthProvider extends OAuthFlowProvider {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly callbackPort: number;
  readonly ready: Promise<void>;
  readonly lastAuthorizationUrl: string | undefined;
  readonly oauthFetch: FetchLike;
  redactionSecrets(): Promise<readonly string[]>;
}

const providers = new Map<string, OAuthProviderImpl>();

class OAuthProviderImpl implements ManageableOAuthProvider {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly oauthFetch: FetchLike;

  private readonly config: OAuthConfig;
  private readonly logger: Logger;
  private readonly requestedCallbackPort: number;
  private callbackServer?: OAuthCallbackServerHandle;
  private readyPromise?: Promise<void>;
  private initializationError?: Error;
  private entryCache?: OAuthStoreEntry;
  private entryLoaded = false;
  private authorizationUrl?: string;

  constructor(
    serverName: string,
    serverUrl: string,
    config: OAuthConfig,
    logger: Logger,
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.config = {
      ...config,
      ...(config.extraHeaders === undefined
        ? {}
        : { extraHeaders: { ...config.extraHeaders } }),
    };
    this.logger = logger;
    this.requestedCallbackPort = resolveOAuthCallbackPort(config.callbackPort);
    this.addClientAuthentication = this.addClientAuthentication.bind(this);
    this.oauthFetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      this.applyExtraHeaders(headers);
      return await fetch(url, {
        ...(init === undefined ? {} : init),
        headers,
      });
    };

  }

  get ready(): Promise<void> {
    return this.ensureCallbackServer();
  }

  get redirectUrl(): string {
    if (this.callbackServer !== undefined) return this.callbackServer.callbackUrl;
    if (this.initializationError !== undefined) throw this.initializationError;
    if (this.requestedCallbackPort !== 0) {
      return `http://127.0.0.1:${this.requestedCallbackPort}/callback`;
    }
    throw new AppError(
      'INTERNAL_ERROR',
      `服务器 '${this.serverName}' 的 OAuth 回调服务器仍在启动中；请先等待 provider.ready`,
    );
  }

  get callbackPort(): number {
    return this.callbackServer?.port ?? this.requestedCallbackPort;
  }

  get lastAuthorizationUrl(): string | undefined {
    return this.authorizationUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `manageable-mcp (${this.serverName})`,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.clientSecret === undefined ? 'none' : 'client_secret_basic',
      ...(this.config.scope === undefined ? {} : { scope: this.config.scope }),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId !== undefined) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret === undefined
          ? {}
          : { client_secret: this.config.clientSecret }),
      };
    }

    return (await this.loadEntry())?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (typeof clientInformation.client_id !== 'string' || clientInformation.client_id.length === 0) {
      throw new AppError('AUTH_REQUIRED', `服务器 '${this.serverName}' 的 OAuth 客户端信息缺少 client_id`);
    }

    await this.updateEntry((entry) => {
      entry.clientInformation = { ...clientInformation };
    });
    this.logger.debug('Saved OAuth client information', {
      server: this.serverName,
      hasSecret: clientInformation.client_secret !== undefined,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = (await this.loadEntry())?.tokens;
    if (stored === undefined) return undefined;

    const { expiresAt, ...tokens } = stored;
    if (expiresAt === undefined || tokens.expires_in === undefined) return tokens;

    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000));
    return { ...tokens, expires_in: remaining };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
    const stored: StoredOAuthTokens = {
      ...tokens,
      ...(expiresIn === undefined
        ? {}
        : {
            expiresAt:
              Date.now() + (Number.isFinite(expiresIn) ? Math.max(0, expiresIn) : 0) * 1_000,
          }),
    };

    await this.updateEntry((entry) => {
      entry.tokens = stored;
    });
    this.logger.debug('Saved OAuth tokens', {
      server: this.serverName,
      hasRefreshToken: tokens.refresh_token !== undefined,
      expiresIn,
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.updateEntry((entry) => {
      entry.codeVerifier = codeVerifier;
    });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.loadEntry())?.codeVerifier;
    if (verifier === undefined || verifier.length === 0) {
      throw new AppError(
        'AUTH_REQUIRED',
        `服务器 '${this.serverName}' 缺少 OAuth code verifier；请重新发起授权流程`,
      );
    }
    return verifier;
  }

  async state(): Promise<string> {
    await this.ready;
    const state = randomBytes(32).toString('base64url');
    registerPendingOAuthFlow({
      state,
      provider: this,
      serverName: this.serverName,
      serverUrl: this.serverUrl,
      callbackPort: this.callbackPort,
      fetchFn: this.oauthFetch,
    });
    return state;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.ready;

    const state = authorizationUrl.searchParams.get('state');
    if (state === null || state.length === 0) {
      throw new AppError(
        'AUTH_REQUIRED',
        `服务器 '${this.serverName}' 的 OAuth 授权 URL 缺少 state 参数`,
      );
    }

    this.authorizationUrl = authorizationUrl.toString();
    registerPendingOAuthFlow({
      state,
      provider: this,
      serverName: this.serverName,
      serverUrl: this.serverUrl,
      callbackPort: this.callbackPort,
      authorizationUrl: this.authorizationUrl,
      fetchFn: this.oauthFetch,
    });
    this.logger.info('OAuth authorization required', {
      server: this.serverName,
      authorizationEndpoint: sanitizeUrlForLog(authorizationUrl),
    });
    throw new OAuthAuthorizationRequiredError(this.authorizationUrl);
  }

  async addClientAuthentication(
    headers: Headers,
    params: URLSearchParams,
    _url: string | URL,
    metadata?: AuthorizationServerMetadata,
  ): Promise<void> {
    this.applyExtraHeaders(headers);

    const clientInformation = await this.clientInformation();
    if (clientInformation === undefined) return;

    const method = selectClientAuthMethod(
      clientInformation,
      metadata?.token_endpoint_auth_methods_supported ?? [],
    );
    if (method === 'client_secret_basic') {
      const credentials = Buffer.from(
        `${clientInformation.client_id}:${clientInformation.client_secret ?? ''}`,
        'utf8',
      ).toString('base64');
      headers.set('Authorization', `Basic ${credentials}`);
      return;
    }
    if (method === 'client_secret_post') {
      params.set('client_id', clientInformation.client_id);
      if (clientInformation.client_secret !== undefined) {
        params.set('client_secret', clientInformation.client_secret);
      }
      return;
    }
    params.set('client_id', clientInformation.client_id);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.updateEntry((entry) => {
      entry.discoveryState = state;
    });
    this.logger.debug('Saved OAuth discovery state', {
      server: this.serverName,
      authorizationServer: sanitizeUrlForLog(state.authorizationServerUrl),
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = (await this.loadEntry())?.discoveryState;
    if (state === undefined || typeof state.authorizationServerUrl !== 'string') return undefined;
    return state;
  }

  async invalidateCredentials(scope: OAuthCredentialScope): Promise<void> {
    const entry = await invalidateOAuthStoreEntry(
      this.serverName,
      this.serverUrl,
      scope,
      this.logger,
    );
    this.entryCache = entry;
    this.entryLoaded = true;
    this.logger.debug('Invalidated OAuth credentials', { server: this.serverName, scope });
  }

  async redactionSecrets(): Promise<readonly string[]> {
    const entry = await this.loadEntry().catch(() => undefined);
    return [
      this.config.clientSecret,
      entry?.clientInformation?.client_secret,
      entry?.tokens?.access_token,
      entry?.tokens?.refresh_token,
      entry?.tokens?.id_token,
      entry?.codeVerifier,
    ].filter((value): value is string => typeof value === 'string' && value.length >= 3);
  }

  private async startCallbackServer(): Promise<void> {
    try {
      this.callbackServer = await getOrStartOAuthCallbackServer(
        this.requestedCallbackPort,
        this.logger,
      );
      this.logger.debug('OAuth callback server ready', {
        server: this.serverName,
        port: this.callbackServer.port,
      });
    } catch (error) {
      this.initializationError =
        error instanceof Error ? error : new Error(String(error));
      this.logger.error('OAuth callback server failed to start', {
        server: this.serverName,
        error: sanitizeErrorMessage(this.initializationError.message),
      });
      throw this.initializationError;
    }
  }

  private ensureCallbackServer(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise;
    this.readyPromise = this.startCallbackServer().catch((error: unknown) => {
      this.initializationError = error instanceof Error ? error : new Error(String(error));
      throw this.initializationError;
    });
    return this.readyPromise;
  }

  private applyExtraHeaders(headers: Headers): void {
    for (const [name, value] of Object.entries(this.config.extraHeaders ?? {})) {
      headers.set(name, value);
    }
  }

  private async loadEntry(): Promise<OAuthStoreEntry | undefined> {
    if (this.entryLoaded) return this.entryCache;
    this.entryCache = await readOAuthStoreEntry(this.serverName, this.serverUrl, this.logger);
    this.entryLoaded = true;
    return this.entryCache;
  }

  private async updateEntry(update: (entry: OAuthStoreEntry) => void): Promise<void> {
    this.entryCache = await updateOAuthStoreEntry(
      this.serverName,
      this.serverUrl,
      update,
      this.logger,
    );
    this.entryLoaded = true;
  }
}

export function createOAuthProvider(
  serverName: string,
  serverUrl: string,
  config: OAuthConfig = {},
  logger: Logger = silentLogger,
): ManageableOAuthProvider {
  if (config.clientSecret !== undefined && config.clientId === undefined) {
    throw new AppError(
      'CONFIG_INVALID',
      `服务器 '${serverName}' 配置 OAuth clientSecret 时必须同时配置 oauth.clientId`,
    );
  }

  const key = oauthStoreKey(serverName, serverUrl);
  const existing = providers.get(key);
  if (existing !== undefined) return existing;

  const provider = new OAuthProviderImpl(serverName, serverUrl, config, logger);
  providers.set(key, provider);
  return provider;
}

/**
 * Clears cached providers and pending state, then closes every local callback
 * listener. Tests should await this before starting another OAuth scenario on
 * the same fixed port.
 */
export async function resetOAuthProvidersForTests(): Promise<void> {
  providers.clear();
  clearPendingOAuthFlows();
  await closeAllOAuthCallbackServers();
}

export const resetOAuthForTests = resetOAuthProvidersForTests;
