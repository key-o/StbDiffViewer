/**
 * @fileoverview RC配筋情報抽出ヘルパー
 *
 * RC断面の配筋情報（主筋・帯筋/あばら筋・かぶり、スラブ配筋、壁配筋）を
 * 抽出します。MatrixCalc の
 * `common/stb/parser/section-extraction/concrete-extractor.js` から
 * 統一計画フェーズ2で移植した追加APIです。
 * 既存の断面抽出パイプライン（extractAllSections）へは配線せず、
 * 必要な呼び出し側が明示的に使用します。
 *
 * @module common-stb/import/extractor/barArrangementExtractors
 */

import { getElementChildren } from './utils/domTraversal.js';

// STB 名前空間（querySelector がヒットしない場合にフォールバック）
const STB_NS = 'https://www.building-smart.or.jp/dl';

/**
 * RC配筋情報を抽出
 * StbSecBarArrangementColumn_RC, StbSecBarArrangementBeam_RC などから
 * かぶり、主筋、帯筋/あばら筋の情報を抽出
 *
 * @param {Element} element - 断面要素 (StbSecColumn_RC, StbSecBeam_RC等)
 * @param {Object} config - 抽出設定 (barArrangements, barElements)
 * @returns {Object|null} 配筋情報
 *   {
 *     cover: { startX, endX, startY, endY },
 *     mainBars: { diameter, grade, count: { x1st, y1st, top1st, top2nd, bottom1st, bottom2nd, total } },
 *     hoops: { diameter, grade, pitch, legs: { x, y, count } }
 *   }
 */
export function extractBarArrangement(element, config) {
  if (!config.barArrangements || config.barArrangements.length === 0) return null;

  let barArrangementEl = null;

  // barArrangement要素を検索
  for (const sel of config.barArrangements) {
    try {
      barArrangementEl = element.querySelector(sel);
    } catch (_) {
      barArrangementEl = null;
    }
    if (!barArrangementEl && typeof element.getElementsByTagNameNS === 'function') {
      const nsList = element.getElementsByTagNameNS(STB_NS, sel);
      barArrangementEl = nsList && nsList[0];
    }
    if (!barArrangementEl) {
      // タグ名で直接検索
      for (const child of getElementChildren(element)) {
        if (child.tagName === sel || child.localName === sel) {
          barArrangementEl = child;
          break;
        }
      }
    }
    if (barArrangementEl) break;
  }

  if (!barArrangementEl) return null;

  const result = {};

  // かぶり情報を抽出
  const coverStartX = parseFloat(barArrangementEl.getAttribute('depth_cover_start_X'));
  const coverEndX = parseFloat(barArrangementEl.getAttribute('depth_cover_end_X'));
  const coverStartY = parseFloat(barArrangementEl.getAttribute('depth_cover_start_Y'));
  const coverEndY = parseFloat(barArrangementEl.getAttribute('depth_cover_end_Y'));
  // 梁用かぶり
  const coverTop = parseFloat(barArrangementEl.getAttribute('depth_cover_top'));
  const coverBottom = parseFloat(barArrangementEl.getAttribute('depth_cover_bottom'));
  const coverLeft = parseFloat(barArrangementEl.getAttribute('depth_cover_left'));
  const coverRight = parseFloat(barArrangementEl.getAttribute('depth_cover_right'));

  if (!isNaN(coverStartX) || !isNaN(coverEndX) || !isNaN(coverStartY) || !isNaN(coverEndY)) {
    result.cover = {
      startX: isNaN(coverStartX) ? null : coverStartX,
      endX: isNaN(coverEndX) ? null : coverEndX,
      startY: isNaN(coverStartY) ? null : coverStartY,
      endY: isNaN(coverEndY) ? null : coverEndY,
    };
  }
  if (!isNaN(coverTop) || !isNaN(coverBottom)) {
    result.cover = result.cover || {};
    result.cover.top = isNaN(coverTop) ? null : coverTop;
    result.cover.bottom = isNaN(coverBottom) ? null : coverBottom;
    result.cover.left = isNaN(coverLeft) ? null : coverLeft;
    result.cover.right = isNaN(coverRight) ? null : coverRight;
  }

  // barElement (配筋詳細) を検索
  if (!config.barElements || config.barElements.length === 0) return result;

  let barEl = null;
  for (const sel of config.barElements) {
    for (const child of getElementChildren(barArrangementEl)) {
      if (child.tagName === sel || child.localName === sel) {
        barEl = child;
        break;
      }
    }
    if (barEl) break;
  }

  if (!barEl) return result;

  // 主筋情報を抽出
  const dMain = barEl.getAttribute('D_main');
  const strengthMain = barEl.getAttribute('strength_main');
  const nMainX1st = parseInt(barEl.getAttribute('N_main_X_1st'), 10);
  const nMainY1st = parseInt(barEl.getAttribute('N_main_Y_1st'), 10);
  const nMainTotal = parseInt(barEl.getAttribute('N_main_total'), 10);
  // 梁用主筋
  const nMainTop1st = parseInt(barEl.getAttribute('N_main_top_1st'), 10);
  const nMainTop2nd = parseInt(barEl.getAttribute('N_main_top_2nd'), 10);
  const nMainBottom1st = parseInt(barEl.getAttribute('N_main_bottom_1st'), 10);
  const nMainBottom2nd = parseInt(barEl.getAttribute('N_main_bottom_2nd'), 10);

  if (dMain || strengthMain) {
    result.mainBars = {
      diameter: dMain || null,
      grade: strengthMain || null,
      count: {},
    };
    if (!isNaN(nMainX1st)) result.mainBars.count.x1st = nMainX1st;
    if (!isNaN(nMainY1st)) result.mainBars.count.y1st = nMainY1st;
    if (!isNaN(nMainTotal)) result.mainBars.count.total = nMainTotal;
    if (!isNaN(nMainTop1st)) result.mainBars.count.top1st = nMainTop1st;
    if (!isNaN(nMainTop2nd)) result.mainBars.count.top2nd = nMainTop2nd;
    if (!isNaN(nMainBottom1st)) result.mainBars.count.bottom1st = nMainBottom1st;
    if (!isNaN(nMainBottom2nd)) result.mainBars.count.bottom2nd = nMainBottom2nd;
  }

  // 帯筋/あばら筋情報を抽出
  // 柱: D_band, strength_band, pitch_band, N_band_direction_X, N_band_direction_Y
  // 梁: D_stirrup, strength_stirrup, pitch_stirrup, N_stirrup
  const dBand = barEl.getAttribute('D_band') || barEl.getAttribute('D_stirrup');
  const strengthBand =
    barEl.getAttribute('strength_band') || barEl.getAttribute('strength_stirrup');
  const pitchBand = parseFloat(
    barEl.getAttribute('pitch_band') || barEl.getAttribute('pitch_stirrup'),
  );
  const nBandX = parseInt(barEl.getAttribute('N_band_direction_X'), 10);
  const nBandY = parseInt(barEl.getAttribute('N_band_direction_Y'), 10);
  const nStirrup = parseInt(barEl.getAttribute('N_stirrup'), 10);

  if (dBand || strengthBand || !isNaN(pitchBand)) {
    result.hoops = {
      diameter: dBand || null,
      grade: strengthBand || null,
      pitch: isNaN(pitchBand) ? null : pitchBand,
      legs: {},
    };
    if (!isNaN(nBandX)) result.hoops.legs.x = nBandX;
    if (!isNaN(nBandY)) result.hoops.legs.y = nBandY;
    if (!isNaN(nStirrup)) result.hoops.legs.count = nStirrup;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * スラブ配筋情報を抽出（ラウンドトリップ用）
 *
 * STBのスラブ配筋は複雑な構造を持つため、ラウンドトリップを考慮して
 * 配筋タイプと各配筋要素の属性を保持します。
 *
 * STB 2.0.2: StbSecBarArrangementSlab_RC
 *   子要素: StbSecBarSlab_RC_Standard (12), StbSecBarSlab_RC_2Way (4),
 *           StbSecBarSlab_RC_1Way1 (4), StbSecBarSlab_RC_1Way2 (6)
 *
 * STB 2.1: StbSecBarArrangementSlab_RC_Conventional / _Truss
 *
 * @param {Element} element - 断面要素 (StbSecSlab_RC等)
 * @param {Object} config - 抽出設定 (slabBarArrangements)
 * @returns {Object|null} スラブ配筋情報
 *   {
 *     type: 'StbSecBarArrangementSlab_RC',
 *     cover: { top, bottom },
 *     bars: [{ type: 'StbSecBarSlab_RC_2Way', pos: 'X_TOP', ... }, ...]
 *   }
 */
export function extractSlabBarArrangement(element, config) {
  if (!config.slabBarArrangements || config.slabBarArrangements.length === 0) return null;

  const tagName = element.tagName || element.localName;
  // スラブ断面でなければスキップ
  if (!/^StbSecSlab/i.test(tagName)) return null;

  let barArrangementEl = null;
  let arrangementType = null;

  // slabBarArrangement要素を検索
  for (const sel of config.slabBarArrangements) {
    for (const child of getElementChildren(element)) {
      if (child.tagName === sel || child.localName === sel) {
        barArrangementEl = child;
        arrangementType = sel;
        break;
      }
    }
    if (barArrangementEl) break;
  }

  if (!barArrangementEl) return null;

  const result = {
    type: arrangementType,
  };

  // かぶり情報を抽出
  const coverTop = parseFloat(barArrangementEl.getAttribute('depth_cover_top'));
  const coverBottom = parseFloat(barArrangementEl.getAttribute('depth_cover_bottom'));

  if (!isNaN(coverTop) || !isNaN(coverBottom)) {
    result.cover = {
      top: isNaN(coverTop) ? null : coverTop,
      bottom: isNaN(coverBottom) ? null : coverBottom,
    };
  }

  // 配筋詳細要素を収集
  const bars = collectBarElements(barArrangementEl);
  if (bars.length > 0) {
    result.bars = bars;
  }

  return Object.keys(result).length > 1 ? result : null; // typeのみの場合はnull
}

/**
 * 壁配筋情報を抽出（ラウンドトリップ用）
 *
 * STBの壁配筋は複雑な構造を持つため、ラウンドトリップを考慮して
 * 配筋タイプと各配筋要素の属性を保持します。
 *
 * StbSecBarArrangementWall_RC
 *   子要素: StbSecBarWall_RC_Single (2), StbSecBarWall_RC_Zigzag (2),
 *           StbSecBarWall_RC_DoubleNet (2), StbSecBarWall_RC_InsideAndOutside (4-12)
 *           + StbSecBarWall_RC_Edge (0-4), StbSecBarWall_RC_Open (0-3)
 *
 * @param {Element} element - 断面要素 (StbSecWall_RC等)
 * @param {Object} config - 抽出設定 (wallBarArrangements)
 * @returns {Object|null} 壁配筋情報
 *   {
 *     type: 'StbSecBarArrangementWall_RC',
 *     cover: { outside, inside },
 *     bars: [{ type: 'StbSecBarWall_RC_Single', pos: 'VERTICAL', ... }, ...]
 *   }
 */
export function extractWallBarArrangement(element, config) {
  if (!config.wallBarArrangements || config.wallBarArrangements.length === 0) return null;

  const tagName = element.tagName || element.localName;
  // 壁断面でなければスキップ
  if (!/^StbSecWall/i.test(tagName)) return null;

  let barArrangementEl = null;
  let arrangementType = null;

  // wallBarArrangement要素を検索
  for (const sel of config.wallBarArrangements) {
    for (const child of getElementChildren(element)) {
      if (child.tagName === sel || child.localName === sel) {
        barArrangementEl = child;
        arrangementType = sel;
        break;
      }
    }
    if (barArrangementEl) break;
  }

  if (!barArrangementEl) return null;

  const result = {
    type: arrangementType,
  };

  // かぶり情報を抽出（壁は外側/内側）
  const coverOutside = parseFloat(barArrangementEl.getAttribute('depth_cover_outside'));
  const coverInside = parseFloat(barArrangementEl.getAttribute('depth_cover_inside'));

  if (!isNaN(coverOutside) || !isNaN(coverInside)) {
    result.cover = {
      outside: isNaN(coverOutside) ? null : coverOutside,
      inside: isNaN(coverInside) ? null : coverInside,
    };
  }

  // 配筋詳細要素を収集
  const bars = collectBarElements(barArrangementEl);
  if (bars.length > 0) {
    result.bars = bars;
  }

  return Object.keys(result).length > 1 ? result : null; // typeのみの場合はnull
}

/**
 * 配筋配置コンテナ直下の配筋詳細要素を全属性つきで収集（ラウンドトリップ用）
 * @param {Element} barArrangementEl - 配筋配置コンテナ要素
 * @returns {Array<Object>} 配筋詳細（type + 全属性）の配列
 */
function collectBarElements(barArrangementEl) {
  const bars = [];
  for (const barEl of getElementChildren(barArrangementEl)) {
    const barTagName = barEl.tagName || barEl.localName;
    const barData = { type: barTagName };

    // 全属性を収集（ラウンドトリップ用）
    if (barEl.attributes) {
      for (let j = 0; j < barEl.attributes.length; j++) {
        const attr = barEl.attributes[j];
        barData[attr.name] = attr.value;
      }
    }

    bars.push(barData);
  }
  return bars;
}
