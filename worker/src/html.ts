/**
 * The one HTML escaper the Worker renders with: every page, chapter,
 * diagram and markdown line goes through it, so a text from the index or a
 * request never becomes markup. The page scripts have their own esc() in
 * the shell (layout.ts HELPERS) for the same four characters, client side.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
