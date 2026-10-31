export interface TranslationDictionaryEntry {
  readonly source: string;
  readonly target: string;
}

export interface Translator {
  readonly translate: (text: string) => string;
}

const MAX_TRANSLATABLE_LENGTH = 500;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

interface WildcardPattern {
  readonly regex: RegExp;
  readonly target: string;
}

export interface CompiledDictionary {
  readonly exact: ReadonlyMap<string, string>;
  readonly normalized: ReadonlyMap<string, string>;
  readonly wildcards: readonly WildcardPattern[];
  readonly longTextPrefixes: readonly string[];
  readonly hasEmptyPrefixWildcard: boolean;
}

export function compileDictionary(
  entries: ReadonlyArray<readonly [string, string]>,
): CompiledDictionary {
  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();
  const wildcards: WildcardPattern[] = [];
  const longTextPrefixes: string[] = [];
  let hasEmptyPrefixWildcard = false;

  for (const [source, target] of entries) {
    if (source.includes("*")) {
      const staticPrefix = source.slice(0, source.indexOf("*"));
      if (staticPrefix.length === 0) {
        hasEmptyPrefixWildcard = true;
      } else {
        longTextPrefixes.push(staticPrefix);
      }
      const regexSource = "^" + source.split("*").map(escapeRegExp).join("(.+)") + "$";
      wildcards.push({ regex: new RegExp(regexSource), target });
    } else {
      exact.set(source.trim(), target);
      const normalizedKey = collapseWhitespace(source.trim());
      if (!normalized.has(normalizedKey)) {
        normalized.set(normalizedKey, target);
      }
    }
  }

  return { exact, normalized, wildcards, longTextPrefixes, hasEmptyPrefixWildcard };
}

export function createTranslator(entries: ReadonlyArray<readonly [string, string]>): Translator {
  const dictionary = compileDictionary(entries);

  function couldMatchLongText(text: string): boolean {
    if (dictionary.hasEmptyPrefixWildcard) return true;
    for (const prefix of dictionary.longTextPrefixes) {
      if (text.includes(prefix)) return true;
    }
    return false;
  }

  function applyWildcards(text: string): string | null {
    for (const pattern of dictionary.wildcards) {
      const match = pattern.regex.exec(text);
      if (match === null) continue;
      return pattern.target.replace(/\{([1-9])\}/g, (placeholder, digit: string) => {
        const group = match[Number(digit)];
        return group === undefined ? placeholder : group;
      });
    }
    return null;
  }

  return {
    translate(text: string): string {
      const trimmed = text.trim();
      if (trimmed.length === 0) return text;

      if (trimmed.length > MAX_TRANSLATABLE_LENGTH && !couldMatchLongText(trimmed)) {
        return text;
      }

      const exactHit = dictionary.exact.get(trimmed);
      if (exactHit !== undefined) return exactHit;

      const normalizedHit = dictionary.normalized.get(collapseWhitespace(trimmed));
      if (normalizedHit !== undefined) return normalizedHit;

      const wildcardHit = applyWildcards(trimmed);
      if (wildcardHit !== null) return wildcardHit;

      return text;
    },
  };
}
