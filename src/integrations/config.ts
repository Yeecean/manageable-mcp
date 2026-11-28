import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { deletePath, parse as parseToml, setPath, stringify as stringifyToml, toJS } from '@watolua/toml';
import type { JsValue } from '@watolua/toml';
import { applyEdits, modify, parse as parseJson, parseTree } from 'jsonc-parser';
import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { AppError } from '../core/errors.js';

export const CLIENTS = ['claude', 'codex', 'opencode', 'cursor'] as const;
export type ClientName = typeof CLIENTS[number];
export const SERVER_NAME = 'manageable-mcp';

export interface LaunchSpec {
  command: string;
  args: string[];
}

export function defaultClientConfigPath(client: ClientName): string {
  const home = os.homedir();
  switch (client) {
    case 'claude':
      return process.env.CLAUDE_CONFIG_DIR
        ? path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json')
        : path.join(home, '.claude.json');
    case 'codex':
      return path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
    case 'opencode': {
      const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
      const jsonc = path.join(directory, 'opencode.jsonc');
      return fs.existsSync(jsonc) ? jsonc : path.join(directory, 'opencode.json');
    }
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
  }
}

function entryPath(client: ClientName): string[] {
  if (client === 'codex') return ['mcp_servers', SERVER_NAME];
  if (client === 'opencode') return ['mcp', 'servers', SERVER_NAME];
  return ['mcpServers', SERVER_NAME];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectDuplicateJsonKeys(node: JsonNode | undefined): void {
  if (!node) return;
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== 'string' || keys.has(key)) {
        throw new AppError('CONFIG_INVALID', '客户端配置包含重复的键，无法安全修改');
      }
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateJsonKeys(child);
}

function parseDocument(client: ClientName, text: string): Record<string, unknown> {
  const body = text.replace(/^\uFEFF/, '');
  try {
    if (client === 'codex') {
      const value: unknown = toJS(parseToml(body));
      if (!isRecord(value)) throw new Error();
      return value;
    }
    const errors: ParseError[] = [];
    const tree = parseTree(body, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !tree || tree.type !== 'object') throw new Error();
    rejectDuplicateJsonKeys(tree);
    const value: unknown = parseJson(body, [], { allowTrailingComma: true });
    if (!isRecord(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('CONFIG_INVALID', `${client} 客户端配置格式有误，未作修改`);
  }
}

function getEntry(root: Record<string, unknown>, components: string[]): unknown {
  let current: unknown = root;
  for (const component of components) {
    if (!isRecord(current)) throw new AppError('CONFIG_INVALID', '客户端配置的服务器节点不是对象');
    if (!Object.hasOwn(current, component)) return undefined;
    current = current[component];
  }
  return current;
}

function withoutEntry(root: Record<string, unknown>, components: string[]): Record<string, unknown> {
  const copy = structuredClone(root);
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current: Record<string, unknown> = copy;
  for (const component of components.slice(0, -1)) {
    const next = current[component];
    if (!isRecord(next)) return copy;
    parents.push({ parent: current, key: component });
    current = next;
  }
  delete current[components[components.length - 1] as string];
  for (const item of parents.reverse()) {
    const value = item.parent[item.key];
    if (isRecord(value) && Object.keys(value).length === 0) delete item.parent[item.key];
    else break;
  }
  return copy;
}

export function clientEntry(client: ClientName, spec: LaunchSpec): Record<string, unknown> {
  if (client === 'opencode') {
    return { type: 'local', command: [spec.command, ...spec.args], disabled: false, codemode: false };
  }
  if (client === 'claude') return { type: 'stdio', command: spec.command, args: spec.args };
  return { command: spec.command, args: spec.args };
}

export function readClientEntry(client: ClientName, text: string): unknown {
  return getEntry(parseDocument(client, text), entryPath(client));
}

export function editClientEntry(
  client: ClientName,
  text: string,
  entry: Record<string, unknown> | undefined,
): string {
  const components = entryPath(client);
  const before = parseDocument(client, text);
  getEntry(before, components);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  let updated: string;
  try {
    if (client === 'codex') {
      const document = parseToml(body);
      if (entry === undefined) deletePath(document, components);
      else setPath(document, components, entry as JsValue);
      updated = stringifyToml(document);
    } else {
      const edits = modify(body, components, entry, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: body.includes('\r\n') ? '\r\n' : '\n',
        },
      });
      updated = applyEdits(body, edits);
    }
  } catch {
    throw new AppError('CONFIG_INVALID', `${client} 客户端配置无法安全修改`);
  }
  const result = bom + updated;
  const after = parseDocument(client, result);
  if (!isDeepStrictEqual(withoutEntry(before, components), withoutEntry(after, components)) ||
      !isDeepStrictEqual(getEntry(after, components), entry)) {
    throw new AppError('CONFIG_INVALID', `${client} 客户端配置修改校验失败，未作修改`);
  }
  return result;
}

export function readLaunchSpec(client: ClientName, entry: unknown): LaunchSpec | undefined {
  if (!isRecord(entry)) return undefined;
  if (client === 'opencode') {
    if (entry.type !== 'local' || !Array.isArray(entry.command) || entry.command.length === 0 ||
        entry.command.some((part) => typeof part !== 'string')) return undefined;
    return { command: entry.command[0] as string, args: entry.command.slice(1) as string[] };
  }
  if (typeof entry.command !== 'string' || !Array.isArray(entry.args) ||
      entry.args.some((part) => typeof part !== 'string')) return undefined;
  return { command: entry.command, args: entry.args as string[] };
}
