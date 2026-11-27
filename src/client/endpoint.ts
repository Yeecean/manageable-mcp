import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { getDefaultCliEndpointPath } from '../config/paths.js';
import { AppError, errorMessage } from '../core/errors.js';

export interface CliEndpoint {
  url: string;
  authToken?: string;
  pid: number;
  startedAt: string;
  version: string;
}

export function isLoopbackUrl(value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '::1') return true;
  return isIP(hostname) === 4 && hostname.startsWith('127.');
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function normalizeEndpoint(endpoint: CliEndpoint, source: string): CliEndpoint {
  if (typeof endpoint.url !== 'string' || endpoint.url.length === 0) {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "url" 必须是非空字符串`);
  }
  if (!Number.isInteger(endpoint.pid) || endpoint.pid <= 0) {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "pid" 必须是正整数`);
  }
  if (typeof endpoint.startedAt !== 'string' || endpoint.startedAt.length === 0) {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "startedAt" 必须是非空字符串`);
  }
  if (typeof endpoint.version !== 'string' || endpoint.version.length === 0) {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "version" 必须是非空字符串`);
  }
  if (endpoint.authToken !== undefined && typeof endpoint.authToken !== 'string') {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "authToken" 存在时必须是字符串`);
  }

  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "url" 不是有效的 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_PARAMETERS', `${source}：CLI 端点 "url" 必须使用 http:// 或 https://`);
  }

  return {
    url: endpoint.url,
    pid: endpoint.pid,
    startedAt: endpoint.startedAt,
    version: endpoint.version,
    ...(endpoint.authToken === undefined ? {} : { authToken: endpoint.authToken }),
  };
}

function parseEndpoint(raw: string, endpointPath: string): CliEndpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `无法读取 CLI 端点 ${endpointPath}：${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('SERVER_UNAVAILABLE', `${endpointPath} 不是 JSON 对象`);
  }
  try {
    return normalizeEndpoint(parsed as CliEndpoint, endpointPath);
  } catch (error) {
    throw new AppError('SERVER_UNAVAILABLE', errorMessage(error));
  }
}

export function readCliEndpoint(): CliEndpoint {
  const endpointPath = getDefaultCliEndpointPath();
  let raw: string;
  try {
    raw = fs.readFileSync(endpointPath, 'utf8');
  } catch (error) {
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `无法读取 CLI 端点 ${endpointPath}：${errorMessage(error)}`,
    );
  }

  const endpoint = parseEndpoint(raw, endpointPath);
  if (!isProcessAlive(endpoint.pid)) {
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `CLI 端点 ${endpointPath} 已失效（PID ${endpoint.pid} 未运行）`,
    );
  }
  if (!isLoopbackUrl(endpoint.url)) {
    throw new AppError(
      'SERVER_UNAVAILABLE',
      `CLI 端点 ${endpointPath} 包含非回环 URL；请显式传入 --url`,
    );
  }
  return endpoint;
}

export function writeCliEndpoint(endpoint: CliEndpoint): void {
  const endpointPath = getDefaultCliEndpointPath();
  const normalized = normalizeEndpoint(endpoint, 'writeCliEndpoint');
  fs.mkdirSync(path.dirname(endpointPath), { recursive: true, mode: 0o700 });

  const temporaryPath = `${endpointPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, endpointPath);
  } catch (error) {
    throw new AppError(
      'INTERNAL_ERROR',
      `无法写入 CLI 端点 ${endpointPath}：${errorMessage(error)}`,
    );
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename already removed the temporary file.
    }
  }
}

export function removeCliEndpoint(endpoint: Pick<CliEndpoint, 'url' | 'pid'>): boolean {
  const endpointPath = getDefaultCliEndpointPath();
  try {
    const current = JSON.parse(fs.readFileSync(endpointPath, 'utf8')) as Partial<CliEndpoint>;
    if (current.pid === endpoint.pid && current.url === endpoint.url) {
      fs.unlinkSync(endpointPath);
      return true;
    }
  } catch {
    // Missing, corrupt, or replaced endpoint files are not ours to remove.
  }
  return false;
}
