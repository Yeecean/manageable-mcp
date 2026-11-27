const SENSITIVE_FLAG_NAME =
  /^(?:auth|authorization|access[-_]?token|api[-_]?key|header|headers|key|password|secret|token)$/i;
const SENSITIVE_QUERY_NAME =
  /^(?:api[_-]?key|apikey|auth|access[_-]?token|key|password|secret|sig|signature|state|subscription[_-]?key|token)$/i;

export function redactUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const name of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_NAME.test(name)) url.searchParams.set(name, '***');
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactCommandForDisplay(parts: readonly string[]): string {
  const output: string[] = [];
  let redactNext = false;

  for (const part of parts) {
    if (redactNext) {
      output.push('***');
      redactNext = false;
      continue;
    }

    const match = /^(--?[^=]+)(?:=(.*))?$/.exec(part);
    if (match === null) {
      output.push(part);
      continue;
    }

    const flag = match[1] as string;
    const name = flag.replace(/^--?/, '');
    if (!SENSITIVE_FLAG_NAME.test(name)) {
      output.push(part);
      continue;
    }

    if (match[2] !== undefined) {
      output.push(`${flag}=***`);
    } else {
      output.push(flag);
      redactNext = true;
    }
  }

  return output.join(' ');
}
