/**
 * @fileoverview 差分サマリーのクリック→フィルタ適用用 data 属性生成ユーティリティ
 *
 * グラフ・表のセルに付与する data-filter-* 属性文字列を生成し、
 * クリック時に差分フィルタの絞り込みを可能にします。
 */

/**
 * クリックでフィルタ適用可能にする data 属性を生成する
 * @param {Array<string>} statuses - 適用する差分ステータス群
 * @param {string} [elementType] - 要素タイプ絞り込み（省略時は全タイプ）
 * @returns {string} HTML属性文字列
 */
function filterClickAttrs(statuses, elementType, criteria = null) {
  let attrs = ` data-filter-statuses="${statuses.join(' ')}"`;
  if (elementType) {
    attrs += ` data-filter-type="${elementType}"`;
  }
  if (criteria?.positionStates) {
    attrs += ` data-filter-position-states="${criteria.positionStates.join(' ')}"`;
  }
  if (criteria?.instanceStates) {
    attrs += ` data-filter-instance-states="${criteria.instanceStates.join(' ')}"`;
  }
  if (criteria?.sectionStates) {
    attrs += ` data-filter-section-states="${criteria.sectionStates.join(' ')}"`;
  }
  return attrs;
}

export { filterClickAttrs };
