const SENSITIVE_ASSIGNMENT =
  /\b(access_token|refresh_token|id_token|client_secret|code_verifier|authorization|password|secret|token)(\s*[:=]\s*)([^\s&,;"'}]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASIC_CREDENTIALS = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
const MAX_ERROR_LENGTH = 800;

/**
 * Produces a short, single-line error string that is safe to log or render.
 * Callers should pass values they know are secret (tokens, verifiers, secrets)
 * in addition to the generic key/value redaction below.
 */
export function sanitizeErrorMessage(message: string, secrets: readonly string[] = []): string {
  let result = message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH);

  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    result = result.split(secret).join('[redacted]');
  }

  return result
    .replace(BEARER_TOKEN, 'Bearer [redacted]')
    .replace(BASIC_CREDENTIALS, 'Basic [redacted]')
    .replace(SENSITIVE_ASSIGNMENT, '$1$2[redacted]');
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
    return '[invalid-url]';
  }
}
