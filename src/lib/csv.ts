/** RFC 4180 CSV writing, safe to open in spreadsheet apps. */

export type CsvValue = string | number | null | undefined;

/** Characters that make Excel/Sheets treat a cell as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** Phone numbers and plain numbers like "+44 20 7946 0000" can't call functions, so stay readable. */
const NUMERIC_TEXT = /^[+-][\d\s().-]*$/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  // Text that looks like a formula is prefixed so it's shown, never executed.
  const text = FORMULA_START.test(value) && !NUMERIC_TEXT.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Builds a CSV document with a header row. Starts with a byte-order mark so Excel reads it
 * as UTF-8, and uses CRLF line endings as RFC 4180 specifies.
 */
export function toCsv<K extends string>(columns: readonly K[], rows: readonly Record<K, CsvValue>[]): string {
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}
