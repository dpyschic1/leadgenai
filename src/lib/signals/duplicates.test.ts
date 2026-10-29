import { describe, expect, it } from "vitest";
import { findDuplicateSignal, normalizeSourceUrl } from "./duplicates";

describe("normalizeSourceUrl", () => {
  it.each([
    ["https://www.Example.com/news/post/?utm_source=linkedin&utm_medium=social#top", "example.com/news/post"],
    ["http://example.com/news/post", "example.com/news/post"],
    ["https://example.com/jobs?id=42&ref=abc", "example.com/jobs?id=42"],
    ["https://example.com/jobs?b=2&a=1", "example.com/jobs?a=1&b=2"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeSourceUrl(input)).toBe(expected);
  });

  it("returns null for empty or invalid input", () => {
    expect(normalizeSourceUrl("")).toBeNull();
    expect(normalizeSourceUrl("not a url")).toBeNull();
  });
});

describe("findDuplicateSignal", () => {
  const existing = [
    {
      id: "s1",
      signalType: "funding",
      sourceUrl: "https://www.example.com/medisync-news",
      excerpt: "Medisync Health raises $2.1M seed round.",
    },
  ];

  it("flags the same type from the same link, despite tracking params", () => {
    const candidate = { signalType: "funding", sourceUrl: "https://example.com/medisync-news?utm_source=x", excerpt: null };
    expect(findDuplicateSignal(existing, candidate)?.id).toBe("s1");
  });

  it("flags the same type with the same quote and no link", () => {
    const candidate = { signalType: "funding", sourceUrl: null, excerpt: "  medisync health raises $2.1M   seed round. " };
    expect(findDuplicateSignal(existing, candidate)?.id).toBe("s1");
  });

  it("allows a different type from the same source", () => {
    const candidate = { signalType: "hiring_surge", sourceUrl: "https://example.com/medisync-news", excerpt: null };
    expect(findDuplicateSignal(existing, candidate)).toBeNull();
  });

  it("ignores the signal being edited", () => {
    const candidate = { signalType: "funding", sourceUrl: "https://example.com/medisync-news", excerpt: null };
    expect(findDuplicateSignal(existing, candidate, "s1")).toBeNull();
  });

  it("never flags a signal without a source", () => {
    expect(findDuplicateSignal(existing, { signalType: "funding", sourceUrl: null, excerpt: null })).toBeNull();
  });
});
