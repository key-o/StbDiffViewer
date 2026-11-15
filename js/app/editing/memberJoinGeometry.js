/** @fileoverview RC取り合いオフセット計画のための共通STB/幾何ヘルパー。 */

export const TOLERANCE_MM = 0.01;

export function tag(node) {
  return node?.localName || node?.nodeName?.split(':').pop() || '';
}

export function descendants(root, name) {
  return Array.from(
    root?.getElementsByTagNameNS?.('*', name) || root?.getElementsByTagName?.(name) || [],
  );
}

export function child(root, name) {
  return Array.from(root?.children || []).find((node) => tag(node) === name) || null;
}

export function findById(document, tagName, id) {
  return (
    descendants(document, tagName).find((item) => item.getAttribute('id') === String(id)) || null
  );
}

export function numberAttribute(element, key, fallback = null) {
  const raw = element?.getAttribute(key);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function positive(value) {
  return Number.isFinite(value) && value > 0;
}

export function near(a, b) {
  return Math.abs(a - b) <= TOLERANCE_MM;
}
