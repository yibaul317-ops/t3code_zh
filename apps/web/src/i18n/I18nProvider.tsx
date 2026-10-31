import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { createTranslator, type Translator } from "./translator";
import { ZH_CN_ENTRIES } from "./zhCN";

export type Locale = "en" | "zh-CN";

export interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => undefined,
});

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

const LOCALE_STORAGE_KEY = "t3.locale";
const LocaleSchema = Schema.Literals(["en", "zh-CN"]);

let cachedTranslator: Translator | null = null;

function zhTranslator(): Translator {
  cachedTranslator ??= createTranslator(ZH_CN_ENTRIES);
  return cachedTranslator;
}

const EXCLUDED_ANCESTOR_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "INPUT",
  "TEXTAREA",
  "CODE",
  "PRE",
]);

function isExcluded(element: Element | null): boolean {
  let current = element;
  while (current !== null) {
    if (EXCLUDED_ANCESTOR_TAGS.has(current.tagName)) return true;
    if (current instanceof HTMLElement && current.isContentEditable) return true;
    if (current.classList.contains("cm-editor")) return true;
    if (current.hasAttribute("data-term")) return true;
    current = current.parentElement;
  }
  return false;
}

interface TranslatedTextEntry {
  original: string;
  translated: string;
}

interface TranslatedAttributeEntry {
  original: string;
  translated: string;
}

const TRANSLATED_ATTRIBUTES = ["placeholder", "aria-label", "title"] as const;
type TranslatedAttribute = (typeof TRANSLATED_ATTRIBUTES)[number];

const PRUNE_THRESHOLD = 4_000;

// Synchronizes the rendered DOM with the selected locale. React keeps rendering English
// strings; when zh-CN is active every visible text node and a small set of attributes is
// replaced in place, with the original recorded so disabling the locale restores it.
function useRuntimeTranslation(active: boolean): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the rendered DOM with the selected locale outside React
  useEffect(() => {
    if (!active || typeof document === "undefined") return;

    const translator = zhTranslator();
    const translatedTexts = new Map<Text, TranslatedTextEntry>();
    const translatedAttributes = new Map<
      Element,
      Map<TranslatedAttribute, TranslatedAttributeEntry>
    >();
    const pendingTexts = new Set<Text>();
    const pendingAttributes = new Set<Element>();
    let scheduled = false;
    let disposed = false;

    const previousLang = document.documentElement.lang;
    document.documentElement.lang = "zh-CN";

    const collectElement = (element: Element) => {
      for (const attribute of TRANSLATED_ATTRIBUTES) {
        if (element.hasAttribute(attribute)) pendingAttributes.add(element);
      }
    };

    const collectAddedNode = (node: Node) => {
      if (node instanceof Text) {
        pendingTexts.add(node);
        return;
      }
      if (node instanceof Element) {
        collectElement(node);
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text !== null) {
          pendingTexts.add(text as Text);
          text = walker.nextNode();
        }
      }
    };

    const flush = () => {
      scheduled = false;
      if (disposed) return;

      for (const node of pendingTexts) {
        if (disposed) return;
        if (!node.isConnected) continue;
        const recorded = translatedTexts.get(node);
        if (recorded !== undefined && recorded.translated === node.data) continue;
        if (recorded === undefined && node.data.trim().length === 0) continue;
        if (isExcluded(node.parentElement)) continue;
        const source = node.data;
        const translated = translator.translate(source);
        if (translated === source) continue;
        translatedTexts.set(node, { original: source, translated });
        node.data = translated;
      }
      pendingTexts.clear();

      for (const element of pendingAttributes) {
        if (disposed) return;
        if (!element.isConnected || isExcluded(element)) continue;
        let attributeEntries = translatedAttributes.get(element);
        for (const attribute of TRANSLATED_ATTRIBUTES) {
          if (!element.hasAttribute(attribute)) continue;
          const source = element.getAttribute(attribute) ?? "";
          const recorded = attributeEntries?.get(attribute);
          if (recorded !== undefined && recorded.translated === source) continue;
          if (recorded === undefined && source.trim().length === 0) continue;
          const translated = translator.translate(source);
          if (translated === source) continue;
          if (attributeEntries === undefined) {
            attributeEntries = new Map();
            translatedAttributes.set(element, attributeEntries);
          }
          attributeEntries.set(attribute, { original: source, translated });
          element.setAttribute(attribute, translated);
        }
      }
      pendingAttributes.clear();

      if (translatedTexts.size > PRUNE_THRESHOLD) {
        for (const [node] of translatedTexts) {
          if (!node.isConnected) translatedTexts.delete(node);
        }
      }
    };

    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(flush);
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          if (record.target instanceof Text) pendingTexts.add(record.target);
        } else if (record.type === "attributes") {
          pendingAttributes.add(record.target as Element);
        } else {
          for (const added of record.addedNodes) collectAddedNode(added);
        }
      }
      schedule();
    });

    const root = document.body;
    const rootWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = rootWalker.nextNode();
    while (text !== null) {
      pendingTexts.add(text as Text);
      text = rootWalker.nextNode();
    }
    for (const element of root.querySelectorAll("[placeholder], [aria-label], [title]")) {
      pendingAttributes.add(element);
    }
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATED_ATTRIBUTES],
    });
    schedule();

    return () => {
      disposed = true;
      observer.disconnect();
      document.documentElement.lang = previousLang.trim().length === 0 ? "en" : previousLang;
      for (const [node, entry] of translatedTexts) {
        if (node.isConnected && node.data === entry.translated) node.data = entry.original;
      }
      translatedTexts.clear();
      for (const [element, attributeEntries] of translatedAttributes) {
        if (!element.isConnected) continue;
        for (const [attribute, entry] of attributeEntries) {
          if (element.getAttribute(attribute) === entry.translated) {
            element.setAttribute(attribute, entry.original);
          }
        }
      }
      translatedAttributes.clear();
      pendingTexts.clear();
      pendingAttributes.clear();
    };
  }, [active]);
}

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocale] = useLocalStorage(LOCALE_STORAGE_KEY, "en" as Locale, LocaleSchema);
  useRuntimeTranslation(locale === "zh-CN");

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale: (next: Locale) => setLocale(next) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
