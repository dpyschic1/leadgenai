import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csvCell", () => {
  it("leaves plain values alone", () => {
    expect(csvCell("Acme Ltd")).toBe("Acme Ltd");
    expect(csvCell(87)).toBe("87");
  });

  it("writes empty cells for missing values", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("Smith, John")).toBe('"Smith, John"');
    expect(csvCell('They said "soon"')).toBe('"They said ""soon"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("neutralises text that a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
  });

  it("keeps phone numbers and plain numbers readable", () => {
    expect(csvCell("+44 20 7946 0000")).toBe("+44 20 7946 0000");
    expect(csvCell("+1 (415) 555-0100")).toBe("+1 (415) 555-0100");
    expect(csvCell(-1)).toBe("-1");
  });
});

describe("toCsv", () => {
  it("writes a BOM, a header row and CRLF-separated rows in column order", () => {
    const csv = toCsv(["name", "score"] as const, [
      { name: "Medisync", score: 92 },
      { name: "Northbridge, Inc", score: null },
    ]);
    expect(csv).toBe('﻿name,score\r\nMedisync,92\r\n"Northbridge, Inc",\r\n');
  });
});
