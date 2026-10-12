// Clips a string to max UTF-16 units without splitting a surrogate pair, and drops NUL
// characters (Postgres text and jsonb can't store them).
export function clipText(s: string, max: number): string {
  let out = s.includes('\u0000') ? s.split('\u0000').join('') : s;
  if (out.length > max) {
    out = out.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
}
