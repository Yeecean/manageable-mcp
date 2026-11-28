import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseConfig } from '../config/load.js';
import { errorMessage } from '../core/errors.js';

export type RawServerConfig = Record<string, unknown>;
export type RawGroupConfig = Record<string, unknown>;

export interface RawConfigSnapshot {
  servers: RawServerConfig[];
  groups: Record<string, RawGroupConfig>;
}

export class AdminError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

interface DocumentFormat {
  bom: boolean;
  newline: '\n' | '\r\n';
  pretty: boolean;
  indent: string;
  trailingNewline: boolean;
}

interface RawDocument {
  root: Record<string, unknown>;
  servers: RawServerConfig[];
  groups: Record<string, RawGroupConfig>;
  format: DocumentFormat;
}

const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const DEFAULT_INDENT = '  ';

export class AdminConfigStore {
  private readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
  }

  get path(): string {
    return this.configPath;
  }

  async snapshot(): Promise<RawConfigSnapshot> {
    const document = await this.read();
    return {
      servers: cloneJson(document.servers),
      groups: cloneJson(document.groups),
    };
  }

  async list(): Promise<RawServerConfig[]> {
    return (await this.snapshot()).servers;
  }

  async readText(): Promise<string> {
    try {
      return await fs.promises.readFile(this.configPath, 'utf8');
    } catch (error) {
      throw new AdminError(
        500,
        `Cannot read config file '${this.configPath}': ${errorMessage(error)}`,
      );
    }
  }

  async restoreText(text: string): Promise<void> {
    await this.writeSerialized(text);
  }

  async get(name: string): Promise<RawServerConfig> {
    const document = await this.read();
    const server = findServer(document, name);
    if (!server) throw new AdminError(404, `Server '${name}' not found`);
    return cloneJson(server);
  }

  async add(input: RawServerConfig): Promise<RawServerConfig> {
    if (!isRecord(input)) throw new AdminError(400, 'Server entry must be a JSON object');
    const document = await this.read();
    const server = cloneJson(input);
    const name = serverName(server);
    if (document.servers.some((existing) => existing.name === name)) {
      throw new AdminError(409, `Server '${name}' already exists`);
    }

    document.servers.push(server);
    this.validate(document.root);
    await this.write(document);
    return cloneJson(server);
  }

  async update(name: string, input: RawServerConfig): Promise<RawServerConfig> {
    if (!isRecord(input)) throw new AdminError(400, 'Server entry must be a JSON object');
    const document = await this.read();
    const index = document.servers.findIndex((server) => server.name === name);
    if (index < 0) throw new AdminError(404, `Server '${name}' not found`);

    const replacement = cloneJson(input);
    if (replacement.name !== undefined && replacement.name !== name) {
      throw new AdminError(400, 'Server name in the request body must match the URL');
    }
    replacement.name = name;
    document.servers[index] = replacement;

    this.validate(document.root);
    await this.write(document);
    return cloneJson(replacement);
  }

  async setEnabled(name: string, enabled: boolean): Promise<RawServerConfig> {
    if (typeof enabled !== 'boolean') {
      throw new AdminError(400, 'Property "enabled" must be a boolean');
    }
    const document = await this.read();
    const server = findServer(document, name);
    if (!server) throw new AdminError(404, `Server '${name}' not found`);

    server.enabled = enabled;
    this.validate(document.root);
    await this.write(document);
    return cloneJson(server);
  }

  async remove(name: string): Promise<void> {
    const document = await this.read();
    const index = document.servers.findIndex((server) => server.name === name);
    if (index < 0) throw new AdminError(404, `Server '${name}' not found`);

    document.servers.splice(index, 1);
    stripServerFromGroups(document.root, name);
    this.validate(document.root);
    await this.write(document);
  }

  private async read(): Promise<RawDocument> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.configPath, 'utf8');
    } catch (error) {
      throw new AdminError(
        500,
        `Cannot read config file '${this.configPath}': ${errorMessage(error)}`,
      );
    }

    const format = detectFormat(text);
    const body = format.bom ? text.slice(1) : text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new AdminError(
        500,
        `Config file '${this.configPath}' is not valid JSON: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new AdminError(500, `Config file '${this.configPath}' must contain a JSON object`);
    }

    const rawServers = parsed.servers;
    if (!Array.isArray(rawServers)) {
      throw new AdminError(500, `Config file '${this.configPath}' must contain a "servers" array`);
    }
    const servers = rawServers as RawServerConfig[];
    rawServers.forEach((item, index) => {
      if (!isRecord(item)) {
        throw new AdminError(500, `Config servers[${index}] must be a JSON object`);
      }
    });

    const rawGroups = parsed.groups;
    if (rawGroups !== undefined && !isRecord(rawGroups)) {
      throw new AdminError(500, `Config file '${this.configPath}' has an invalid "groups" object`);
    }

    return {
      root: parsed,
      servers,
      groups: (rawGroups ?? {}) as Record<string, RawGroupConfig>,
      format,
    };
  }

  private validate(root: Record<string, unknown>): void {
    try {
      parseConfig(root, this.configPath);
    } catch (error) {
      throw new AdminError(400, `Invalid config: ${errorMessage(error)}`);
    }
  }

  private async write(document: RawDocument): Promise<void> {
    await this.writeSerialized(stringifyDocument(document));
  }

  private async writeSerialized(serialized: string): Promise<void> {
    const tempPath = path.join(
      path.dirname(this.configPath),
      `.${path.basename(this.configPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      const handle = await fs.promises.open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(tempPath, this.configPath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw new AdminError(
        500,
        `Cannot write config file '${this.configPath}': ${errorMessage(error)}`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function serverName(server: RawServerConfig): string {
  if (typeof server.name !== 'string' || server.name.trim().length === 0) {
    throw new AdminError(400, 'Server name is required and must be a non-empty string');
  }
  return server.name;
}

function findServer(document: RawDocument, name: string): RawServerConfig | undefined {
  return document.servers.find((server) => server.name === name);
}

function detectFormat(text: string): DocumentFormat {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const newline: '\n' | '\r\n' = body.includes('\r\n') ? '\r\n' : '\n';
  const pretty = body.includes('\n');
  const indentMatch = /\r?\n([ \t]+)"/.exec(body);
  const indent = indentMatch?.[1] ?? DEFAULT_INDENT;
  const trailingNewline = /(?:\r\n|\n)$/.test(body);
  return { bom, newline, pretty, indent, trailingNewline };
}

function stringifyDocument(document: RawDocument): string {
  const { format } = document;
  let serialized = format.pretty
    ? JSON.stringify(document.root, null, format.indent)
    : JSON.stringify(document.root);
  if (typeof serialized !== 'string') {
    throw new AdminError(500, 'Config could not be serialized');
  }
  if (format.pretty && format.newline === '\r\n') {
    serialized = serialized.replace(/\n/g, '\r\n');
  }
  if (format.trailingNewline) serialized += format.newline;
  if (format.bom) serialized = `\uFEFF${serialized}`;
  return serialized;
}

function stripServerFromGroups(root: Record<string, unknown>, name: string): void {
  const rawGroups = root.groups;
  if (!isRecord(rawGroups)) return;

  for (const [groupName, group] of Object.entries(rawGroups)) {
    if (!isRecord(group) || !Array.isArray(group.servers)) continue;
    const members = group.servers;
    const remaining = members.filter((member) => member !== name);
    if (remaining.length === members.length) continue;
    if (remaining.length === 0) {
      delete rawGroups[groupName];
    } else {
      group.servers = remaining;
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
