export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function serializeFields(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return '';
  return ` ${JSON.stringify(fields)}`;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVELS[level];

  function write(entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[entryLevel] < threshold) return;
    const timestamp = new Date().toISOString();
    process.stderr.write(`[${timestamp}] ${entryLevel.toUpperCase()} ${message}${serializeFields(fields)}\n`);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
