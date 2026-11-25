/**
 * Minimal JSONC support: // and /* *\/ comments plus trailing commas. Comments are replaced
 * with whitespace that keeps line breaks, so JSON.parse error positions still point at the
 * right line of the original file.
 */
function stripComments(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      if (i < input.length) out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n') out += '\n';
        i += 1;
      }
      i += 1;
      continue;
    }

    out += char;
  }
  return out;
}

function stripTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j += 1;
      if (input[j] === '}' || input[j] === ']') continue;
    }
    out += char;
  }
  return out;
}

/** JSONC to plain JSON text with the same line structure. */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, '')));
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
