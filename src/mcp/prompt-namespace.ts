const DELIMITER = '::';
const ESCAPE = '\\';

function encodeComponent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

function decodeComponent(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === ESCAPE && index + 1 < value.length) {
      result += value[index + 1];
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

export function encodePromptName(serverName: string, promptName: string): string {
  return `${encodeComponent(serverName)}${DELIMITER}${encodeComponent(promptName)}`;
}

export function decodePromptName(value: string): { serverName: string; promptName: string } | null {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ESCAPE) {
      index += 1;
      continue;
    }
    if (char === ':' && value[index + 1] === ':') {
      const serverName = decodeComponent(value.slice(0, index));
      const promptName = decodeComponent(value.slice(index + DELIMITER.length));
      if (serverName.length === 0 || promptName.length === 0) return null;
      return { serverName, promptName };
    }
  }
  return null;
}
