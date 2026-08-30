/**
 * @fileoverview 帯筋（フープ）・あばら筋（スターラップ）の断面内配置算定（3D配筋用）
 *
 * 主筋と違い、帯筋・あばら筋は材軸に垂直な閉ループである。そのため
 * 「断面内のループ形状」と「材軸方向のピッチ」の組で表し、実際の本数と
 * 位置は viewer 側でピッチから求める。
 *
 * ループ芯の位置は主筋のdtと同じ考え方で、
 *
 *   ループ芯 = かぶり ＋ 帯筋/あばら筋の最大外径/2
 *
 * とする（主筋芯はこれにさらに主筋の最大外径/2 を足したもの）。
 *
 * 座標系は主筋と共通で断面ローカル（断面中心が原点）。u は断面幅方向、
 * v は断面せい方向（上が正）。
 *
 * @module data/extractors/rebar3d/hoopPlacement
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import {
  BEAM_REBAR_PLACEMENT_RULES,
  COLUMN_REBAR_PLACEMENT_RULES,
  HOOP_PLACEMENT_RULES,
} from '../../../constants/rebarPlacementRules.js';
import { extractRcColumnSections } from '../columnSectionListExtractor.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { querySelectorAll } from '../sectionListUtils.js';
import { isGirderSection, orderedPositionKeys, resolveSpanRanges } from './rebarSectionUtils.js';

/**
 * ピッチを検証して返す
 * @param {number|null} pitch - STBのピッチ [mm]
 * @returns {number|null} 有効なピッチ [mm]。不明・過小なら null
 */
function normalizePitch(pitch) {
  const value = Number(pitch);
  if (!Number.isFinite(value) || value < HOOP_PLACEMENT_RULES.minPitchMm) return null;
  return value;
}

/**
 * 呼び名から呼び径・最大外径を求める
 * @param {string|null} diaName - 呼び名（D10 等）
 * @param {string} defaultDiaName - 既定の呼び名
 * @returns {{name:string, diaMm:number, outerMm:number}} 径情報
 */
function resolveBarDiameters(diaName, defaultDiaName) {
  const name = diaName || defaultDiaName;
  const fallbackMm = barDiameterMm(defaultDiaName);
  const diaMm = barDiameterMm(name, fallbackMm);
  return { name, diaMm, outerMm: barOuterDiameterMm(name, diaMm) };
}

/**
 * 材軸方向の区間（ループ列）を1つ作る
 * @param {number} startRatio - 始点比率（0〜1）
 * @param {number} endRatio - 終点比率（0〜1）
 * @param {number} pitch - ピッチ [mm]
 * @param {Array<Object>} loops - 断面内のループ形状
 * @returns {{startRatio:number, endRatio:number, pitch:number, loops:Array}} 区間
 */
function createHoopSegment(startRatio, endRatio, pitch, loops) {
  return { startRatio, endRatio, pitch, loops };
}

/**
 * 矩形ループを作る（内法が確保できない場合は null）
 * @param {number} uMin - u方向の最小 [mm]
 * @param {number} uMax - u方向の最大 [mm]
 * @param {number} vMin - v方向の最小 [mm]
 * @param {number} vMax - v方向の最大 [mm]
 * @param {number} diaMm - 呼び径 [mm]
 * @returns {Object|null} ループ
 */
function createRectLoop(uMin, uMax, vMin, vMax, diaMm) {
  const { minInnerSpanMm } = HOOP_PLACEMENT_RULES;
  if (uMax - uMin < minInnerSpanMm || vMax - vMin < minInnerSpanMm) return null;
  return { type: 'RECT', uMin, uMax, vMin, vMax, dia: diaMm };
}

/**
 * RC柱断面1つ分の帯筋配置を算定する
 *
 * 柱は全長にわたって同じ帯筋を描くため、材軸方向は1区間のみとする
 * （端部と中央でピッチを変える指定はSTBの柱断面には無い）。
 * @param {Object} sectionDetail - columnSectionListExtractor の断面詳細
 * @param {Object} [options] - 上書き設定
 * @param {number} [options.coverMm] - かぶり厚さの上書き [mm]
 * @returns {Object|null} 配置結果。算定できない場合は null
 */
export function computeColumnHoopSectionLayout(sectionDetail, options = {}) {
  const dimensions = sectionDetail?.dimensions;
  const hoop = sectionDetail?.hoop;
  if (!dimensions?.type || !hoop) return null;

  const pitch = normalizePitch(hoop.pitch);
  if (!pitch) return null;

  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const coverMm = options.coverMm ?? sectionDetail.cover ?? rules.defaultCoverMm;
  const dia = resolveBarDiameters(hoop.dia, rules.defaultHoopDia);
  // ループ芯は「かぶり ＋ 帯筋の最大外径/2」だけ部材面から入る
  const inset = coverMm + dia.outerMm / 2;

  if (dimensions.type === 'CIRCLE') {
    const radius = (dimensions.diameter || 0) / 2 - inset;
    if (!(radius > 0)) return null;
    return {
      kind: 'columnHoop',
      shape: 'CIRCLE',
      diameter: dimensions.diameter,
      segments: [createHoopSegment(0, 1, pitch, [{ type: 'CIRCLE', radius, dia: dia.diaMm }])],
      coverMm,
      hoopDia: dia.name,
      estimated: true,
    };
  }

  const width = dimensions.width || 0;
  const height = dimensions.height || 0;
  if (width <= 0 || height <= 0) return null;

  const loop = createRectLoop(
    -width / 2 + inset,
    width / 2 - inset,
    -height / 2 + inset,
    height / 2 - inset,
    dia.diaMm,
  );
  if (!loop) return null;

  return {
    kind: 'columnHoop',
    shape: 'RECTANGLE',
    width,
    height,
    segments: [createHoopSegment(0, 1, pitch, [loop])],
    coverMm,
    hoopDia: dia.name,
    estimated: true,
  };
}

/**
 * 梁断面の1位置分のあばら筋ループを組み立てる
 * @param {Object} position - positions[key]
 * @param {Object} fallbackCover - 断面共通のかぶり
 * @param {Object} options - {coverMm} 上書き設定
 * @param {number} depth - 代表梁せい [mm]
 * @returns {{loop:Object, pitch:number, diaName:string, coverMm:number}|null} ループ情報
 */
function buildPositionLoop(position, fallbackCover, options, depth) {
  const width = position?.width || 0;
  if (width <= 0 || depth <= 0) return null;

  const pitch = normalizePitch(position.stirrup?.pitch);
  if (!pitch) return null;

  const rules = BEAM_REBAR_PLACEMENT_RULES;
  const cover = position.cover || fallbackCover || {};
  const resolveCover = (value) => options.coverMm ?? value ?? rules.defaultCoverMm;
  const coverTop = resolveCover(cover.top);
  const coverBottom = resolveCover(cover.bottom);
  const coverSide = resolveCover(cover.left ?? cover.right);

  const dia = resolveBarDiameters(position.stirrup?.dia, rules.defaultStirrupDia);
  const half = dia.outerMm / 2;

  const loop = createRectLoop(
    -width / 2 + coverSide + half,
    width / 2 - coverSide - half,
    -depth / 2 + coverBottom + half,
    depth / 2 - coverTop - half,
    dia.diaMm,
  );
  if (!loop) return null;

  return { loop, pitch, diaName: dia.name, coverMm: coverTop };
}

/**
 * RC梁断面1つ分のあばら筋配置を算定する
 *
 * 端部と中央でピッチ・径が変わるため、主筋と同じ区間割り
 * （3位置なら端部 L/4）で位置ごとに区間を作る。
 * @param {Object} sectionDetail - extractRcBeamSectionDetail の結果
 * @param {Object} [options] - 上書き設定
 * @param {number} [options.coverMm] - かぶり厚さの上書き [mm]
 * @returns {Object|null} 配置結果。算定できない場合は null
 */
export function computeBeamStirrupSectionLayout(sectionDetail, options = {}) {
  const keys = orderedPositionKeys(sectionDetail);
  if (keys.length === 0) return null;

  // 梁は天端基準の単一断面として描かれるため、鉛直位置の基準となる梁せいは
  // 主筋と同じく断面共通の代表値（先頭位置）を使う
  const depth = sectionDetail.positions[keys[0]]?.depth || 0;
  if (depth <= 0) return null;

  const segments = [];
  let meta = null;

  for (const { key, startRatio, endRatio } of resolveSpanRanges(keys)) {
    const built = buildPositionLoop(
      sectionDetail.positions[key],
      sectionDetail.cover,
      options,
      depth,
    );
    if (!built) continue;
    segments.push(createHoopSegment(startRatio, endRatio, built.pitch, [built.loop]));
    meta = meta || built;
  }

  if (segments.length === 0) return null;

  return {
    kind: 'beamStirrup',
    shape: 'RECTANGLE',
    depth,
    segments,
    positionPattern: sectionDetail.positionPattern || 'SAME',
    coverMm: meta.coverMm,
    stirrupDia: meta.diaName,
    estimated: true,
  };
}

/**
 * STB文書からRC柱断面ID → 帯筋配置のマップを作る
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {Object} [options] - computeColumnHoopSectionLayout に渡す設定
 * @returns {Map<string, Object>} 断面ID → 配置結果
 */
export function buildColumnHoopLayoutMap(xmlDoc, options = {}) {
  const layouts = new Map();
  if (!xmlDoc) return layouts;

  for (const [sectionId, detail] of extractRcColumnSections(xmlDoc)) {
    const layout = computeColumnHoopSectionLayout(detail, options);
    if (layout) layouts.set(sectionId, layout);
  }
  return layouts;
}

/**
 * STB文書からRC梁断面ID → あばら筋配置のマップを作る
 *
 * 大梁と小梁は断面IDの採番空間が独立しているため、主筋と同様に分けて返す。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {Object} [options] - computeBeamStirrupSectionLayout に渡す設定
 * @returns {{girder: Map<string, Object>, beam: Map<string, Object>}} 断面ID → 配置結果
 */
export function buildBeamStirrupLayoutMaps(xmlDoc, options = {}) {
  const girder = new Map();
  const beam = new Map();
  if (!xmlDoc) return { girder, beam };

  for (const tagName of ['StbSecGirder_RC', 'StbSecBeam_RC']) {
    for (const element of querySelectorAll(xmlDoc, tagName)) {
      const detail = extractRcBeamSectionDetail(element);
      if (!detail?.id) continue;
      const layout = computeBeamStirrupSectionLayout(detail, options);
      if (!layout) continue;
      (isGirderSection(element) ? girder : beam).set(detail.id, layout);
    }
  }
  return { girder, beam };
}
