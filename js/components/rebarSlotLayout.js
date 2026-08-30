/**
 * 共通鉄筋スロットから、両端を起点に内側へ交互に配置する順序を返す。
 * 例: 5スロットの場合は [0, 4, 1, 3, 2]。
 *
 * @param {number} slotCount
 * @returns {number[]}
 */
export function createOuterInSlotOrder(slotCount) {
  const count = Math.max(0, Number.parseInt(slotCount, 10) || 0);
  const order = [];
  let start = 0;
  let end = count - 1;

  while (start <= end) {
    order.push(start);
    if (start !== end) order.push(end);
    start += 1;
    end -= 1;
  }

  return order;
}

/**
 * 指定本数が使用するスロットindexを座標順で返す。
 * 最大5本では、5本=11111、4本=11011、3本=11001となる。
 *
 * @param {number} slotCount
 * @param {number} count
 * @returns {number[]}
 */
export function selectOuterInSlotIndices(slotCount, count) {
  const available = Math.max(0, Number.parseInt(slotCount, 10) || 0);
  const target = Math.max(0, Math.min(available, Number.parseInt(count, 10) || 0));
  return createOuterInSlotOrder(available)
    .slice(0, target)
    .sort((a, b) => a - b);
}

/**
 * 共通スロット座標から指定本数分を、共通の配置順で選択する。
 *
 * @template T
 * @param {T[]} values
 * @param {number} count
 * @returns {T[]}
 */
export function selectOuterInValues(values, count) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return selectOuterInSlotIndices(values.length, count).map((index) => values[index]);
}

/**
 * せん断補強筋の全脚配置から、外周フープで表現済みの両端を除いた内脚を返す。
 *
 * @param {number} slotCount
 * @param {number} fullLegCount 外周2脚を含む脚数
 * @returns {number[]}
 */
export function selectInnerLegSlotIndices(slotCount, fullLegCount) {
  const lastIndex = Math.max(0, Number.parseInt(slotCount, 10) - 1);
  return selectOuterInSlotIndices(slotCount, fullLegCount).filter(
    (index) => index !== 0 && index !== lastIndex,
  );
}
