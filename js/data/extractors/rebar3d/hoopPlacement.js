/**
 * @fileoverview 帯筋（フープ）・あばら筋（スターラップ）の断面内配置算定（3D配筋用）
 *
 * R4では外周閉ループに加え、STBの脚数から中子筋を生成する。
 * 柱は N_band_direction_X/Y、梁は N_stirrup を実際の断面内直線筋へ展開し、
 * 柱の第2帯筋種（dia2/pitch2）も独立したループ列として保持する。
 * 梁幅止筋は腹筋の実3D位置へ接続し、独立した pitch_bar_spacing で材軸方向へ配置する。
 * R11では実折曲げgeometryへ接続できるよう、径だけでなく鉄筋強度をsegment/loop/tieへ保持する。
 * 中子筋は拘束対象主筋の断面中心側へ配置し、外周筋と中子筋で主筋を挟む。
 * 外周HOOP/STPと中子筋の拘束位置は、可能な限り実際に描画する1段目主筋bar factsから解く。
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
import { resolveBeamAuxiliaryApplyPolicy, resolveBeamWidthTie } from './beamAuxiliaryPlacement.js';
import { computeBeamRebarSectionLayout } from './beamRebarPlacement.js';
import { buildColumnArrangementFacts } from './columnRebarFacts.js';
import {
  evenlySpaced,
  isGirderSection,
  orderedPositionKeys,
  resolveSpanRanges,
} from './rebarSectionUtils.js';

function normalizePitch(pitch) {
  const value = Number(pitch);
  if (!Number.isFinite(value) || value < HOOP_PLACEMENT_RULES.minPitchMm) return null;
  return value;
}

function resolveBarDiameters(diaName, defaultDiaName) {
  const name = diaName || defaultDiaName;
  const fallbackMm = barDiameterMm(defaultDiaName);
  const diaMm = barDiameterMm(name, fallbackMm);
  return { name, diaMm, outerMm: barOuterDiameterMm(name, diaMm) };
}

function createHoopSegment(startRatio, endRatio, pitch, loops, ties = [], metadata = {}) {
  return { startRatio, endRatio, pitch, loops, ties, ...metadata };
}

function createRectLoop(uMin, uMax, vMin, vMax, diaMm) {
  const { minInnerSpanMm } = HOOP_PLACEMENT_RULES;
  if (uMax - uMin < minInnerSpanMm || vMax - vMin < minInnerSpanMm) return null;
  return { type: 'RECT', uMin, uMax, vMin, vMax, dia: diaMm };
}

function finiteBarFacts(bars) {
  return (bars || []).filter(
    (bar) =>
      Number.isFinite(Number(bar?.u)) &&
      Number.isFinite(Number(bar?.v)) &&
      Number.isFinite(Number(bar?.dia)) &&
      Number(bar.dia) > 0,
  );
}

function barEdge(bar, axis, sideSign) {
  return Number(bar?.[axis]) + (sideSign * Number(bar?.dia)) / 2;
}

function resolveCornerAnchorBar(bars, uSideSign, vSideSign) {
  if (!bars.length) return null;
  const uEdges = bars.map((bar) => barEdge(bar, 'u', uSideSign));
  const vEdges = bars.map((bar) => barEdge(bar, 'v', vSideSign));
  const uTarget = uSideSign > 0 ? Math.max(...uEdges) : Math.min(...uEdges);
  const vTarget = vSideSign > 0 ? Math.max(...vEdges) : Math.min(...vEdges);
  const candidates = bars.filter(
    (bar) =>
      Math.abs(barEdge(bar, 'u', uSideSign) - uTarget) <= 1e-6 &&
      Math.abs(barEdge(bar, 'v', vSideSign) - vTarget) <= 1e-6,
  );
  if (candidates.length !== 1) return null;
  const bar = candidates[0];
  return { u: Number(bar.u), v: Number(bar.v), dia: Number(bar.dia) };
}

/**
 * 実際の主筋円柱を外側から接するHOOP/STP中心線矩形を求める。
 * viewerが描画する主筋径とせん断補強筋径の半径和だけ主筋中心より外側へ置く。
 *
 * 135°外周フック用に、対角交互配置で使用するTOP_RIGHT / BOTTOM_LEFTの角主筋を
 * bar factとして同時に保持する。u/v両外縁を同一barが決めない場合は推定しない。
 */
function createRestrainingLoopFromBars(bars, tieDiaMm) {
  const resolved = finiteBarFacts(bars);
  const tieRadius = Number(tieDiaMm) / 2;
  if (resolved.length === 0 || !(tieRadius > 0)) return null;

  const uBarMin = Math.min(...resolved.map((bar) => barEdge(bar, 'u', -1)));
  const uBarMax = Math.max(...resolved.map((bar) => barEdge(bar, 'u', 1)));
  const vBarMin = Math.min(...resolved.map((bar) => barEdge(bar, 'v', -1)));
  const vBarMax = Math.max(...resolved.map((bar) => barEdge(bar, 'v', 1)));
  const loop = createRectLoop(
    uBarMin - tieRadius,
    uBarMax + tieRadius,
    vBarMin - tieRadius,
    vBarMax + tieRadius,
    Number(tieDiaMm),
  );
  if (!loop) return null;

  loop.hookAnchorBars = {
    TOP_RIGHT: resolveCornerAnchorBar(resolved, 1, 1),
    BOTTOM_LEFT: resolveCornerAnchorBar(resolved, -1, -1),
  };
  loop.hookAnchorSource = 'actual-main-bars';
  loop.hookAnchorsResolved = Boolean(
    loop.hookAnchorBars.TOP_RIGHT && loop.hookAnchorBars.BOTTOM_LEFT,
  );
  return loop;
}

function uniqueSorted(values) {
  const sorted = values
    .filter(Number.isFinite)
    .map(Number)
    .sort((a, b) => a - b);
  return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]) > 1e-9);
}

function selectBaselineInnerLegSlotIndices(slotCount, fullLegCount) {
  const slots = Math.max(0, Number.parseInt(slotCount, 10) || 0);
  const innerCount = Math.max(0, (Number.parseInt(fullLegCount, 10) || 0) - 2);
  const candidates = Array.from({ length: Math.max(0, slots - 2) }, (_, index) => index + 1);
  if (innerCount <= 0 || candidates.length === 0) return [];
  if (innerCount >= candidates.length) return candidates;
  if (innerCount === 1) return [candidates[Math.floor(candidates.length / 2)]];

  return Array.from({ length: innerCount }, (_, index) => {
    const candidateIndex = Math.round((index * (candidates.length - 1)) / (innerCount - 1));
    return candidates[candidateIndex];
  }).filter((value, index, values) => values.indexOf(value) === index);
}

function columnReferenceArrangement(sectionDetail) {
  const arrangements = Array.isArray(sectionDetail?.arrangements) ? sectionDetail.arrangements : [];
  const explicit =
    arrangements.find((item) => item?.position === 'SAME') ||
    arrangements.find((item) => item?.position === 'BOTTOM') ||
    arrangements.find((item) => item?.position === 'TOP') ||
    arrangements[0];
  if (explicit?.mainBar) return explicit;
  if (!sectionDetail?.mainBar) return null;
  return {
    mainBar: sectionDetail.mainBar,
    hoop: sectionDetail.hoop,
    coreBar: sectionDetail.coreBar,
    cover: sectionDetail.cover,
  };
}

function columnMainAnchorAxes(sectionDetail, options, loop, hoop, factsOverride = null) {
  const arrangement = columnReferenceArrangement(sectionDetail);
  const facts =
    factsOverride ||
    (arrangement
      ? buildColumnArrangementFacts(sectionDetail.dimensions, arrangement, options)
      : null);
  const firstLayer = (facts?.mainBars || []).filter((bar) => Number(bar.layer) === 1);

  let uAnchors = [];
  let vAnchors = [];
  if (firstLayer.length > 0) {
    const maxAbsU = Math.max(...firstLayer.map((bar) => Math.abs(Number(bar.u) || 0)));
    const maxAbsV = Math.max(...firstLayer.map((bar) => Math.abs(Number(bar.v) || 0)));
    uAnchors = uniqueSorted(
      firstLayer
        .filter((bar) => Math.abs(Math.abs(Number(bar.v) || 0) - maxAbsV) < 1e-6)
        .map((bar) => Number(bar.u)),
    );
    vAnchors = uniqueSorted(
      firstLayer
        .filter((bar) => Math.abs(Math.abs(Number(bar.u) || 0) - maxAbsU) < 1e-6)
        .map((bar) => Number(bar.v)),
    );
  }

  if (uAnchors.length < 2) {
    uAnchors = evenlySpaced(loop.uMin, loop.uMax, Math.max(2, Number(hoop.countY) || 2));
  }
  if (vAnchors.length < 2) {
    vAnchors = evenlySpaced(loop.vMin, loop.vMax, Math.max(2, Number(hoop.countX) || 2));
  }
  return {
    uAnchors,
    vAnchors,
    firstLayer,
    mainDiaMm: Number(facts?.mainBars?.[0]?.dia) || 0,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 主筋中心から中子筋中心を断面中心側へ離す。
 * 中心間距離は主筋半径＋中子筋半径とし、外周筋と中子筋の間に主筋を確実に含める。
 */
function inwardTiePosition(anchor, mainDiaMm, tieDiaMm, min, max) {
  const offset = Math.max(0, Number(mainDiaMm)) / 2 + Math.max(0, Number(tieDiaMm)) / 2;
  const direction = anchor <= 0 ? 1 : -1;
  return clamp(anchor + direction * offset, min, max);
}

function extremeBarsOnAxis(firstLayer, axis, anchor) {
  const candidates = finiteBarFacts(firstLayer).filter((bar) =>
    axis === 'v'
      ? Math.abs(Number(bar.u) - Number(anchor)) < 1e-6
      : Math.abs(Number(bar.v) - Number(anchor)) < 1e-6,
  );
  if (candidates.length < 2) return null;
  if (axis === 'v') {
    return {
      start: candidates.reduce((a, b) => (Number(a.v) < Number(b.v) ? a : b)),
      end: candidates.reduce((a, b) => (Number(a.v) > Number(b.v) ? a : b)),
    };
  }
  return {
    start: candidates.reduce((a, b) => (Number(a.u) < Number(b.u) ? a : b)),
    end: candidates.reduce((a, b) => (Number(a.u) > Number(b.u) ? a : b)),
  };
}

function createColumnInnerTies(sectionDetail, options, loop, hoop, diaMm, factsOverride = null) {
  const { uAnchors, vAnchors, firstLayer, mainDiaMm } = columnMainAnchorAxes(
    sectionDetail,
    options,
    loop,
    hoop,
    factsOverride,
  );
  const ties = [];

  selectBaselineInnerLegSlotIndices(vAnchors.length, hoop.countX).forEach((index) => {
    const anchorV = vAnchors[index];
    const targets = extremeBarsOnAxis(firstLayer, 'u', anchorV);
    if (!Number.isFinite(anchorV)) return;
    if (!targets) {
      ties.push({
        type: 'LINE',
        axis: 'u',
        uMin: loop.uMin,
        uMax: loop.uMax,
        v: anchorV,
        anchorV,
        dia: diaMm,
        role: 'column-hoop-inner-x',
      });
      return;
    }
    const targetDiaMm = Math.max(Number(targets.start.dia), Number(targets.end.dia), mainDiaMm);
    ties.push({
      type: 'LINE',
      axis: 'u',
      uMin: Number(targets.start.u),
      uMax: Number(targets.end.u),
      v: inwardTiePosition(anchorV, targetDiaMm, diaMm, loop.vMin, loop.vMax),
      anchorV,
      anchorMainDiaMm: targetDiaMm,
      constraintSide: 'CENTER_SIDE',
      restrainedStartBar: {
        u: Number(targets.start.u),
        v: Number(targets.start.v),
        dia: Number(targets.start.dia),
      },
      restrainedEndBar: {
        u: Number(targets.end.u),
        v: Number(targets.end.v),
        dia: Number(targets.end.dia),
      },
      dia: diaMm,
      role: 'column-hoop-inner-x',
    });
  });
  selectBaselineInnerLegSlotIndices(uAnchors.length, hoop.countY).forEach((index) => {
    const anchorU = uAnchors[index];
    const targets = extremeBarsOnAxis(firstLayer, 'v', anchorU);
    if (!Number.isFinite(anchorU)) return;
    if (!targets) {
      ties.push({
        type: 'LINE',
        axis: 'v',
        u: anchorU,
        vMin: loop.vMin,
        vMax: loop.vMax,
        anchorU,
        dia: diaMm,
        role: 'column-hoop-inner-y',
      });
      return;
    }
    const targetDiaMm = Math.max(Number(targets.start.dia), Number(targets.end.dia), mainDiaMm);
    ties.push({
      type: 'LINE',
      axis: 'v',
      u: inwardTiePosition(anchorU, targetDiaMm, diaMm, loop.uMin, loop.uMax),
      vMin: Number(targets.start.v),
      vMax: Number(targets.end.v),
      anchorU,
      anchorMainDiaMm: targetDiaMm,
      constraintSide: 'CENTER_SIDE',
      restrainedStartBar: {
        u: Number(targets.start.u),
        v: Number(targets.start.v),
        dia: Number(targets.start.dia),
      },
      restrainedEndBar: {
        u: Number(targets.end.u),
        v: Number(targets.end.v),
        dia: Number(targets.end.dia),
      },
      dia: diaMm,
      role: 'column-hoop-inner-y',
    });
  });
  return ties;
}

function buildRectColumnHoopSegment(sectionDetail, options, coverMm, diaName, pitch, hoopSet) {
  const dimensions = sectionDetail.dimensions;
  const dia = resolveBarDiameters(diaName, COLUMN_REBAR_PLACEMENT_RULES.defaultHoopDia);
  const inset = coverMm + dia.outerMm / 2;
  const nominalLoop = createRectLoop(
    -dimensions.width / 2 + inset,
    dimensions.width / 2 - inset,
    -dimensions.height / 2 + inset,
    dimensions.height / 2 - inset,
    dia.diaMm,
  );
  const arrangement = columnReferenceArrangement(sectionDetail);
  const facts = arrangement
    ? buildColumnArrangementFacts(sectionDetail.dimensions, arrangement, options)
    : null;
  const firstLayer = (facts?.mainBars || []).filter((bar) => Number(bar.layer) === 1);
  const loop = createRestrainingLoopFromBars(firstLayer, dia.diaMm) || nominalLoop;
  if (!loop) return null;
  const grade =
    hoopSet === 'secondary'
      ? sectionDetail.hoop?.grade2 || null
      : sectionDetail.hoop?.grade || null;
  loop.grade = grade;
  loop.restraintGeometrySource = firstLayer.length > 0 ? 'actual-main-bars' : 'cover-fallback';
  const ties = createColumnInnerTies(
    sectionDetail,
    options,
    loop,
    sectionDetail.hoop,
    dia.diaMm,
    facts,
  ).map((tie) => ({ ...tie, grade }));
  return createHoopSegment(0, 1, pitch, [loop], ties, { hoopSet, grade });
}

function buildCircleColumnHoopSegment(dimensions, coverMm, diaName, pitch, hoopSet) {
  const dia = resolveBarDiameters(diaName, COLUMN_REBAR_PLACEMENT_RULES.defaultHoopDia);
  const radius = dimensions.diameter / 2 - (coverMm + dia.outerMm / 2);
  if (!(radius > 0)) return null;
  return createHoopSegment(0, 1, pitch, [{ type: 'CIRCLE', radius, dia: dia.diaMm }], [], {
    hoopSet,
  });
}

export function computeColumnHoopSectionLayout(sectionDetail, options = {}) {
  const dimensions = sectionDetail?.dimensions;
  const hoop = sectionDetail?.hoop;
  if (!dimensions?.type || !hoop) return null;

  const pitch = normalizePitch(hoop.pitch);
  if (!pitch) return null;
  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const coverMm = options.coverMm ?? sectionDetail.cover ?? rules.defaultCoverMm;
  const segments = [];

  const primary =
    dimensions.type === 'CIRCLE'
      ? buildCircleColumnHoopSegment(dimensions, coverMm, hoop.dia, pitch, 'primary')
      : buildRectColumnHoopSegment(sectionDetail, options, coverMm, hoop.dia, pitch, 'primary');
  if (primary) segments.push(primary);

  const secondPitch = normalizePitch(hoop.pitch2);
  if (hoop.dia2 && secondPitch) {
    const secondary =
      dimensions.type === 'CIRCLE'
        ? buildCircleColumnHoopSegment(dimensions, coverMm, hoop.dia2, secondPitch, 'secondary')
        : buildRectColumnHoopSegment(
            sectionDetail,
            options,
            coverMm,
            hoop.dia2,
            secondPitch,
            'secondary',
          );
    if (secondary) segments.push(secondary);
  }
  if (segments.length === 0) return null;

  const primaryDia = resolveBarDiameters(hoop.dia, rules.defaultHoopDia);
  return {
    kind: 'columnHoop',
    shape: dimensions.type === 'CIRCLE' ? 'CIRCLE' : 'RECTANGLE',
    ...(dimensions.type === 'CIRCLE'
      ? { diameter: dimensions.diameter }
      : { width: dimensions.width, height: dimensions.height }),
    segments,
    coverMm,
    hoopDia: primaryDia.name,
    hoopGrade: hoop.grade || null,
    secondaryHoopDia: hoop.dia2 || null,
    estimated: true,
  };
}

function resolveBeamStirrupInnerAnchors(values, innerLegCount) {
  const count = Math.max(0, Number.parseInt(innerLegCount, 10) || 0);
  if (count === 0) return [];
  const sorted = uniqueSorted(values);
  if (sorted.length < count + 2) return [];
  const lastIndex = sorted.length - 1;
  const indices = [];
  for (let i = 1; i <= count; i += 1) {
    const minIndex = i;
    const maxIndex = lastIndex - (count - i) - 1;
    const targetIndex = Math.round((lastIndex * i) / (count + 1));
    indices.push(Math.max(minIndex, Math.min(maxIndex, targetIndex)));
  }
  return indices.map((index) => sorted[index]);
}

function commonBeamFirstLayerU(firstLayer) {
  const top = uniqueSorted(
    firstLayer.filter((bar) => bar.role === 'top').map((bar) => Number(bar.u)),
  );
  const bottom = uniqueSorted(
    firstLayer.filter((bar) => bar.role === 'bottom').map((bar) => Number(bar.u)),
  );
  return top.filter((u) => bottom.some((candidate) => Math.abs(candidate - u) < 1e-6));
}

function buildBeamInnerTies(position, positionFact, loop, diaMm) {
  const legCount = Number.parseInt(position?.stirrup?.count, 10) || 0;
  const innerLegCount = Math.max(0, legCount - 2);
  if (innerLegCount === 0) return { ties: [], unresolved: [] };

  const firstLayer = finiteBarFacts(positionFact?.mainBars).filter(
    (bar) => Number(bar.layer) === 1 && (bar.role === 'top' || bar.role === 'bottom'),
  );
  const sharedSlots = commonBeamFirstLayerU(firstLayer);
  const anchors = resolveBeamStirrupInnerAnchors(sharedSlots, innerLegCount);
  const fallbackAnchors =
    anchors.length === innerLegCount
      ? anchors
      : sharedSlots.length > 0 && legCount >= sharedSlots.length * 2
        ? evenlySpaced(loop.uMin, loop.uMax, legCount).slice(1, -1)
        : [];
  if (fallbackAnchors.length !== innerLegCount) {
    return {
      ties: [],
      unresolved: [
        `stirrup-inner-leg-pair-unresolved:required=${innerLegCount}:shared-slots=${sharedSlots.length}`,
      ],
    };
  }

  const ties = fallbackAnchors
    .map((anchorU) => {
      const targets = extremeBarsOnAxis(firstLayer, 'v', anchorU);
      if (!targets) {
        return {
          type: 'LINE',
          axis: 'v',
          u: anchorU,
          vMin: loop.vMin,
          vMax: loop.vMax,
          anchorU,
          dia: diaMm,
          role: 'beam-stirrup-inner',
        };
      }
      const targetDiaMm = Math.max(Number(targets.start.dia), Number(targets.end.dia));
      return {
        type: 'LINE',
        axis: 'v',
        u: inwardTiePosition(anchorU, targetDiaMm, diaMm, loop.uMin, loop.uMax),
        vMin: Number(targets.start.v),
        vMax: Number(targets.end.v),
        anchorU,
        anchorMainDiaMm: targetDiaMm,
        constraintSide: 'CENTER_SIDE',
        restrainedStartBar: {
          u: Number(targets.start.u),
          v: Number(targets.start.v),
          dia: Number(targets.start.dia),
        },
        restrainedEndBar: {
          u: Number(targets.end.u),
          v: Number(targets.end.v),
          dia: Number(targets.end.dia),
        },
        dia: diaMm,
        role: 'beam-stirrup-inner',
      };
    })
    .filter(Boolean);

  if (ties.length !== innerLegCount) {
    return {
      ties: [],
      unresolved: [
        `stirrup-inner-leg-target-unresolved:required=${innerLegCount}:resolved=${ties.length}`,
      ],
    };
  }
  return { ties, unresolved: [] };
}

function buildPositionLoop(position, fallbackCover, options, depth, positionFact) {
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
  const grade = position.stirrup?.grade || null;
  const half = dia.outerMm / 2;
  const nominalLoop = createRectLoop(
    -width / 2 + coverSide + half,
    width / 2 - coverSide - half,
    -depth / 2 + coverBottom + half,
    depth / 2 - coverTop - half,
    dia.diaMm,
  );
  const firstLayer = finiteBarFacts(positionFact?.mainBars).filter(
    (bar) => Number(bar.layer) === 1 && (bar.role === 'top' || bar.role === 'bottom'),
  );
  const loop = createRestrainingLoopFromBars(firstLayer, dia.diaMm) || nominalLoop;
  if (!loop) return null;
  loop.grade = grade;
  loop.restraintGeometrySource = firstLayer.length > 0 ? 'actual-main-bars' : 'cover-fallback';

  const innerTieResult = buildBeamInnerTies(position, positionFact, loop, dia.diaMm);
  const ties = innerTieResult.ties.map((tie) => ({ ...tie, grade }));
  return {
    loop,
    ties,
    pitch,
    diaName: dia.name,
    coverMm: coverTop,
    grade,
    declaredStirrupLegCount: Number.parseInt(position?.stirrup?.count, 10) || 0,
    stirrupUnresolved: innerTieResult.unresolved,
  };
}

function selectEvenlyDistributed(values, count) {
  const sorted = uniqueSorted(values);
  const target = Math.max(0, Math.min(sorted.length, Number.parseInt(count, 10) || 0));
  if (target === 0) return [];
  if (target >= sorted.length) return sorted;
  if (target === 1) return [sorted[Math.floor(sorted.length / 2)]];
  return Array.from({ length: target }, (_, index) => {
    const sourceIndex = Math.round((index * (sorted.length - 1)) / (target - 1));
    return sorted[sourceIndex];
  }).filter((value, index, array) => array.indexOf(value) === index);
}

function buildWidthTieSegment(position, range, positionFact, options) {
  const resolution = resolveBeamWidthTie(position, options.auxiliaryPolicy);
  if (resolution.status !== 'resolved') {
    return {
      segment: null,
      unresolved: resolution.status === 'unresolved' ? resolution.unresolved : [],
    };
  }
  const widthTie = resolution.value;
  const diaMm = barDiameterMm(widthTie.dia, 0);
  if (!(diaMm > 0)) {
    return { segment: null, unresolved: ['width-tie-invalid-diameter'] };
  }

  const webBars = positionFact?.webBars || [];
  const availableLevels = uniqueSorted(webBars.map((bar) => Number(bar.v)));
  if (availableLevels.length === 0) {
    return { segment: null, unresolved: ['width-tie-without-web-bars'] };
  }
  const requestedCount = Number.parseInt(widthTie.count, 10) || 0;
  if (requestedCount > availableLevels.length) {
    return {
      segment: null,
      unresolved: [
        `width-tie-count-exceeds-web-levels:${requestedCount}>${availableLevels.length}`,
      ],
    };
  }

  const levels = selectEvenlyDistributed(availableLevels, requestedCount);
  const ties = [];
  for (const v of levels) {
    const sameLevel = webBars.filter((bar) => Math.abs(Number(bar.v) - v) < 1e-6);
    const us = sameLevel
      .map((bar) => Number(bar.u))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (us.length < 2 || !(us.at(-1) > us[0])) continue;
    ties.push({
      type: 'LINE',
      axis: 'u',
      uMin: us[0],
      uMax: us.at(-1),
      v,
      dia: diaMm,
      diaName: widthTie.dia,
      grade: widthTie.grade || null,
      role: 'beam-width-tie',
      positionSource: resolution.source,
    });
  }
  if (ties.length !== levels.length) {
    return { segment: null, unresolved: ['width-tie-without-paired-web-bars'] };
  }

  return {
    segment: createHoopSegment(range.startRatio, range.endRatio, widthTie.pitch, [], ties, {
      positionZone: range.key,
      auxiliaryRole: 'widthTie',
      positionSource: resolution.source,
      grade: widthTie.grade || null,
    }),
    unresolved: [],
  };
}

export function computeBeamStirrupSectionLayout(sectionDetail, options = {}) {
  const keys = orderedPositionKeys(sectionDetail);
  if (keys.length === 0) return null;
  const depth = sectionDetail.positions[keys[0]]?.depth || 0;
  if (depth <= 0) return null;

  const ranges = resolveSpanRanges(keys);
  const segments = [];
  const stirrupUnresolved = [];
  const auxiliarySegments = [];
  const auxiliaryUnresolved = [];
  let meta = null;
  const mainLayout = computeBeamRebarSectionLayout(sectionDetail, options);

  for (const range of ranges) {
    const positionFact = mainLayout?.positionFacts?.[range.key];
    const built = buildPositionLoop(
      sectionDetail.positions[range.key],
      sectionDetail.cover,
      options,
      depth,
      positionFact,
    );
    if (!built) continue;
    const positionUnresolved = built.stirrupUnresolved || [];
    stirrupUnresolved.push(...positionUnresolved.map((reason) => `${range.key}:${reason}`));
    segments.push(
      createHoopSegment(range.startRatio, range.endRatio, built.pitch, [built.loop], built.ties, {
        positionZone: range.key,
        grade: built.grade,
        declaredStirrupLegCount: built.declaredStirrupLegCount,
        stirrupLegsResolved: positionUnresolved.length === 0,
        stirrupUnresolved: positionUnresolved,
      }),
    );
    meta = meta || built;
  }

  for (const range of ranges) {
    const result = buildWidthTieSegment(
      sectionDetail.positions[range.key],
      range,
      mainLayout?.positionFacts?.[range.key],
      options,
    );
    if (result.segment) auxiliarySegments.push(result.segment);
    auxiliaryUnresolved.push(...result.unresolved.map((reason) => `${range.key}:${reason}`));
  }

  if (segments.length === 0 && auxiliarySegments.length === 0) return null;

  return {
    kind: 'beamStirrup',
    shape: 'RECTANGLE',
    depth,
    segments,
    stirrupUnresolved,
    auxiliarySegments,
    auxiliaryUnresolved,
    positionPattern: sectionDetail.positionPattern || 'SAME',
    coverMm: meta?.coverMm ?? options.coverMm ?? BEAM_REBAR_PLACEMENT_RULES.defaultCoverMm,
    stirrupDia: meta?.diaName ?? null,
    stirrupGrade: meta?.grade ?? null,
    estimated: true,
  };
}

export function buildColumnHoopLayoutMap(xmlDoc, options = {}) {
  const layouts = new Map();
  if (!xmlDoc) return layouts;
  for (const [sectionId, detail] of extractRcColumnSections(xmlDoc)) {
    const layout = computeColumnHoopSectionLayout(detail, options);
    if (layout) layouts.set(sectionId, layout);
  }
  return layouts;
}

export function buildBeamStirrupLayoutMaps(xmlDoc, options = {}) {
  const girder = new Map();
  const beam = new Map();
  if (!xmlDoc) return { girder, beam };
  const auxiliaryPolicy = resolveBeamAuxiliaryApplyPolicy(xmlDoc);
  const resolvedOptions = { ...options, auxiliaryPolicy };

  for (const tagName of ['StbSecGirder_RC', 'StbSecBeam_RC']) {
    for (const element of querySelectorAll(xmlDoc, tagName)) {
      const detail = extractRcBeamSectionDetail(element);
      if (!detail?.id) continue;
      const layout = computeBeamStirrupSectionLayout(detail, resolvedOptions);
      if (!layout) continue;
      (isGirderSection(element) ? girder : beam).set(detail.id, layout);
    }
  }
  return { girder, beam };
}
