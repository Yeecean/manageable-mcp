import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../core/errors.js';
import { TimeoutError, withTimeout } from '../core/timeout.js';
import type { ServerConfig } from '../config/types.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

const MAX_TOOL_PAGES = 100;

export interface DownstreamConnection {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

function processEnv(extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...extra };
}

export async function connectDownstream(config: ServerConfig): Promise<DownstreamConnection> {
  const client = new Client(
    { name: `${PACKAGE_NAME}-client`, version: VERSION },
    { capabilities: {} },
  );

  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
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
    if (error instanceof TimeoutError) throw error;
    throw new Error(`Failed to connect to '${config.name}': ${errorMessage(error)}`);
  }

  return {
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

    async close(): Promise<void> {
      await client.close();
    },
  };
}
