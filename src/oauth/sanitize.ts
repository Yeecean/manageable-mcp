const SENSITIVE_KEY =
  '[A-Za-z0-9_.-]*(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier|authorization|api[_-]?key|password|secret|token)[A-Za-z0-9_.-]*';
const SENSITIVE_FIELD_NAME =
  /^(?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier|api[_-]?key|password|secret|token)$/i;
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(["']?\b${SENSITIVE_KEY}["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&,;}]+)`,
  'gi',
);
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASIC_CREDENTIALS = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
const MAX_ERROR_LENGTH = 800;

/**
 * Produces a short, single-line error string that is safe to log or render.
 * Callers should pass values they know are secret (tokens, verifiers, secrets)
 * in addition to the generic key/value redaction below.
 */
export function sanitizeErrorMessage(message: string, secrets: readonly string[] = []): string {
  let result = message.replace(/[\r\n\t]+/g, ' ').trim();

  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    result = result.split(secret).join('[已脱敏]');
  }

  return result
    .replace(URL_PATTERN, (candidate) => sanitizeUrlForLog(candidate))
    .replace(BEARER_TOKEN, 'Bearer [已脱敏]')
    .replace(BASIC_CREDENTIALS, 'Basic [已脱敏]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[已脱敏]')
    .slice(0, MAX_ERROR_LENGTH);
}

/**
 * Recursively strips secrets from structured error payloads while preserving
 * their shape. Field names are checked before their string values, so a
 * generic value under `token` or `api_key` is still removed.
 */
export function sanitizeStructuredValue(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === 'string') return sanitizeErrorMessage(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValue(item, secrets));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_FIELD_NAME.test(key)
          ? '[已脱敏]'
          : sanitizeStructuredValue(item, secrets),
      ]),
    );
  }
  return value;
}

/**
 * Removes credentials and query/fragment data before a URL is written to logs.
 */
export function sanitizeUrlForLog(value: string | URL): string {
  try {
    const url = typeof value === 'string' ? new URL(value) : new URL(value.href);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[无效 URL]';
  }
}
