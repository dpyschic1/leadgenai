/** "free plan" -> "Free plan". */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Leeds, United Kingdom" from optional parts; null when every part is empty. */
export function formatPlace(parts: (string | null | undefined)[]): string | null {
  const text = parts.filter(Boolean).join(", ");
  return text || null;
}

/** 1250 -> "1,250 employees". */
export function formatEmployees(count: number | null): string | null {
  return count === null ? null : `${count.toLocaleString()} ${count === 1 ? "employee" : "employees"}`;
}

/** Up to two initials from a name, e.g. "Hartley & Co" -> "HC". */
export function initials(name: string): string {
  return name
    .split(/[\s@.&-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
