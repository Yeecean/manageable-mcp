import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { OAuthAuthorizationRequiredError, errorMessage } from '../core/errors.js';
import { silentLogger, type Logger } from '../core/logger.js';
import { TimeoutError, withTimeout } from '../core/timeout.js';
import type { ServerConfig } from '../config/types.js';
import { createOAuthProvider } from '../oauth/index.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

const MAX_TOOL_PAGES = 100;
const MAX_PROMPT_PAGES = 100;

export interface DownstreamConnection {
  readonly promptsSupported: boolean;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  listPrompts(): Promise<Prompt[]>;
  getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult>;
  ping(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

function processEnv(extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...extra };
}

export async function connectDownstream(
  config: ServerConfig,
  logger: Logger = silentLogger,
): Promise<DownstreamConnection> {
  const client = new Client(
    { name: `${PACKAGE_NAME}-client`, version: VERSION },
    { capabilities: {} },
  );

  const oauthProvider = config.url === undefined
    ? undefined
    : createOAuthProvider(config.name, config.url, config.oauth ?? {}, logger);
  if (oauthProvider !== undefined && (config.oauth !== undefined || oauthProvider.callbackPort === 0)) {
    await oauthProvider.ready;
  }
  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
        ...(oauthProvider === undefined
          ? {}
          : { authProvider: oauthProvider, fetch: oauthProvider.oauthFetch }),
      })
    : new StdioClientTransport({
        command: config.command as string,
        args: config.args,
        cwd: config.cwd,
        env: processEnv(config.env),
        stderr: 'inherit',
      });

  try {
    await withTimeout(
      client.connect(transport, { timeout: config.timeoutMs }),
      config.timeoutMs,
      `connect to '${config.name}'`,
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof OAuthAuthorizationRequiredError) throw error;
    if (isOAuthAuthorizationError(error) && oauthProvider?.lastAuthorizationUrl !== undefined) {
      throw new OAuthAuthorizationRequiredError(oauthProvider.lastAuthorizationUrl);
    }
    if (error instanceof TimeoutError) throw error;
    throw new Error(`Failed to connect to '${config.name}': ${errorMessage(error)}`);
  }

  return {
    get promptsSupported(): boolean {
      return client.getServerCapabilities()?.prompts !== undefined;
    },

    async listTools(): Promise<Tool[]> {
      const tools: Tool[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await withTimeout(
          client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: config.timeoutMs }),
          config.timeoutMs,
          `tools/list on '${config.name}'`,
        );
        tools.push(...result.tools);

        if (!result.nextCursor) break;
        if (seenCursors.has(result.nextCursor)) {
          throw new Error(`tools/list on '${config.name}' repeated cursor '${result.nextCursor}'`);
        }
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }

      return tools;
    },

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
      return await withTimeout(
        client.callTool({ name, arguments: args }, undefined, {
          timeout: config.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        }),
        config.timeoutMs,
        `tools/call '${name}' on '${config.name}'`,
      ) as unknown as CallToolResult;
    },

    async listPrompts(): Promise<Prompt[]> {
      const prompts: Prompt[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_PROMPT_PAGES; page += 1) {
        const result = await withTimeout(
          client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout: config.timeoutMs }),
          config.timeoutMs,
          `prompts/list on '${config.name}'`,
        );
        prompts.push(...result.prompts);
        if (!result.nextCursor) break;
        if (seenCursors.has(result.nextCursor)) {
          throw new Error(`prompts/list on '${config.name}' repeated cursor '${result.nextCursor}'`);
        }
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      return prompts;
    },

    async getPrompt(
      name: string,
      args?: Record<string, string>,
      signal?: AbortSignal,
    ): Promise<GetPromptResult> {
      return await withTimeout(
        client.getPrompt({ name, ...(args === undefined ? {} : { arguments: args }) }, {
          timeout: config.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        }),
        config.timeoutMs,
        `prompts/get '${name}' on '${config.name}'`,
      );
    },

    async ping(signal?: AbortSignal): Promise<void> {
      await withTimeout(
        client.ping({
          timeout: config.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        }),
        config.timeoutMs,
        `ping '${config.name}'`,
      );
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

function isOAuthAuthorizationError(error: unknown): boolean {
  const message = errorMessage(error);
  return /unauthorized|authorization required|oauth/i.test(message);
}
