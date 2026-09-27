/**
 * @fileoverview 梁立面図の柱部材オフセット補正
 *
 * 基本の梁立面図抽出結果に対して、StbColumn / StbPost の
 * offset_top_X/Y・offset_bottom_X/Y を梁軸方向へ投影し、実際の柱芯位置から
 * 柱面・内法スパン L0・主筋カットオフ・貫通孔配置可能範囲を再算定する。
 *
 * 通り芯・柱芯間寸法は StbNode を基準としたまま保持し、描画用には
 * support.columnCenterMm を追加する。これにより「通り芯」と「オフセット後の柱芯」を
 * 区別できる。
 *
 * @module data/extractors/beamElevation/beamElevationColumnOffset
 */

import { extractBeamElevationData as extractBaseBeamElevationData } from './beamElevationData.js';
import { createTagScanner, findElementById, getNodeCoord } from '../columnSupportUtils.js';
import { REBAR_CUTOFF_RULES } from '../../../constants/rebarCutoffRules.js';

/**
 * 支点列の平面方向を求める。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Array<Object>} supports - 支点列
 * @returns {{x:number,y:number}} 梁軸方向単位ベクトル
 */
function resolveBeamDirection(scanTag, supports) {
  if (supports.length >= 2) {
    const first = getNodeCoord(scanTag, supports[0].nodeId);
    const last = getNodeCoord(scanTag, supports[supports.length - 1].nodeId);
    if (first && last) {
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) return { x: dx / length, y: dy / length };
    }
  }
  return { x: 1, y: 0 };
}

/**
 * 支点で採用された柱の端部オフセットを梁軸方向へ投影する。
 * 柱頭で接続する柱なら offset_top_*、柱脚なら offset_bottom_* を使う。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Object} support - 支点データ
 * @param {{x:number,y:number}} beamDir - 梁軸方向単位ベクトル
 * @returns {number} 梁軸方向の柱芯オフセット [mm]
 */
function resolveColumnOffsetAlongBeam(scanTag, support, beamDir) {
  const columnId = support.column?.id;
  if (!columnId) return 0;

  const columnEl =
    findElementById(scanTag, 'StbColumn', columnId) ||
    findElementById(scanTag, 'StbPost', columnId);
  if (!columnEl) return 0;

  let prefix = null;
  if (columnEl.getAttribute('id_node_top') === support.nodeId) {
    prefix = 'offset_top';
  } else if (columnEl.getAttribute('id_node_bottom') === support.nodeId) {
    prefix = 'offset_bottom';
  }
  if (!prefix) return 0;

  const offsetX = parseFloat(columnEl.getAttribute(`${prefix}_X`)) || 0;
  const offsetY = parseFloat(columnEl.getAttribute(`${prefix}_Y`)) || 0;
  return offsetX * beamDir.x + offsetY * beamDir.y;
}

/**
 * 柱オフセットを反映してスパンの柱面・L0・カットオフ・貫通孔範囲を再算定する。
 * @param {Object} data - 基本抽出結果
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Object} 補正後の抽出結果
 */
function applyColumnOffsets(data, xmlDoc) {
  if (data.error || !Array.isArray(data.supports) || data.supports.length === 0) return data;

  const scanTag = createTagScanner(xmlDoc);
  const beamDir = resolveBeamDirection(scanTag, data.supports);

  for (const support of data.supports) {
    const columnOffsetAlongBeam = resolveColumnOffsetAlongBeam(scanTag, support, beamDir);
    support.columnOffsetAlongBeam = columnOffsetAlongBeam;
    support.columnCenterMm = support.positionMm + columnOffsetAlongBeam;
  }

  for (const span of data.spans || []) {
    const startSupport = data.supports[span.startSupportIndex];
    const endSupport = data.supports[span.endSupportIndex];
    if (!startSupport || !endSupport) continue;

    const faceStartMm = startSupport.columnCenterMm + startSupport.depthAlongBeam / 2;
    const faceEndMm = endSupport.columnCenterMm - endSupport.depthAlongBeam / 2;
    const clearSpan = faceEndMm - faceStartMm;

    span.faceStartMm = faceStartMm;
    span.faceEndMm = faceEndMm;
    span.clearSpan = clearSpan;

    if (span.cutoff) {
      const quarterSpan = Math.max(0, clearSpan) * REBAR_CUTOFF_RULES.cutoffSpanRatio;
      span.cutoff.quarterSpan = quarterSpan;
      span.cutoff.topCutoffFromFace =
        quarterSpan + REBAR_CUTOFF_RULES.cutoffExtensionDiaFactor * span.cutoff.topBarDia;
      span.cutoff.bottomCutoffFromFace =
        quarterSpan + REBAR_CUTOFF_RULES.cutoffExtensionDiaFactor * span.cutoff.bottomBarDia;
    }

    if (span.opening) {
      const zoneStart = faceStartMm + span.opening.endClearance;
      const zoneEnd = faceEndMm - span.opening.endClearance;
      span.opening.zoneStart = zoneStart;
      span.opening.zoneEnd = zoneEnd;
      span.opening.zoneLength = Math.max(0, zoneEnd - zoneStart);
      span.opening.valid = zoneEnd > zoneStart;
    }

    if (clearSpan <= 0) {
      data.warnings ??= [];
      const message = `${span.name || span.girderId} は柱部材オフセット反映後の内法スパンが0以下です`;
      if (!data.warnings.includes(message)) data.warnings.push(message);
    } else if (span.opening && !span.opening.valid) {
      data.warnings ??= [];
      const message = `${span.name || span.girderId} は柱部材オフセット反映後、貫通孔の配置可能範囲がありません`;
      if (!data.warnings.includes(message)) data.warnings.push(message);
    }
  }

  if (typeof data.disclaimer === 'string' && !data.disclaimer.includes('柱部材オフセット')) {
    data.disclaimer = data.disclaimer.replace(
      '柱せいは通り芯平行配置を',
      '柱部材オフセット（offset_top/bottom_X/Y）は梁軸方向へ投影して考慮します。柱せいは通り芯平行配置を',
    );
  }

  return data;
}

/**
 * 柱部材オフセットを考慮した梁立面図データを抽出する。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {string} elementType - 'Girder' または 'Beam'
 * @param {string} elementId - 要素ID
 * @param {Object} [options] - 抽出オプション
 * @returns {Object} 梁立面図データ
 */
export function extractBeamElevationData(xmlDoc, elementType, elementId, options = {}) {
  const data = extractBaseBeamElevationData(xmlDoc, elementType, elementId, options);
  return applyColumnOffsets(data, xmlDoc);
}
