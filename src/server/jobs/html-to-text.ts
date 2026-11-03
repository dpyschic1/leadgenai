/**
 * Turns a job description's HTML into readable plain text for the AI: block elements become line
 * breaks, list items get a bullet, tags are dropped and entities decoded. Not a sanitiser; the
 * result is only ever sent to the model and stored as text, never rendered as HTML.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|h[1-6]|ul|ol|tr|section|article|header|footer|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    // One line per block: compact text keeps more of a long description within the AI's limit.
    .replace(/\n{2,}/g, "\n")
    .trim();
}
