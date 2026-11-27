export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'SERVER_NOT_FOUND'
  | 'SERVER_DISABLED'
  | 'SERVER_UNAVAILABLE'
  | 'TOOL_NOT_FOUND'
  | 'PROMPT_NOT_FOUND'
  | 'POLICY_BLOCKED'
  | 'AUTH_REQUIRED'
  | 'INVALID_PARAMETERS'
  | 'TOOL_EXECUTION_FAILED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

export class OAuthAuthorizationRequiredError extends Error {
  readonly authUrl: string;

  constructor(authUrl: string) {
    super('OAuth authorization is required');
    this.name = 'OAuthAuthorizationRequiredError';
    this.authUrl = authUrl;
  }
}
