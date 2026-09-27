/**
 * @fileoverview 柱帯筋を一般部と仕口部（柱・梁接合部）へ区間化する。
 *
 * 日建連・JSCA 2023 §7-2 に従い、仕口部の範囲は柱に取り付く全ての梁せいが
 * 重なる範囲とする。仕口部帯筋の配筋要領・間隔は構造図によるため、共通設定で
 * 明示されない限り一般部帯筋を無言で仕口部へ流用しない。
 *
 * R6では§7-4-1の柱主筋を折り曲げて通す仕口について、上階柱の第1帯筋を
 * 上階柱帯筋と同径・同形状の2組重ねとしてproductionレイアウトへ追加する。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { collectBeamLevelsAtNode, createTagScanner, getNodeCoord } from '../columnSupportUtils.js';
import { querySelectorAll } from '../sectionListUtils.js';
import { buildBeamRebarLayoutMaps } from './beamRebarPlacement.js';
import { buildColumnJointRenderPlan } from './columnJointRenderPlan.js';
import { buildColumnRebarLayoutMap } from './columnRebarPlacement.js';
import { buildColumnHoopLayoutMap } from './hoopPlacement.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { applyAppendixA2JointHoopConstructionToLayout } from './rebarAppendixA2JointProductionChoice.js';

const EPS = 1e-6;
const POSITION_HALF_WINDOW_RATIO = 1e-8;
const COLUMN_TAGS = ['StbColumn', 'StbPost'];
const BEAM_TAGS = ['StbGirder', 'StbBeam'];
const JOINT_HOOP_FALLBACK_DIAMETERS = Object.freeze([
  'D10',
  'D13',
  'D16',
  'D19',
  'D22',
  'D25',
  'D29',
  'D32',
  'D35',
  'D38',
  'D41',
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readOffsetZ(element, prefix) {
  return parseFloat(element?.getAttribute(`${prefix}_Z`)) || 0;
}

function resolveColumnAxialRange(scanTag, columnEl, index = null) {
  const bottomNodeId = columnEl.getAttribute('id_node_bottom');
  const topNodeId = columnEl.getAttribute('id_node_top');
  const bottom = getNodeCoord(scanTag, bottomNodeId, index);
  const top = getNodeCoord(scanTag, topNodeId, index);
  if (!bottom || !top) return null;

  const bottomZ = bottom.z + readOffsetZ(columnEl, 'offset_bottom');
  const topZ = top.z + readOffsetZ(columnEl, 'offset_top');
  const lengthMm = topZ - bottomZ;
  if (!(lengthMm > EPS)) return null;
  return { bottomNodeId, topNodeId, bottomZ, topZ, lengthMm };
}

function attachedBeamDirections(scanTag, nodeId, index = null) {
  const directions = [];
  const processBeam = (beamEl, endpoint = null) => {
    const kind = beamEl.getAttribute('kind_structure');
    if (kind && kind !== 'RC' && kind !== 'SRC') return;

    const isStart = endpoint
      ? endpoint === 'start'
      : beamEl.getAttribute('id_node_start') === nodeId;
    const isEnd = endpoint ? endpoint === 'end' : beamEl.getAttribute('id_node_end') === nodeId;
    if (!isStart && !isEnd) return;

    const otherNodeId = beamEl.getAttribute(isStart ? 'id_node_end' : 'id_node_start');
    const node = getNodeCoord(scanTag, nodeId, index);
    const other = getNodeCoord(scanTag, otherNodeId, index);
    if (!node || !other) return;
    const dx = other.x - node.x;
    const dy = other.y - node.y;
    const length = Math.hypot(dx, dy);
    if (!(length > EPS)) return;
    directions.push({ x: dx / length, y: dy / length });
  };

  if (index?.beamsByNodeId instanceof Map) {
    for (const connection of index.beamsByNodeId.get(String(nodeId)) || []) {
      processBeam(connection.element, connection.endpoint);
    }
  } else {
    for (const tagName of BEAM_TAGS) {
      for (const beamEl of scanTag(tagName)) {
        processBeam(beamEl);
      }
    }
  }
  return directions;
}

function hasOrthogonalBeamPair(scanTag, nodeId, tolerance, index = null) {
  const directions = attachedBeamDirections(scanTag, nodeId, index);
  for (let i = 0; i < directions.length; i++) {
    for (let j = i + 1; j < directions.length; j++) {
      const dot = Math.abs(directions[i].x * directions[j].x + directions[i].y * directions[j].y);
      if (dot <= tolerance) return true;
    }
  }
  return false;
}

/**
 * 1節点の仕口部範囲を柱部材内の実寸位置へ変換する。
 *
 * 直交梁の有無にかかわらず梁せい範囲は解決して一般部から除外する。
 * 直交梁なしの場合、標準既定では仕口部帯筋を追加しないため、その判定情報を
 * orthogonalBeamPair に保持する。
 */
function resolveJointZone({ scanTag, nodeId, axialRange, rule, index = null }) {
  const orthogonalBeamPair = hasOrthogonalBeamPair(
    scanTag,
    nodeId,
    rule.orthogonalDotTolerance,
    index,
  );
  const levels = collectBeamLevelsAtNode(scanTag, nodeId, index);
  if (!levels) return null;
  const overlapBottomZ = levels.highestBottomZ;
  const overlapTopZ = levels.lowestTopZ;
  if (!(overlapTopZ > overlapBottomZ + EPS)) return null;

  const clippedBottomZ = Math.max(overlapBottomZ, axialRange.bottomZ);
  const clippedTopZ = Math.min(overlapTopZ, axialRange.topZ);
  if (!(clippedTopZ > clippedBottomZ + EPS)) return null;

  return {
    nodeId,
    startMm: clippedBottomZ - axialRange.bottomZ,
    endMm: clippedTopZ - axialRange.bottomZ,
    sourceBottomZ: overlapBottomZ,
    sourceTopZ: overlapTopZ,
    beamCount: levels.count,
    orthogonalBeamPair,
  };
}

function mergeZones(zones) {
  const sorted = zones.filter(Boolean).sort((a, b) => a.startMm - b.startMm);
  const result = [];
  for (const zone of sorted) {
    const previous = result[result.length - 1];
    if (!previous || zone.startMm > previous.endMm + EPS) {
      result.push({ ...zone, nodeIds: [zone.nodeId] });
      continue;
    }
    previous.endMm = Math.max(previous.endMm, zone.endMm);
    previous.nodeIds.push(zone.nodeId);
    previous.sourceBottomZ = Math.min(previous.sourceBottomZ, zone.sourceBottomZ);
    previous.sourceTopZ = Math.max(previous.sourceTopZ, zone.sourceTopZ);
    previous.beamCount = Math.max(previous.beamCount, zone.beamCount);
    previous.orthogonalBeamPair = previous.orthogonalBeamPair || zone.orthogonalBeamPair;
  }
  return result;
}

function generalIntervals(lengthMm, jointZones) {
  const intervals = [];
  let cursor = 0;
  for (const zone of jointZones) {
    if (zone.startMm > cursor + EPS) {
      intervals.push({ startMm: cursor, endMm: zone.startMm });
    }
    cursor = Math.max(cursor, zone.endMm);
  }
  if (cursor < lengthMm - EPS) intervals.push({ startMm: cursor, endMm: lengthMm });
  return intervals;
}

function positionsFromStart(startMm, endMm, pitchMm) {
  if (!(pitchMm > 0) || endMm < startMm - EPS) return [];
  const values = [];
  for (let value = startMm; value <= endMm + EPS; value += pitchMm) {
    values.push(Math.min(value, endMm));
  }
  return values;
}

function positionsFromEnd(startMm, endMm, pitchMm) {
  if (!(pitchMm > 0) || endMm < startMm - EPS) return [];
  const values = [];
  for (let value = endMm; value >= startMm - EPS; value -= pitchMm) {
    values.push(Math.max(value, startMm));
  }
  values.reverse();
  return values;
}

function exactPositionSegment(positionMm, lengthMm, sourceSegment, zoneKind) {
  const positionRatio = clamp(positionMm / lengthMm, 0, 1);
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
    zoneKind,
  };
}

/**
 * 同一帯筋種の同一材軸位置だけを重複排除する。
 * 異径・異ピッチの第2帯筋種は同位置でも別筋なので sourceKey を分けて保持する。
 */
function addPosition(positionMap, sourceKey, positionMm, lengthMm, sourceSegment, zoneKind) {
  const key = `${sourceKey}:${Math.round(positionMm * 1000)}`;
  const existing = positionMap.get(key);
  if (existing && existing.zoneKind === 'joint') return;
  const segment = exactPositionSegment(positionMm, lengthMm, sourceSegment, zoneKind);
  if (segment) positionMap.set(key, segment);
}

function sourceSegmentKey(segment, index) {
  return `source:${index}:${segment.hoopSet || ''}`;
}

function barAreaMm2(diaNameOrMm) {
  const diaMm = barDiameterMm(diaNameOrMm, 0);
  return diaMm > 0 ? (Math.PI * diaMm * diaMm) / 4 : 0;
}

function renderedHoopLegCounts(segment) {
  const loops = Array.isArray(segment?.loops) ? segment.loops : [];
  const ties = Array.isArray(segment?.ties) ? segment.ties : [];
  const rectLoop = loops.find((loop) => loop?.type === 'RECT');
  const circleLoop = loops.find((loop) => loop?.type === 'CIRCLE');
  if (!rectLoop && !circleLoop) return null;

  return {
    x: 2 + ties.filter((tie) => tie?.axis === 'u').length,
    y: 2 + ties.filter((tie) => tie?.axis === 'v').length,
  };
}

function resolveStandardJointHoopDiameter(requiredAreaMm2, minimumDiaMm) {
  for (const name of JOINT_HOOP_FALLBACK_DIAMETERS) {
    const diaMm = barDiameterMm(name, 0);
    if (!(diaMm > 0) || diaMm + EPS < minimumDiaMm) continue;
    if (barAreaMm2(diaMm) + EPS < requiredAreaMm2) continue;
    return { name, diaMm, areaMm2: barAreaMm2(diaMm) };
  }
  return null;
}

function retargetRectLoopDiameter(loop, targetDia) {
  const oldDiaMm = Number(loop?.dia);
  if (!(oldDiaMm > 0) || !(targetDia?.diaMm > 0)) return null;

  const next = { ...loop, dia: targetDia.diaMm };
  if (loop.restraintGeometrySource === 'actual-main-bars') {
    const delta = (targetDia.diaMm - oldDiaMm) / 2;
    next.uMin = Number(loop.uMin) - delta;
    next.uMax = Number(loop.uMax) + delta;
    next.vMin = Number(loop.vMin) - delta;
    next.vMax = Number(loop.vMax) + delta;
  } else {
    const oldOuterMm = barOuterDiameterMm(`D${oldDiaMm}`, oldDiaMm);
    const newOuterMm = barOuterDiameterMm(targetDia.name, targetDia.diaMm);
    const delta = (newOuterMm - oldOuterMm) / 2;
    next.uMin = Number(loop.uMin) + delta;
    next.uMax = Number(loop.uMax) - delta;
    next.vMin = Number(loop.vMin) + delta;
    next.vMax = Number(loop.vMax) - delta;
  }

  if (!(next.uMax > next.uMin + EPS) || !(next.vMax > next.vMin + EPS)) return null;
  return next;
}

function retargetCircleLoopDiameter(loop, targetDia) {
  const oldDiaMm = Number(loop?.dia);
  if (!(oldDiaMm > 0) || !(targetDia?.diaMm > 0)) return null;
  const oldOuterMm = barOuterDiameterMm(`D${oldDiaMm}`, oldDiaMm);
  const newOuterMm = barOuterDiameterMm(targetDia.name, targetDia.diaMm);
  const radius = Number(loop.radius) - (newOuterMm - oldOuterMm) / 2;
  if (!(radius > EPS)) return null;
  return { ...loop, radius, dia: targetDia.diaMm };
}

function retargetTieDiameter(tie, targetDia, referenceLoop) {
  const next = { ...tie, dia: targetDia.diaMm };
  if (!referenceLoop || referenceLoop.type !== 'RECT') return next;

  if (tie?.constraintSide === 'CENTER_SIDE' && Number(tie?.anchorMainDiaMm) > 0) {
    const mainDiaMm = Number(tie.anchorMainDiaMm);
    if (tie.axis === 'u' && Number.isFinite(Number(tie.anchorV))) {
      const anchor = Number(tie.anchorV);
      const direction = anchor <= 0 ? 1 : -1;
      next.v = clamp(
        anchor + direction * (mainDiaMm / 2 + targetDia.diaMm / 2),
        referenceLoop.vMin,
        referenceLoop.vMax,
      );
    } else if (tie.axis === 'v' && Number.isFinite(Number(tie.anchorU))) {
      const anchor = Number(tie.anchorU);
      const direction = anchor <= 0 ? 1 : -1;
      next.u = clamp(
        anchor + direction * (mainDiaMm / 2 + targetDia.diaMm / 2),
        referenceLoop.uMin,
        referenceLoop.uMax,
      );
    }
    return next;
  }

  if (tie.axis === 'u') {
    next.uMin = referenceLoop.uMin;
    next.uMax = referenceLoop.uMax;
  } else if (tie.axis === 'v') {
    next.vMin = referenceLoop.vMin;
    next.vMax = referenceLoop.vMax;
  }
  return next;
}

function retargetHoopSegmentDiameter(segment, targetDia) {
  const loops = [];
  for (const loop of segment?.loops || []) {
    const next =
      loop?.type === 'RECT'
        ? retargetRectLoopDiameter(loop, targetDia)
        : loop?.type === 'CIRCLE'
          ? retargetCircleLoopDiameter(loop, targetDia)
          : { ...loop, dia: targetDia.diaMm };
    if (!next) return null;
    loops.push(next);
  }
  if (loops.length === 0) return null;

  const referenceLoop = loops.find((loop) => loop?.type === 'RECT') || loops[0];
  const ties = (segment?.ties || []).map((tie) =>
    retargetTieDiameter(tie, targetDia, referenceLoop),
  );
  return {
    ...segment,
    loops,
    ties,
    fallbackHoopDia: targetDia.name,
  };
}

/**
 * STB/構造図から仕口部帯筋を解決できない場合の project fallback。
 *
 * 柱一般部のprimary帯筋ピッチと、実際に3D生成するX/Y方向脚数を継承し、
 * pwX = awX / (Dy * s), pwY = awY / (Dx * s) をともに満たす最小JIS径を選ぶ。
 * 一般部帯筋より細い径には落とさない。
 */
export function resolveColumnJointHoopPwFallback(sectionLayout, primarySegment, targetPwRatio) {
  const ratio = Number(targetPwRatio);
  const pitchMm = Number(primarySegment?.pitch);
  if (![0.002, 0.003].includes(ratio)) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-ratio-unsupported' };
  }
  if (!(pitchMm > 0)) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-primary-pitch-unresolved' };
  }

  const counts = renderedHoopLegCounts(primarySegment);
  if (!counts || !(counts.x > 0) || !(counts.y > 0)) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-leg-count-unresolved' };
  }

  let widthX;
  let widthY;
  if (sectionLayout?.shape === 'RECTANGLE') {
    widthX = Number(sectionLayout.width);
    widthY = Number(sectionLayout.height);
  } else if (sectionLayout?.shape === 'CIRCLE') {
    widthX = Number(sectionLayout.diameter);
    widthY = Number(sectionLayout.diameter);
  }
  if (!(widthX > 0) || !(widthY > 0)) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-column-dimension-unresolved' };
  }

  const requiredAreaX = (ratio * widthY * pitchMm) / counts.x;
  const requiredAreaY = (ratio * widthX * pitchMm) / counts.y;
  const sourceLoop = (primarySegment.loops || []).find((loop) => Number(loop?.dia) > 0);
  const sourceDiaMm = Number(sourceLoop?.dia) || barDiameterMm(sectionLayout?.hoopDia, 0);
  if (!(sourceDiaMm > 0)) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-source-diameter-unresolved' };
  }

  const requiredAreaMm2 = Math.max(requiredAreaX, requiredAreaY, barAreaMm2(sourceDiaMm));
  const selected = resolveStandardJointHoopDiameter(requiredAreaMm2, sourceDiaMm);
  if (!selected) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-no-standard-diameter' };
  }

  const segment = retargetHoopSegmentDiameter(primarySegment, selected);
  if (!segment) {
    return { ok: false, reason: 'joint-hoop-pw-fallback-geometry-unresolved' };
  }

  const pwX = (counts.x * selected.areaMm2) / (widthY * pitchMm);
  const pwY = (counts.y * selected.areaMm2) / (widthX * pitchMm);
  const metadata = {
    source: 'project-pw-fallback',
    targetPwRatio: ratio,
    selectedDia: selected.name,
    selectedDiaMm: selected.diaMm,
    sourceDiaMm,
    pitchMm,
    legCountX: counts.x,
    legCountY: counts.y,
    widthX,
    widthY,
    pwX,
    pwY,
    formula: 'pwX=Nx*Ab/(Dy*s);pwY=Ny*Ab/(Dx*s)',
  };
  return {
    ok: true,
    reason: null,
    pitchMm,
    segment: { ...segment, jointHoopPwFallback: metadata },
    metadata,
  };
}

/**
 * 1柱の帯筋レイアウトを一般部／仕口部へ展開する。
 *
 * R4では第2帯筋種を含む全一般部segmentを独立した径・ピッチで展開する。
 * 仕口部の構造図依存ルールは従来どおりprimary segmentの形状だけを基準とする。
 */
export function materializeColumnHoopLayout(sectionLayout, axialRange, jointZones, rule) {
  const sourceSegments = (sectionLayout?.segments || []).filter(
    (segment) => Number(segment?.pitch) > 0,
  );
  const primarySegment = sourceSegments[0];
  if (!primarySegment || !(axialRange?.lengthMm > 0)) return null;

  const mergedJointZones = mergeZones(jointZones);
  if (mergedJointZones.length === 0) {
    return {
      ...sectionLayout,
      memberSpecific: true,
      memberLengthMm: axialRange.lengthMm,
      jointHoopSource: rule.standardId,
      unresolvedJointZones: [],
      suppressedJointZones: [],
    };
  }

  const positionMap = new Map();
  const intervals = generalIntervals(axialRange.lengthMm, mergedJointZones);
  sourceSegments.forEach((sourceSegment, sourceIndex) => {
    const sourceKey = sourceSegmentKey(sourceSegment, sourceIndex);
    for (const interval of intervals) {
      const positions = positionsFromEnd(interval.startMm, interval.endMm, sourceSegment.pitch);
      for (const positionMm of positions) {
        addPosition(
          positionMap,
          sourceKey,
          positionMm,
          axialRange.lengthMm,
          sourceSegment,
          'general',
        );
      }
    }
  });

  const explicitJointRule = Number(rule?.jointPitchMm) > 0 && rule?.useGeneralLoopGeometry === true;
  const fallbackRequested = [0.002, 0.003].includes(Number(rule?.fallbackPwRatio));
  const fallback =
    !explicitJointRule && fallbackRequested
      ? resolveColumnJointHoopPwFallback(sectionLayout, primarySegment, rule.fallbackPwRatio)
      : null;
  const jointSourceSegment = explicitJointRule
    ? primarySegment
    : fallback?.ok
      ? fallback.segment
      : null;
  const jointPitchMm = explicitJointRule ? Number(rule.jointPitchMm) : fallback?.pitchMm;
  const canGenerateJoint = Boolean(jointSourceSegment && Number(jointPitchMm) > 0);

  if (canGenerateJoint) {
    const primaryKey = explicitJointRule
      ? sourceSegmentKey(primarySegment, 0)
      : `pw-fallback:${fallback.metadata.selectedDia}:${fallback.metadata.targetPwRatio}`;
    for (const zone of mergedJointZones) {
      const positions = positionsFromStart(zone.startMm, zone.endMm, jointPitchMm);
      if (positions.length === 0 || zone.endMm - positions[positions.length - 1] > EPS) {
        positions.push(zone.endMm);
      }
      for (const positionMm of positions) {
        addPosition(
          positionMap,
          primaryKey,
          positionMm,
          axialRange.lengthMm,
          jointSourceSegment,
          'joint',
        );
      }
    }
  }

  const segments = [...positionMap.values()].sort(
    (a, b) =>
      a.positionRatio - b.positionRatio ||
      String(a.hoopSet || '').localeCompare(String(b.hoopSet || '')),
  );
  const unresolvedReason = fallbackRequested
    ? fallback?.reason || 'joint-hoop-pw-fallback-unresolved'
    : 'joint-hoop-detail-and-pitch-require-structural-drawing';
  const unresolvedJointZones = canGenerateJoint
    ? []
    : mergedJointZones
        .filter((zone) => fallbackRequested || zone.orthogonalBeamPair)
        .map((zone) => ({
          ...zone,
          reason: unresolvedReason,
          specialRequired: true,
        }));
  const suppressedJointZones =
    canGenerateJoint || fallbackRequested
      ? []
      : mergedJointZones
          .filter((zone) => !zone.orthogonalBeamPair)
          .map((zone) => ({
            ...zone,
            reason: 'joint-hoop-not-applied-without-orthogonal-beam-by-default',
            specialRequired: false,
          }));

  return {
    ...sectionLayout,
    memberSpecific: true,
    memberLengthMm: axialRange.lengthMm,
    jointHoopSource: rule.standardId,
    jointHoopRule: rule,
    jointHoopPwFallback: fallback?.ok ? fallback.metadata : null,
    unresolvedJointZones,
    suppressedJointZones,
    segments,
  };
}

function primaryHoopSegments(layout) {
  const segments = Array.isArray(layout?.segments) ? layout.segments : [];
  const explicitPrimary = segments.filter((segment) => segment?.hoopSet === 'primary');
  return explicitPrimary.length > 0
    ? explicitPrimary
    : segments.filter((segment) => !segment?.hoopSet);
}

/**
 * 現行rendererの区間内中央寄せ規則と同じ式で、1区間目の最初の帯筋位置を解決する。
 * exact segmentが既にある場合はその一般部位置をそのまま採用する。
 */
function resolveFirstPrimaryHoop(layout) {
  const lengthMm = Number(layout?.memberLengthMm);
  if (!(lengthMm > 0)) return null;
  const candidates = primaryHoopSegments(layout);
  if (candidates.length === 0) return null;

  const exactGeneral = candidates
    .filter(
      (segment) =>
        segment?.exactAxialPosition &&
        segment?.zoneKind !== 'joint' &&
        Number.isFinite(Number(segment.positionRatio)),
    )
    .sort((a, b) => Number(a.positionRatio) - Number(b.positionRatio));
  if (exactGeneral.length > 0) {
    return {
      sourceSegment: exactGeneral[0],
      positionRatio: Number(exactGeneral[0].positionRatio),
      positionMm: Number(exactGeneral[0].positionRatio) * lengthMm,
    };
  }

  const source = candidates
    .filter(
      (segment) =>
        !segment?.exactAxialPosition &&
        Number(segment?.pitch) > 0 &&
        Number.isFinite(Number(segment?.startRatio)) &&
        Number.isFinite(Number(segment?.endRatio)) &&
        Number(segment.endRatio) > Number(segment.startRatio),
    )
    .sort((a, b) => Number(a.startRatio) - Number(b.startRatio))[0];
  if (!source) return null;

  const startMm = lengthMm * Number(source.startRatio);
  const segmentLengthMm = lengthMm * (Number(source.endRatio) - Number(source.startRatio));
  const pitchMm = Number(source.pitch);
  const count = Math.max(1, Math.floor(segmentLengthMm / pitchMm));
  const spreadMm = (count - 1) * pitchMm;
  const positionMm = startMm + (segmentLengthMm - spreadMm) / 2;
  return {
    sourceSegment: source,
    positionMm,
    positionRatio: positionMm / lengthMm,
  };
}

function firstHoopOverlapSegment(layout, resolved, requirement, overlapSetIndex) {
  const segment = exactPositionSegment(
    resolved.positionMm,
    Number(layout.memberLengthMm),
    resolved.sourceSegment,
    resolved.sourceSegment.zoneKind || 'general',
  );
  if (!segment) return null;
  return {
    ...segment,
    firstHoopOverlap: true,
    overlapSetIndex,
    requiredSets: requirement.requiredSets,
    sourceNodeId: requirement.nodeId,
    ruleId: requirement.ruleId || '7-4-1',
  };
}

/**
 * §7-4-1「柱主筋を折り曲げて通し筋とする場合」の梁上第1帯筋2組重ねを
 * 上階柱のproduction帯筋レイアウトへ反映する。
 *
 * 元の第1帯筋を1組目として保持し、同一位置・同一径・同一形状の追加segmentを
 * requiredSets - 1 個だけ重ねる。primary帯筋以外や別定着仕口には適用しない。
 */
export function applyColumnJointFirstHoopRequirements(layoutMap, requirements = []) {
  const statuses = [];
  // 空Mapでも要求は処理し、対象柱の帯筋欠損を未解決statusとして残す。
  if (!layoutMap || !Array.isArray(requirements) || requirements.length === 0) {
    if (layoutMap) layoutMap.firstHoopRequirements = statuses;
    return statuses;
  }

  for (const requirement of requirements) {
    const upperColumnId = String(requirement?.upperColumnId || '');
    const requiredSets = Number.parseInt(requirement?.requiredSets, 10);
    const baseStatus = {
      ...requirement,
      upperColumnId,
      generated: false,
      generatedSets: 0,
      unresolvedReason: null,
    };
    if (!upperColumnId || !(requiredSets >= 2)) {
      statuses.push({ ...baseStatus, unresolvedReason: 'invalid-first-hoop-requirement' });
      continue;
    }

    const layout = layoutMap.get(upperColumnId);
    if (!layout) {
      statuses.push({ ...baseStatus, unresolvedReason: 'upper-column-hoop-layout-unresolved' });
      continue;
    }

    const existingOverlaps = (layout.segments || []).filter(
      (segment) =>
        segment?.firstHoopOverlap &&
        String(segment.sourceNodeId || '') === String(requirement.nodeId || ''),
    );
    if (existingOverlaps.length >= requiredSets - 1) {
      const resolved = resolveFirstPrimaryHoop(layout);
      statuses.push({
        ...baseStatus,
        generated: true,
        generatedSets: requiredSets,
        firstPositionRatio: resolved?.positionRatio ?? null,
        firstPositionMm: resolved?.positionMm ?? null,
      });
      continue;
    }

    const resolved = resolveFirstPrimaryHoop(layout);
    if (!resolved) {
      statuses.push({ ...baseStatus, unresolvedReason: 'upper-column-first-hoop-unresolved' });
      continue;
    }

    const additions = [];
    for (
      let overlapSetIndex = existingOverlaps.length + 2;
      overlapSetIndex <= requiredSets;
      overlapSetIndex += 1
    ) {
      const segment = firstHoopOverlapSegment(layout, resolved, requirement, overlapSetIndex);
      if (!segment) break;
      additions.push(segment);
    }
    if (additions.length !== requiredSets - 1 - existingOverlaps.length) {
      statuses.push({ ...baseStatus, unresolvedReason: 'first-hoop-overlap-segment-unresolved' });
      continue;
    }

    const segments = [...(layout.segments || []), ...additions].sort(
      (a, b) =>
        (Number(a.positionRatio) || 0) - (Number(b.positionRatio) || 0) ||
        String(a.hoopSet || '').localeCompare(String(b.hoopSet || '')) ||
        Number(a.overlapSetIndex || 1) - Number(b.overlapSetIndex || 1),
    );
    layoutMap.set(upperColumnId, {
      ...layout,
      segments,
      firstHoopOverlap: {
        nodeId: requirement.nodeId,
        requiredSets,
        generatedSets: requiredSets,
        positionRatio: resolved.positionRatio,
        positionMm: resolved.positionMm,
        ruleId: requirement.ruleId || '7-4-1',
      },
    });
    statuses.push({
      ...baseStatus,
      generated: true,
      generatedSets: requiredSets,
      firstPositionRatio: resolved.positionRatio,
      firstPositionMm: resolved.positionMm,
    });
  }

  layoutMap.firstHoopRequirements = statuses;
  return statuses;
}

function buildJointFirstHoopRequirements(xmlDoc, scanTag, options) {
  const columnMainLayouts = buildColumnRebarLayoutMap(xmlDoc, options);
  const beamMainLayouts = buildBeamRebarLayoutMaps(xmlDoc, options);
  if (columnMainLayouts.size === 0) return [];
  return buildColumnJointRenderPlan(xmlDoc, columnMainLayouts, beamMainLayouts, {
    scanTag,
    projectDetailing: options.projectDetailing,
    modelSource: options.modelSource,
  }).firstHoopRequirements;
}

/**
 * RC柱帯筋を要素ID単位で仕口部対応レイアウトへ変換する。
 */
export function buildColumnHoopMemberLayoutMap(xmlDoc, options = {}) {
  const result = new Map();
  if (!xmlDoc) return result;

  const sectionLayouts = buildColumnHoopLayoutMap(xmlDoc, options);
  const scanTag = createTagScanner(xmlDoc);
  const modelIndex = buildRebarModelIndex(xmlDoc, { scanTag });
  const rule = REBAR_STANDARD_RULES.resolveColumnJointHoopRule();
  const choice =
    options.choice ??
    options.commonConfig?.detailing?.choice ??
    getRebarCommonConfig().detailing?.choice;
  result.lookupKey = 'elementId';

  for (const tagName of COLUMN_TAGS) {
    for (const columnEl of querySelectorAll(xmlDoc, tagName)) {
      const elementId = columnEl.getAttribute('id');
      const sectionId = columnEl.getAttribute('id_section');
      if (!elementId || !sectionId) continue;
      const sectionLayout = sectionLayouts.get(String(sectionId));
      if (!sectionLayout) continue;

      const axialRange = resolveColumnAxialRange(scanTag, columnEl, modelIndex);
      if (!axialRange) continue;
      const jointZones = [
        resolveJointZone({
          scanTag,
          nodeId: axialRange.bottomNodeId,
          axialRange,
          rule,
          index: modelIndex,
        }),
        resolveJointZone({
          scanTag,
          nodeId: axialRange.topNodeId,
          axialRange,
          rule,
          index: modelIndex,
        }),
      ];
      const layout = materializeColumnHoopLayout(sectionLayout, axialRange, jointZones, rule);
      if (layout) {
        result.set(String(elementId), applyAppendixA2JointHoopConstructionToLayout(layout, choice));
      }
    }
  }

  const requirements = buildJointFirstHoopRequirements(xmlDoc, scanTag, options);
  applyColumnJointFirstHoopRequirements(result, requirements);
  return result;
}
