/**
 * @fileoverview 大梁あばら筋を実柱面・内法スパン Lo 基準の実位置へ展開する。
 *
 * P0-D3 では断面ごとの比率区間を、部材ごとの実柱面区間へ変換し、
 * 第1あばら筋を柱面からの実寸距離で固定する。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import {
  incrementRebarPerformanceCounter,
  measureRebarPerformance,
} from '../../../utils/rebarPerformanceMetrics.js';
import { createTagScanner } from '../columnSupportUtils.js';
import { querySelectorAll } from '../sectionListUtils.js';
import { buildBeamStirrupLayoutMaps } from './hoopPlacement.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { resolveBeamClearSpanFromScanner } from './rebarClearGeometry.js';

const EPS = 1e-6;
const POSITION_HALF_WINDOW_RATIO = 1e-8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positionsFromStart(startMm, endMm, pitchMm) {
  if (!(pitchMm > 0) || endMm < startMm - EPS) return [];
  const positions = [];
  for (let value = startMm; value <= endMm + EPS; value += pitchMm) {
    positions.push(Math.min(value, endMm));
  }
  return positions;
}

function positionsFromEnd(startMm, endMm, pitchMm) {
  if (!(pitchMm > 0) || endMm < startMm - EPS) return [];
  const positions = [];
  for (let value = endMm; value >= startMm - EPS; value -= pitchMm) {
    positions.push(Math.max(value, startMm));
  }
  positions.reverse();
  return positions;
}

function uniqueSorted(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]) > EPS) {
      result.push(value);
    }
  }
  return result;
}

function singlePitchPositions(startFaceMm, endFaceMm, firstOffsetMm, pitchMm) {
  const first = startFaceMm + firstOffsetMm;
  const last = endFaceMm - firstOffsetMm;
  if (last < first - EPS) return [];

  const positions = positionsFromStart(first, last, pitchMm);
  if (positions.length === 0) return [first];
  if (last - positions[positions.length - 1] > EPS) positions.push(last);
  return uniqueSorted(positions);
}

function zonePositions({
  zoneStartMm,
  zoneEndMm,
  pitchMm,
  index,
  count,
  startFaceMm,
  endFaceMm,
  firstOffsetMm,
}) {
  if (count === 1) {
    return singlePitchPositions(startFaceMm, endFaceMm, firstOffsetMm, pitchMm);
  }
  if (index === 0) {
    return positionsFromStart(startFaceMm + firstOffsetMm, zoneEndMm, pitchMm);
  }
  if (index === count - 1) {
    return positionsFromEnd(zoneStartMm, endFaceMm - firstOffsetMm, pitchMm);
  }
  return positionsFromStart(zoneStartMm, zoneEndMm, pitchMm);
}

function explicitPositionSegment(positionRatio, sourceSegment) {
  const startRatio = clamp(positionRatio - POSITION_HALF_WINDOW_RATIO, 0, 1);
  const endRatio = clamp(positionRatio + POSITION_HALF_WINDOW_RATIO, 0, 1);
  if (!(endRatio > startRatio)) return null;

  return {
    ...sourceSegment,
    startRatio,
    endRatio,
    pitch: Number.MAX_SAFE_INTEGER,
    positionRatio,
    exactAxialPosition: true,
  };
}

/**
 * 断面単位のあばら筋レイアウトを、1本の大梁の実柱面位置へ変換する。
 * @param {Object} sectionLayout - hoopPlacement の断面単位レイアウト
 * @param {Object} clearSpan - resolveBeamClearSpan の結果
 * @returns {Object|null} 要素単位レイアウト
 */
export function materializeGirderStirrupLayout(sectionLayout, clearSpan) {
  if (!sectionLayout?.segments?.length || !clearSpan?.beamAxis) return null;

  const memberLengthMm = clearSpan.beamAxis.lengthMm;
  const startFaceMm = clearSpan.startFace.faceT;
  const endFaceMm = clearSpan.endFace.faceT;
  const loMm = clearSpan.loMm;
  if (!(memberLengthMm > 0) || !(loMm > 0) || !(endFaceMm > startFaceMm)) return null;

  const firstStirrupFromFaceMm = REBAR_STANDARD_RULES.resolveFirstStirrupFromFaceMm();
  const safeFirstOffsetMm = Math.min(firstStirrupFromFaceMm, loMm / 2);
  const explicitSegments = [];

  sectionLayout.segments.forEach((segment, index) => {
    const zoneStartMm = startFaceMm + loMm * segment.startRatio;
    const zoneEndMm = startFaceMm + loMm * segment.endRatio;
    const positions = zonePositions({
      zoneStartMm,
      zoneEndMm,
      pitchMm: segment.pitch,
      index,
      count: sectionLayout.segments.length,
      startFaceMm,
      endFaceMm,
      firstOffsetMm: safeFirstOffsetMm,
    });

    for (const positionMm of positions) {
      const ratio = positionMm / memberLengthMm;
      const explicit = explicitPositionSegment(ratio, segment);
      if (explicit) explicitSegments.push(explicit);
    }
  });

  explicitSegments.sort((a, b) => a.positionRatio - b.positionRatio);
  if (explicitSegments.length === 0) return null;

  return {
    ...sectionLayout,
    memberSpecific: true,
    geometrySource: 'exact-column-face',
    clearSpanMm: loMm,
    memberPlanLengthMm: memberLengthMm,
    startFaceMm,
    endFaceMm,
    firstStirrupFromFaceMm: safeFirstOffsetMm,
    segments: explicitSegments,
  };
}

/**
 * 大梁は要素ID単位、小梁は従来どおり断面ID単位のあばら筋レイアウトを返す。
 *
 * 大梁で実柱面が解けない場合は従来の節点比率へ無言でフォールバックしない。
 * @param {Document} xmlDoc - STB XML
 * @param {Object} [options] - 断面内配置上書き
 * @param {function(string): Element[]} [options.scanTag] - 共有タグ走査関数
 * @param {Object|null} [options.modelIndex] - 共有RebarModelIndex
 * @returns {{girder:Map<string,Object>,beam:Map<string,Object>}}
 */
export function buildBeamStirrupMemberLayoutMaps(xmlDoc, options = {}) {
  incrementRebarPerformanceCounter('builder.girderHoop.count');
  return measureRebarPerformance('rebar.member.girder.stirrup', () => {
    const sectionLayouts = buildBeamStirrupLayoutMaps(xmlDoc, options);
    const girder = new Map();
    const beam = sectionLayouts.beam;
    const scanTag = options.scanTag || createTagScanner(xmlDoc);
    const modelIndex = options.modelIndex || buildRebarModelIndex(xmlDoc, { scanTag });

    girder.lookupKey = 'elementId';

    for (const beamEl of querySelectorAll(xmlDoc, 'StbGirder')) {
      const elementId = beamEl.getAttribute('id');
      const sectionId = beamEl.getAttribute('id_section');
      if (!elementId || !sectionId) continue;

      const sectionLayout = sectionLayouts.girder.get(String(sectionId));
      if (!sectionLayout) continue;

      const clearSpan = resolveBeamClearSpanFromScanner(scanTag, beamEl, modelIndex);
      if (!clearSpan) continue;

      const layout = materializeGirderStirrupLayout(sectionLayout, clearSpan);
      if (layout) girder.set(String(elementId), layout);
    }

    return { girder, beam };
  });
}
