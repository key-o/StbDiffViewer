/**
 * RC断面描画で共有する低レベルの鉄筋幾何ユーティリティ。
 *
 * 柱・梁固有の配筋規則はここへ持ち込まず、径の数値化と
 * 1次元の等間隔座標生成だけを単一実装として提供する。
 */

/**
 * 文字列中の最初の数値を径(mm)として取得する。
 * 柱断面の既存契約（接頭辞を要求しない）向け。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parseNumericRebarDiameterMm(value, fallback = 0) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/);
  if (!match) return fallback;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * D/T接頭辞付き鉄筋径をmmとして取得する。
 * 梁断面の既存契約を維持し、接頭辞が無い値はfallbackへ戻す。
 * 小数表記は従来どおり接頭辞直後の整数部だけを採用する。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parseDtRebarDiameterMm(value, fallback = 25) {
  const match = String(value || '')
    .toUpperCase()
    .match(/[DT](\d+)/);
  if (!match) return fallback;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * start/end間へcount個の座標を等間隔配置する。
 * 0個は空、1個または逆転区間は中央1点を返す。
 *
 * @param {number} start
 * @param {number} end
 * @param {number} count
 * @returns {number[]}
 */
export function createEvenlySpacedValues(start, end, count) {
  const safeCount = Math.max(0, Number.parseInt(count, 10) || 0);
  if (safeCount === 0) return [];
  if (safeCount === 1 || !(end > start)) return [(start + end) / 2];
  const spacing = (end - start) / (safeCount - 1);
  return Array.from({ length: safeCount }, (_, index) => start + spacing * index);
}
