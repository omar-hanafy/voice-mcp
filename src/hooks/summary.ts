const DEFAULT_MAX_SPOKEN_CHARS = 300;

const STRUCTURAL_LABELS = new Set([
  'completed',
  'completion',
  'details',
  'done',
  'outcome',
  'result',
  'results',
  'status',
  'summary',
  'verification',
  'what changed',
]);

function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'a redacted credential')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, 'a redacted credential')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{12,}\b/gi, 'a redacted credential')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      'a redacted credential'
    );
}

function pathLeaf(value: string): string {
  // Sentence punctuation right after a path belongs to the sentence, not the path; keep it so
  // sentence boundaries survive ("in /a/b/file.ts. Next" -> "in file.ts. Next").
  const trailing = /[.,;:!?]+$/.exec(value)?.[0] ?? '';
  const clean = value.slice(0, value.length - trailing.length);
  const leaf = clean.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return `${leaf && /[A-Za-z0-9]/.test(leaf) ? leaf : 'the project files'}${trailing}`;
}

/**
 * Speak only the last segment of long paths. Handles POSIX paths, Windows drive paths with
 * either separator (C:\a\b, C:/a/b), and UNC paths (\\server\share\file).
 */
function shortenAbsolutePaths(text: string): string {
  return text
    .replace(/(?:\\\\|\b[A-Za-z]:\\)(?:[^\\\s`"'<>()[\]{}|]+\\)+[^\\\s`"'<>()[\]{}|]*/g, pathLeaf)
    .replace(/(?:\b[A-Za-z]:)?(?:\/(?:[^/\s`"'<>()[\]{}]+)){2,}/g, pathLeaf);
}

function stripMarkdown(raw: string): string {
  const withoutBlocks = raw
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/::(?:code-comment|created-thread)\{[^\n}]*\}/g, ' ')
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/<[^>]+>/g, ' ');

  const lines = withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      const pipeCount = (line.match(/\|/g) ?? []).length;
      return pipeCount < 2 && !/^[-:|\s]+$/.test(line);
    })
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/[\*_~]+/g, '')
        .trim()
    )
    .filter((line) => {
      const label = line.replace(/:$/, '').trim().toLowerCase();
      return !STRUCTURAL_LABELS.has(label);
    });

  return lines.join(' ');
}

export function cleanForSpeech(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return '';
  }

  return shortenAbsolutePaths(redactSecrets(stripMarkdown(raw)))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function isGenericSentence(sentence: string): boolean {
  const normalized = sentence
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim();
  return new Set([
    'complete',
    'completed',
    'done',
    'finished',
    'success',
    'successful',
    'yes',
  ]).has(normalized);
}

function firstUsefulSentences(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return text;
  }

  const selected: string[] = [];
  for (const sentence of sentences) {
    selected.push(sentence);
    const combined = selected.join(' ');
    if (
      selected.length >= 2 ||
      sentence.endsWith('?') ||
      (combined.length >= 90 && !isGenericSentence(sentence))
    ) {
      break;
    }
  }

  if (selected.length === 1 && isGenericSentence(selected[0] ?? '') && sentences[1]) {
    selected.push(sentences[1]);
  }

  return selected.join(' ');
}

export function truncateForSpeech(text: string, maxChars = DEFAULT_MAX_SPOKEN_CHARS): string {
  const limit = Number.isFinite(maxChars) ? Math.max(40, Math.floor(maxChars)) : DEFAULT_MAX_SPOKEN_CHARS;
  if (text.length <= limit) {
    return text;
  }

  const slice = text.slice(0, limit - 1).trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  const boundary = lastSpace >= Math.floor(limit * 0.65) ? lastSpace : slice.length;
  return `${slice.slice(0, boundary).replace(/[,:;.-]+$/, '')}…`;
}

export function summarizeForSpeech(
  raw: string | null | undefined,
  fallback: string,
  maxChars = DEFAULT_MAX_SPOKEN_CHARS
): string {
  const cleaned = cleanForSpeech(raw ?? '');
  const source =
    cleaned ||
    cleanForSpeech(fallback) ||
    'The agent finished responding. Open the session for details.';
  return truncateForSpeech(firstUsefulSentences(source), maxChars);
}

export const SPOKEN_SUMMARY_MAX_CHARS = DEFAULT_MAX_SPOKEN_CHARS;
