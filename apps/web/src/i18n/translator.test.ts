import { describe, expect, it } from "vite-plus/test";

import { ZH_CN_ENTRIES } from "./zhCN";
import { compileDictionary, createTranslator } from "./translator";

describe("createTranslator", () => {
  const translator = createTranslator(ZH_CN_ENTRIES);

  it("translates exact matches, ignoring surrounding whitespace", () => {
    expect(translator.translate("New thread")).toBe("新会话");
    expect(translator.translate("  New thread  ")).toBe("新会话");
    expect(translator.translate("\nNew thread\n")).toBe("新会话");
  });

  it("matches after collapsing internal whitespace", () => {
    expect(translator.translate("New   thread")).toBe("新会话");
    expect(translator.translate("New\tthread")).toBe("新会话");
    expect(translator.translate("New\n  thread")).toBe("新会话");
  });

  it("returns untranslated content unchanged", () => {
    expect(translator.translate("Some agent prose that is not in the dictionary")).toBe(
      "Some agent prose that is not in the dictionary",
    );
    expect(translator.translate("kimi-code")).toBe("kimi-code");
  });

  it("translates wildcard entries and substitutes capture groups", () => {
    expect(translator.translate("Open in VS Code")).toBe("在 VS Code 中打开");
    expect(translator.translate("Open in Finder")).toBe("在 Finder 中打开");
    expect(translator.translate("3 of 5 local agent presets detected.")).toBe(
      "检测到 3 / 5 个本地代理预设。",
    );
  });

  it("prefers exact entries over wildcard entries", () => {
    expect(translator.translate("Open in editor")).toBe("在编辑器中打开");
  });

  it("returns whitespace-only and empty strings unchanged", () => {
    expect(translator.translate("")).toBe("");
    expect(translator.translate("   ")).toBe("   ");
    expect(translator.translate("\n\t")).toBe("\n\t");
  });

  it("leaves unmatched placeholders untouched when a capture group is missing", () => {
    const custom = createTranslator([["Only * here {2}", "只有 {1} 这里 {2}"]]);
    expect(custom.translate("Only one here {2}")).toBe("只有 one 这里 {2}");
  });

  it("skips long texts that cannot match any dictionary entry", () => {
    const longProse = "word ".repeat(120).trim();
    expect(longProse.length).toBeGreaterThan(500);
    expect(translator.translate(longProse)).toBe(longProse);

    const longMatchable = `Open in ${"A".repeat(600)}`;
    expect(translator.translate(longMatchable)).toBe(`在 ${"A".repeat(600)} 中打开`);
  });

  it("does not treat dictionary keys as prefixes of longer texts", () => {
    expect(translator.translate("New threaded approach")).toBe("New threaded approach");
    expect(translator.translate("Settings page")).not.toBe("设置");
  });
});

describe("ZH_CN_ENTRIES self-check", () => {
  it("has at least 300 entries", () => {
    expect(ZH_CN_ENTRIES.length).toBeGreaterThanOrEqual(300);
  });

  it("keeps exact and wildcard entries in separate tables", () => {
    const dictionary = compileDictionary(ZH_CN_ENTRIES);
    for (const [source] of ZH_CN_ENTRIES) {
      if (source.includes("*")) {
        expect(dictionary.wildcards.length).toBeGreaterThan(0);
      } else {
        expect(dictionary.exact.has(source.trim())).toBe(true);
      }
    }
    expect(dictionary.exact.size + dictionary.wildcards.length).toBe(ZH_CN_ENTRIES.length);
  });

  it("has a reasonable number of wildcard entries with usable static prefixes", () => {
    const wildcardSources = ZH_CN_ENTRIES.filter(([source]) => source.includes("*")).map(
      ([source]) => source,
    );
    expect(wildcardSources.length).toBeGreaterThanOrEqual(3);
    expect(wildcardSources.length).toBeLessThan(30);
    // A lone "*" would match every non-empty text. Capture-first patterns ("* of * ...")
    // are allowed but must stay the minority so long-text hits remain cheap to rule out.
    const emptyPrefixCount = wildcardSources.filter((source) => source.indexOf("*") === 0).length;
    expect(emptyPrefixCount).toBeLessThan(wildcardSources.length - emptyPrefixCount);
    for (const source of wildcardSources) {
      expect(source.trim().length).toBeGreaterThan(1);
    }
  });

  it("has no duplicate source keys, even after whitespace normalization", () => {
    const seen = new Set<string>();
    for (const [source] of ZH_CN_ENTRIES) {
      const normalized = source.trim().replace(/\s+/g, " ");
      expect(seen.has(normalized)).toBe(false);
      seen.add(normalized);
    }
  });

  it("has no empty targets", () => {
    for (const [source, target] of ZH_CN_ENTRIES) {
      expect(source.trim().length).toBeGreaterThan(0);
      expect(target.trim().length).toBeGreaterThan(0);
    }
  });
});
