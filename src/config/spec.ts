/**
 * A tiny declarative spec for lenient config parsing.
 *
 * Settings are hand-edited, so a typo must never take the runtime down. Every spec parses
 * unknown input into a valid value: wrong types fall back to the field default, numbers are
 * clamped into range, and unknown keys are ignored. The same definition produces the JSON
 * Schema that editors use for completion and validation, so defaults, ranges, and docs cannot
 * drift apart.
 */

import { isPlainObject } from '../util/errors.js';

export type JsonSchema = Record<string, unknown>;

export interface Spec<T> {
  readonly defaultValue: T;
  parse(value: unknown): T;
  jsonSchema(): JsonSchema;
}

export type Infer<S> = S extends Spec<infer T> ? T : never;

function withDescription(schema: JsonSchema, description?: string): JsonSchema {
  return description ? { ...schema, description } : schema;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function boolean(defaultValue: boolean, description?: string): Spec<boolean> {
  return {
    defaultValue,
    parse: (value) => (typeof value === 'boolean' ? value : defaultValue),
    jsonSchema: () => withDescription({ type: 'boolean', default: defaultValue }, description),
  };
}

interface Range {
  min: number;
  max: number;
}

export function integer(defaultValue: number, range: Range, description?: string): Spec<number> {
  return {
    defaultValue,
    parse: (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(clamp(value, range.min, range.max))
        : defaultValue,
    jsonSchema: () =>
      withDescription(
        { type: 'integer', minimum: range.min, maximum: range.max, default: defaultValue },
        description
      ),
  };
}

export function number(defaultValue: number, range: Range, description?: string): Spec<number> {
  return {
    defaultValue,
    parse: (value) =>
      typeof value === 'number' && Number.isFinite(value) ? clamp(value, range.min, range.max) : defaultValue,
    jsonSchema: () =>
      withDescription(
        { type: 'number', minimum: range.min, maximum: range.max, default: defaultValue },
        description
      ),
  };
}

export function nullableInteger(
  defaultValue: number | null,
  range: Range,
  description?: string
): Spec<number | null> {
  return {
    defaultValue,
    parse: (value) => {
      if (value === null) return null;
      return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(clamp(value, range.min, range.max))
        : defaultValue;
    },
    jsonSchema: () =>
      withDescription(
        { type: ['integer', 'null'], minimum: range.min, maximum: range.max, default: defaultValue },
        description
      ),
  };
}

/** A non-empty trimmed string. Empty or non-string input falls back to the default. */
export function string(defaultValue: string, description?: string): Spec<string> {
  return {
    defaultValue,
    parse: (value) => {
      if (typeof value !== 'string') return defaultValue;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : defaultValue;
    },
    jsonSchema: () => withDescription({ type: 'string', default: defaultValue }, description),
  };
}

/** A trimmed string where empty is a meaningful value (for example "disabled"). */
export function optionalString(defaultValue: string, description?: string): Spec<string> {
  return {
    defaultValue,
    parse: (value) => (typeof value === 'string' ? value.trim() : defaultValue),
    jsonSchema: () => withDescription({ type: 'string', default: defaultValue }, description),
  };
}

/** A trimmed string or null. Empty strings mean null. */
export function nullableString(defaultValue: string | null, description?: string): Spec<string | null> {
  return {
    defaultValue,
    parse: (value) => {
      if (value === null) return null;
      if (typeof value !== 'string') return defaultValue;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    jsonSchema: () => withDescription({ type: ['string', 'null'], default: defaultValue }, description),
  };
}

export function stringList(defaultValue: string[], description?: string): Spec<string[]> {
  return {
    defaultValue,
    parse: (value) => {
      if (!Array.isArray(value)) return [...defaultValue];
      return value.filter((entry): entry is string => typeof entry === 'string');
    },
    jsonSchema: () =>
      withDescription({ type: 'array', items: { type: 'string' }, default: defaultValue }, description),
  };
}

function normalizeChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  aliases: Readonly<Record<string, T>>
): T | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if ((choices as readonly string[]).includes(key)) return key as T;
  return aliases[key];
}

export function oneOf<T extends string>(
  choices: readonly T[],
  defaultValue: T,
  options: { aliases?: Readonly<Record<string, T>>; description?: string } = {}
): Spec<T> {
  const aliases = options.aliases ?? {};
  return {
    defaultValue,
    parse: (value) => normalizeChoice(value, choices, aliases) ?? defaultValue,
    jsonSchema: () =>
      withDescription(
        { type: 'string', enum: [...choices, ...Object.keys(aliases)], default: defaultValue },
        options.description
      ),
  };
}

export function nullableOneOf<T extends string>(
  choices: readonly T[],
  defaultValue: T | null,
  options: { aliases?: Readonly<Record<string, T>>; description?: string } = {}
): Spec<T | null> {
  const aliases = options.aliases ?? {};
  return {
    defaultValue,
    parse: (value) => (value === null ? null : (normalizeChoice(value, choices, aliases) ?? defaultValue)),
    jsonSchema: () =>
      withDescription(
        { enum: [...choices, ...Object.keys(aliases), null], default: defaultValue },
        options.description
      ),
  };
}

/** A de-duplicated, non-empty list of choices. Unknown entries are dropped. */
export function choiceList<T extends string>(
  choices: readonly T[],
  defaultValue: T[],
  options: { aliases?: Readonly<Record<string, T>>; description?: string } = {}
): Spec<T[]> {
  const aliases = options.aliases ?? {};
  return {
    defaultValue,
    parse: (value) => {
      if (!Array.isArray(value)) return [...defaultValue];
      const out: T[] = [];
      for (const entry of value) {
        const choice = normalizeChoice(entry, choices, aliases);
        if (choice && !out.includes(choice)) out.push(choice);
      }
      return out.length > 0 ? out : [...defaultValue];
    },
    jsonSchema: () =>
      withDescription(
        {
          type: 'array',
          items: { type: 'string', enum: [...choices, ...Object.keys(aliases)] },
          uniqueItems: true,
          minItems: 1,
          default: defaultValue,
        },
        options.description
      ),
  };
}

type Fields = Record<string, Spec<unknown>>;
type ObjectOf<F extends Fields> = { [K in keyof F]: Infer<F[K]> };

export function object<F extends Fields>(fields: F, description?: string): Spec<ObjectOf<F>> {
  const parse = (value: unknown): ObjectOf<F> => {
    const input = isPlainObject(value) ? value : {};
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(fields)) {
      out[key] = spec.parse(input[key]);
    }
    return out as ObjectOf<F>;
  };
  return {
    get defaultValue() {
      return parse({});
    },
    parse,
    jsonSchema: () => {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, spec] of Object.entries(fields)) properties[key] = spec.jsonSchema();
      return withDescription({ type: 'object', properties, additionalProperties: true }, description);
    },
  };
}

/** An object that may be explicitly disabled with null. */
export function nullableObject<T>(inner: Spec<T>, description?: string): Spec<T | null> {
  return {
    get defaultValue() {
      return inner.defaultValue;
    },
    parse: (value) => (value === null ? null : inner.parse(value)),
    jsonSchema: () => withDescription({ anyOf: [inner.jsonSchema(), { type: 'null' }] }, description),
  };
}
