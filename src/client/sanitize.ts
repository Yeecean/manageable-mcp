export function sanitizeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return '<无效 URL>';
  }
  return `${url.protocol}//${url.host}${url.pathname}`;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
const QUERY_PATTERN = /([?&][^=\s&]+)=[^&\s]+/g;
const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+\S+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_.-]*)=\S+/gi;

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(URL_PATTERN, (candidate) => sanitizeEndpoint(candidate))
    .replace(QUERY_PATTERN, '$1=[已脱敏]')
    .replace(AUTHORIZATION_PATTERN, '$1 [已脱敏]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[已脱敏]');
}
