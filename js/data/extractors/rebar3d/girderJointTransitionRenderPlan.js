/**
 * @fileoverview R7-B: 大梁§8-3のproduction描画計画。
 *
 * STRAIGHT_THROUGH は既存左右梁主筋を節点で連続させ、梁端offsetで柱面止まりとなる場合は
 * その間をworld RebarPathで補い、§8-2個別定着だけを抑制する。
 * BENT_VERTICAL_THROUGH は実柱主筋の内側境界の共通区間を鉛直遷移区間とし、
 * R10-Dでその両端を実曲げ半径Arcへ置換する。梁本体はArc接点まで切り戻し、
 * 柱面止まりの場合はArc接点まで直線で延長する。
 * Phase 5c-B3では水平1/6 candidateもactual window / Arc / 柱筋clearance / 柱境界を全て満たす
 * joint単位のatomic setだけproductionへ接続する。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import {
  createTagScanner,
  extractColumnPlanDimensions,
  findElementById,
  getNodeCoord,
} from '../columnSupportUtils.js';
import { resolveColumnRebarAvailableProjection } from './columnRebarClearProjection.js';
import {
  columnEndpointBarFacts,
  columnTransitionGeometry,
} from './columnJointTransitionGeometry.js';
import {
  resolveGirderEndpointGeometry,
  resolveOpposedGirderFrame,
} from './girderJointTransitionGeometry.js';
import { buildGirderJointTransitionFacts } from './girderJointTransitionPlacement.js';
import { stageHorizontalDoglegProduction } from './rebarHorizontalDoglegProduction.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';
import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';

const EPS = 1e-6;
const POSITION_TOLERANCE_MM = 1e-6;
const SLOPE_LIMIT = 1 / 6;

function finiteAttribute(element, name, fallback = 0) {
  if (!element?.hasAttribute?.(name)) return fallback;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function isRc(element) {
  const kind = String(element?.getAttribute?.('kind_structure') || '').toUpperCase();
  return !kind || kind === 'RC';
}

function planDot(point, direction) {
  return point.x * direction.x + point.y * direction.y;
}

function directionDot(left, right) {
  return left.x * right.x + left.y * right.y;
}

function columnCenterAtNode(scanTag, columnEl, nodeId) {
  const node = getNodeCoord(scanTag, nodeId);
  if (!node) return null;
  let prefix = null;
  if (columnEl.getAttribute('id_node_top') === nodeId) prefix = 'offset_top';
  else if (columnEl.getAttribute('id_node_bottom') === nodeId) prefix = 'offset_bottom';
  if (!prefix) return null;
  const offsetX = finiteAttribute(columnEl, `${prefix}_X`);
  const offsetY = finiteAttribute(columnEl, `${prefix}_Y`);
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  return { x: node.x + offsetX, y: node.y + offsetY };
}

function attachedColumns(scanTag, nodeId) {
  return scanTag('StbColumn').filter(
    (element) =>
      isRc(element) &&
      (element.getAttribute('id_node_top') === nodeId ||
        element.getAttribute('id_node_bottom') === nodeId),
  );
}

function columnEndpointAtNode(columnEl, nodeId) {
  if (columnEl?.getAttribute?.('id_node_top') === nodeId) return 'top';
  if (columnEl?.getAttribute?.('id_node_bottom') === nodeId) return 'bottom';
  return null;
}

function nonNegativeAttribute(element, name) {
  const value = finiteAttribute(element, name, 0);
  return value !== null && value >= 0 ? value : null;
}

function rotateLocalOffset(x, y, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function horizontalColumnBoundary(columnEl, dimensions, center, rotateDegrees, columnId) {
  const rotateRad = (rotateDegrees * Math.PI) / 180;
  if (dimensions.shape === 'CIRCLE' && dimensions.widthX > 0) {
    const fukashi = nonNegativeAttribute(columnEl, 'thickness_add_start_X');
    if (fukashi === null) return null;
    return {
      id: `COLUMN:${columnId || '-'}`,
      shape: 'CIRCLE',
      center,
      diameter: dimensions.widthX + 2 * fukashi,
    };
  }
  if (dimensions.shape !== 'RECT' || !(dimensions.widthX > 0) || !(dimensions.widthY > 0)) {
    return null;
  }

  const startX = nonNegativeAttribute(columnEl, 'thickness_add_start_X');
  const endX = nonNegativeAttribute(columnEl, 'thickness_add_end_X');
  const startY = nonNegativeAttribute(columnEl, 'thickness_add_start_Y');
  const endY = nonNegativeAttribute(columnEl, 'thickness_add_end_Y');
  if ([startX, endX, startY, endY].some((value) => value === null)) return null;

  const minX = -dimensions.widthX / 2 - startX;
  const maxX = dimensions.widthX / 2 + endX;
  const minY = -dimensions.widthY / 2 - startY;
  const maxY = dimensions.widthY / 2 + endY;
  const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const shift = rotateLocalOffset(localCenter.x, localCenter.y, rotateRad);
  return {
    id: `COLUMN:${columnId || '-'}`,
    shape: 'RECTANGLE',
    center: { x: center.x + shift.x, y: center.y + shift.y },
    widthX: maxX - minX,
    widthY: maxY - minY,
    rotateRad,
  };
}

function collectHorizontalColumnSafetyFacts(scanTag, joint, columnLayouts) {
  const columns = attachedColumns(scanTag, joint.nodeId);
  if (!columns.length) return { reason: 'joint-column-unresolved', bars: [], boundaries: [] };

  const bars = [];
  const boundaries = [];
  for (const columnEl of columns) {
    const columnId = columnEl.getAttribute('id') || null;
    const sectionId = String(columnEl.getAttribute('id_section'));
    const columnLayout = columnLayouts?.get(sectionId) || null;
    const dimensions = extractColumnPlanDimensions(scanTag, sectionId);
    const center = columnCenterAtNode(scanTag, columnEl, joint.nodeId);
    const geometry = columnTransitionGeometry(scanTag, columnEl);
    const endpoint = columnEndpointAtNode(columnEl, joint.nodeId);
    if (!columnLayout || !dimensions || !center || !geometry || !endpoint) {
      return {
        reason: 'horizontal-dogleg-column-geometry-unresolved',
        bars: [],
        boundaries: [],
      };
    }

    const endpointBars = columnEndpointBarFacts(columnEl, columnLayout, geometry, endpoint);
    if (!endpointBars.length) {
      return {
        reason: 'horizontal-dogleg-column-bars-unresolved',
        bars: [],
        boundaries: [],
      };
    }
    for (const bar of endpointBars) {
      if (
        !bar?.worldPosition ||
        !Object.values(bar.worldPosition).every(Number.isFinite) ||
        !(Number(bar.dia) > 0)
      ) {
        return {
          reason: 'horizontal-dogleg-column-bar-geometry-unresolved',
          bars: [],
          boundaries: [],
        };
      }
      bars.push({
        semanticIdentity: `COLUMN:${columnId || '-'}:${endpoint}:${bar.barIndex}`,
        worldPosition: { ...bar.worldPosition },
        outerDiameterMm: barOuterDiameterMm(bar.diaName || bar.dia, Number(bar.dia)),
      });
    }

    const rotationAttribute = columnEl.hasAttribute('rotate') ? 'rotate' : 'angle';
    const rotateDegrees = finiteAttribute(columnEl, rotationAttribute, 0);
    if (!Number.isFinite(rotateDegrees)) {
      return {
        reason: 'horizontal-dogleg-column-boundary-unresolved',
        bars: [],
        boundaries: [],
      };
    }
    const boundary = horizontalColumnBoundary(
      columnEl,
      dimensions,
      center,
      rotateDegrees,
      columnId,
    );
    if (!boundary) {
      return {
        reason: 'horizontal-dogleg-column-boundary-unresolved',
        bars: [],
        boundaries: [],
      };
    }
    boundaries.push(boundary);
  }

  bars.sort((left, right) => left.semanticIdentity.localeCompare(right.semanticIdentity));
  boundaries.sort((left, right) => left.id.localeCompare(right.id));
  return { reason: null, bars, boundaries };
}

function isHorizontalDoglegCandidate(transition) {
  return (
    transition?.candidateDisposition === 'BENT_HORIZONTAL_THROUGH' &&
    transition?.candidateRuleId === 'GIRDER-BENT-HORIZONTAL-ONE-SIXTH-CANDIDATE'
  );
}

function pairGeometry(scanTag, joint, girderLayouts) {
  const leftEl = findElementById(scanTag, 'StbGirder', joint.leftGirderId);
  const rightEl = findElementById(scanTag, 'StbGirder', joint.rightGirderId);
  if (!leftEl || !rightEl) return { reason: 'girder-element-unresolved' };
  const leftLayout = girderLayouts?.get(String(leftEl.getAttribute('id_section')));
  const rightLayout = girderLayouts?.get(String(rightEl.getAttribute('id_section')));
  if (!leftLayout || !rightLayout) return { reason: 'girder-layout-unresolved' };
  const left = resolveGirderEndpointGeometry(scanTag, leftEl, leftLayout, joint.leftEndpoint);
  const right = resolveGirderEndpointGeometry(scanTag, rightEl, rightLayout, joint.rightEndpoint);
  if (!left || !right) return { reason: 'girder-endpoint-geometry-unresolved' };
  const frame = resolveOpposedGirderFrame(left, right);
  if (!frame) return { reason: 'girder-opposed-frame-unresolved' };
  const leftDot = directionDot(left.outwardPlanDirection, frame.axis);
  const rightDot = directionDot(right.outwardPlanDirection, frame.axis);
  if (!(leftDot < -1 + 1e-6) || !(rightDot > 1 - 1e-6)) {
    return { reason: 'girder-left-right-frame-inconsistent' };
  }
  return { left, right, frame, leftDot, rightDot, reason: null };
}

/**
 * 上下柱がともに存在する場合も、両柱の実主筋内側境界の共通部分だけをbend runとする。
 * 梁端が柱面offsetで共通windowの外側にある場合はtrimせず、joint path側で境界まで延長する。
 */
function resolveProductionBendWindow(scanTag, joint, girderLayouts, columnLayouts) {
  const geometry = pairGeometry(scanTag, joint, girderLayouts);
  if (geometry.reason) return { reason: geometry.reason };
  const columns = attachedColumns(scanTag, joint.nodeId);
  if (!columns.length) return { reason: 'joint-column-unresolved' };

  const intervals = [];
  for (const columnEl of columns) {
    const sectionId = String(columnEl.getAttribute('id_section'));
    const columnLayout = columnLayouts?.get(sectionId) || null;
    const dimensions = extractColumnPlanDimensions(scanTag, sectionId);
    const center = columnCenterAtNode(scanTag, columnEl, joint.nodeId);
    if (!columnLayout || !dimensions || !center) {
      return { reason: 'joint-column-rebar-unresolved' };
    }

    const leftProjection = resolveColumnRebarAvailableProjection({
      columnEl,
      columnLayout,
      columnDimensions: dimensions,
      nodeId: joint.nodeId,
      beamDirection: geometry.left.planDirection,
      beamSide: joint.leftEndpoint,
    });
    const rightProjection = resolveColumnRebarAvailableProjection({
      columnEl,
      columnLayout,
      columnDimensions: dimensions,
      nodeId: joint.nodeId,
      beamDirection: geometry.right.planDirection,
      beamSide: joint.rightEndpoint,
    });
    if (!leftProjection.resolved || !rightProjection.resolved) {
      return { reason: 'joint-column-rebar-unresolved' };
    }

    const centerStation = planDot(center, geometry.frame.axis);
    const leftBoundaryStation =
      centerStation + rightProjection.farBoundaryFromCenterMm * geometry.rightDot;
    const rightBoundaryStation =
      centerStation + leftProjection.farBoundaryFromCenterMm * geometry.leftDot;
    if (!(rightBoundaryStation > leftBoundaryStation + EPS)) {
      return { reason: 'joint-column-rebar-window-no-overlap' };
    }
    intervals.push({
      columnId: columnEl.getAttribute('id') || null,
      sectionId,
      leftBoundaryStation,
      rightBoundaryStation,
      leftProjection,
      rightProjection,
    });
  }

  const leftBoundaryStation = Math.max(...intervals.map((entry) => entry.leftBoundaryStation));
  const rightBoundaryStation = Math.min(...intervals.map((entry) => entry.rightBoundaryStation));
  const jtMm = rightBoundaryStation - leftBoundaryStation;
  if (!(jtMm > EPS)) return { reason: 'joint-column-common-window-no-overlap' };

  const leftEndpointStation = planDot(geometry.left.center, geometry.frame.axis);
  const rightEndpointStation = planDot(geometry.right.center, geometry.frame.axis);
  const leftBoundaryOffsetMm = (leftBoundaryStation - leftEndpointStation) * geometry.leftDot;
  const rightBoundaryOffsetMm = (rightBoundaryStation - rightEndpointStation) * geometry.rightDot;

  return {
    reason: null,
    source: 'actual-column-rebar-common-overlap',
    geometry,
    intervals,
    leftBoundaryStation,
    rightBoundaryStation,
    jtMm,
    leftBoundaryOffsetMm,
    rightBoundaryOffsetMm,
    leftTrimMm: Math.max(0, leftBoundaryOffsetMm),
    rightTrimMm: Math.max(0, rightBoundaryOffsetMm),
    leftExtensionMm: Math.max(0, -leftBoundaryOffsetMm),
    rightExtensionMm: Math.max(0, -rightBoundaryOffsetMm),
  };
}

function moveAlongPlan(point, direction, distance) {
  return {
    x: point.x + direction.x * distance,
    y: point.y + direction.y * distance,
    z: point.z,
  };
}

function pointDistance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function pushLine(primitives, start, end) {
  if (pointDistance(start, end) > EPS) primitives.push(createLine(start, end));
}

function pathMetadata(joint, transition, disposition, source, extra = {}) {
  return {
    memberId: null,
    memberIds: [joint.leftGirderId, joint.rightGirderId],
    memberTag: 'StbGirder',
    role: transition.leftBar.role || null,
    layer: transition.leftBar.layer ?? null,
    dia: Number(transition.leftBar.dia),
    diaName: transition.leftBar.diaName || null,
    grade: transition.leftBar.grade || null,
    positionZone: 'JOINT',
    source,
    ruleId: '8-3',
    endpoint: null,
    identityKey:
      `R7:${joint.nodeId}:${joint.leftGirderId}:${transition.leftBar.barIndex}:` +
      `${joint.rightGirderId}:${transition.rightBar.barIndex}`,
    coordinateSpace: 'world',
    disposition,
    ...extra,
  };
}

/** 梁端offsetで左右主筋が柱面止まりの場合、STRAIGHT_THROUGHの柱内gapを補う。 */
function buildStraightPath(joint, transition, geometry) {
  const leftPoint = transition.leftBar.worldPosition;
  const rightPoint = transition.rightBar.worldPosition;
  if (![leftPoint, rightPoint].flatMap((point) => Object.values(point)).every(Number.isFinite)) {
    return { path: null, reason: 'joint-straight-point-unresolved' };
  }
  const leftStation = planDot(leftPoint, geometry.frame.axis);
  const rightStation = planDot(rightPoint, geometry.frame.axis);
  const gapMm = rightStation - leftStation;
  if (gapMm <= EPS) return { path: null, reason: null, gapMm };

  return {
    path: createRebarPath(
      [createLine(leftPoint, rightPoint)],
      pathMetadata(joint, transition, 'STRAIGHT_THROUGH', 'girder-r7-straight-through', {
        gapMm,
      }),
    ),
    reason: null,
    gapMm,
  };
}

function buildBentPath(joint, transition, window) {
  const leftEndpoint = transition.leftBar.worldPosition;
  const rightEndpoint = transition.rightBar.worldPosition;
  const leftBend = moveAlongPlan(
    leftEndpoint,
    window.geometry.left.outwardPlanDirection,
    window.leftBoundaryOffsetMm,
  );
  const rightBend = moveAlongPlan(
    rightEndpoint,
    window.geometry.right.outwardPlanDirection,
    window.rightBoundaryOffsetMm,
  );
  if (
    ![leftEndpoint, rightEndpoint, leftBend, rightBend]
      .flatMap((point) => Object.values(point))
      .every(Number.isFinite)
  ) {
    return { path: null, reason: 'joint-bend-point-unresolved' };
  }

  const planRunMm = Math.hypot(rightBend.x - leftBend.x, rightBend.y - leftBend.y);
  const verticalOffsetMm = Math.abs(rightBend.z - leftBend.z);
  if (!(planRunMm > EPS)) return { path: null, reason: 'joint-bend-run-nonpositive' };
  if (Math.abs(planRunMm - window.jtMm) > 1e-3) {
    return { path: null, reason: 'joint-bend-run-geometry-inconsistent' };
  }
  if (verticalOffsetMm / planRunMm > SLOPE_LIMIT + 1e-9) {
    return { path: null, reason: 'joint-bend-slope-exceeds-1-over-6' };
  }

  const leftOutward = window.geometry.left.outwardPlanDirection;
  const rightOutward = window.geometry.right.outwardPlanDirection;
  const rounded = buildDoglegTransitionPath({
    sharpStart: leftBend,
    sharpEnd: rightBend,
    incomingDirection: { x: -leftOutward.x, y: -leftOutward.y, z: 0 },
    outgoingDirection: { x: rightOutward.x, y: rightOutward.y, z: 0 },
    grade: transition.leftBar.grade,
    barDiaMm: Number(transition.leftBar.dia),
    metadata: pathMetadata(
      joint,
      transition,
      'BENT_VERTICAL_THROUGH',
      'girder-r7-vertical-through',
      {
        jtMm: window.jtMm,
        eMm: verticalOffsetMm,
        sharpLeftBoundaryOffsetMm: window.leftBoundaryOffsetMm,
        sharpRightBoundaryOffsetMm: window.rightBoundaryOffsetMm,
      },
    ),
  });
  if (!rounded.path) return { path: null, reason: rounded.reason || 'joint-bend-arc-unresolved' };

  const leftTrimMm = Math.max(
    0,
    window.leftBoundaryOffsetMm + rounded.startCorner.tangentDistanceMm,
  );
  const rightTrimMm = Math.max(
    0,
    window.rightBoundaryOffsetMm + rounded.endCorner.tangentDistanceMm,
  );
  const leftExtensionMm = Math.max(
    0,
    -(window.leftBoundaryOffsetMm + rounded.startCorner.tangentDistanceMm),
  );
  const rightExtensionMm = Math.max(
    0,
    -(window.rightBoundaryOffsetMm + rounded.endCorner.tangentDistanceMm),
  );

  const primitives = [];
  if (!(leftTrimMm > EPS)) {
    pushLine(primitives, leftEndpoint, rounded.startCorner.incomingTangent);
  }
  primitives.push(...rounded.path.primitives);
  if (!(rightTrimMm > EPS)) {
    pushLine(primitives, rounded.endCorner.outgoingTangent, rightEndpoint);
  }
  if (!primitives.length) return { path: null, reason: 'joint-bend-path-empty' };

  const path = createRebarPath(primitives, {
    ...rounded.path.metadata,
    bendGeometry: 'actual-arc',
    leftTrimMm,
    rightTrimMm,
    leftExtensionMm,
    rightExtensionMm,
  });
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return { path: null, reason: 'joint-bend-arc-path-invalid', validation };
  }

  return {
    path,
    reason: null,
    leftPoint: leftTrimMm > EPS ? rounded.startCorner.incomingTangent : leftEndpoint,
    rightPoint: rightTrimMm > EPS ? rounded.endCorner.outgoingTangent : rightEndpoint,
    leftBend,
    rightBend,
    planRunMm,
    leftTrimMm,
    rightTrimMm,
    leftExtensionMm,
    rightExtensionMm,
    rounded,
  };
}

function barIdentityKey(bar) {
  const p = bar?.localPosition || bar || {};
  return [
    bar?.role || '',
    bar?.layer ?? '',
    bar?.diaName || bar?.dia || '',
    String(bar?.grade || '').toUpperCase(),
    Number(p.u),
    Number(p.v),
  ].join('|');
}

function addSpec(map, memberId, endpoint, bar, extra = {}) {
  if (!memberId || !endpoint || !bar) return;
  const key = String(memberId);
  const list = map.get(key) || [];
  const spec = { endpoint, bar, ...extra };
  const identity = `${endpoint}|${barIdentityKey(bar)}|${extra.trimMm ?? ''}`;
  if (!list.some((item) => item.__identity === identity)) {
    Object.defineProperty(spec, '__identity', { value: identity, enumerable: false });
    list.push(spec);
    map.set(key, list);
  }
}

function checkBase(joint, transition = null) {
  const bar = transition?.leftBar || transition?.rightBar || null;
  return {
    category: '大梁仕口納まり',
    kind: '大梁',
    elementId: `${joint.leftGirderId || '-'} / ${joint.rightGirderId || '-'}`,
    elementName:
      `${joint.leftGirderName || joint.leftGirderId || '-'} ↔ ` +
      `${joint.rightGirderName || joint.rightGirderId || '-'}`,
    sectionName: `${joint.leftSectionName || '-'} ↔ ${joint.rightSectionName || '-'}`,
    position: `節点 ${joint.nodeId}`,
    role: bar?.role || '主筋',
    diaMm: bar?.dia ?? null,
    grade: bar?.grade || null,
    count: 1,
    requiredMm:
      transition?.verticalOffsetMm > 0
        ? transition.verticalOffsetMm * 6
        : transition?.horizontalOffsetMm > 0
          ? transition.horizontalOffsetMm * 6
          : null,
    availableMm: transition?.productionWindow?.jtMm ?? transition?.jtMm ?? null,
    horizontalOffsetMm: transition?.horizontalOffsetMm ?? null,
    verticalOffsetMm: transition?.verticalOffsetMm ?? null,
    disposition: transition?.disposition || 'SPECIAL',
    standardId: 'NIKKENREN-JSCA-2023',
    exact: false,
    ok: null,
  };
}

function transitionCheck(joint, transition) {
  const row = checkBase(joint, transition);
  if (
    transition.disposition === 'BENT_VERTICAL_THROUGH' &&
    transition.productionStatus === 'CENTERLINE_READY'
  ) {
    return {
      ...row,
      generationStatus: 'CENTERLINE_READY',
      unresolvedReason: null,
      bendGeometry: 'actual-arc',
      centerlineRadiusMm: transition.productionPath?.metadata?.centerlineRadiusMm || null,
      note:
        `§8-3 鉛直折曲げ通し中心線を実Arcで生成。e=${Math.round(transition.verticalOffsetMm)}mm、` +
        `実柱主筋共通jt=${Math.round(transition.productionWindow.jtMm)}mm、` +
        `e/jt=${(transition.verticalOffsetMm / transition.productionWindow.jtMm).toFixed(3)}。` +
        '梁端offsetとArc接点を考慮し、必要時のみ本体を切り戻し／柱内へ延長して§8-2個別定着を抑制。',
    };
  }
  if (transition.disposition === 'BENT_VERTICAL_THROUGH') {
    return {
      ...row,
      generationStatus: 'UNRESOLVED',
      unresolvedReason: transition.productionReason || 'vertical-through-centerline-not-generated',
      note: `§8-3 鉛直折曲げ通し未生成: ${transition.productionReason || 'unknown'}`,
    };
  }
  if (
    isHorizontalDoglegCandidate(transition) &&
    transition.productionStatus === 'CENTERLINE_READY'
  ) {
    return {
      ...row,
      disposition: 'BENT_HORIZONTAL_THROUGH',
      generationStatus: 'CENTERLINE_READY',
      unresolvedReason: null,
      bendGeometry: 'actual-arc',
      centerlineRadiusMm: transition.productionPath?.metadata?.centerlineRadiusMm || null,
      note:
        `§8-3 水平折曲げ通し中心線を実Arcで生成。e=${Math.round(transition.horizontalOffsetMm)}mm、` +
        `実柱主筋共通jt=${Math.round(transition.productionWindow.jtMm)}mm、` +
        `e/jt=${(transition.horizontalOffsetMm / transition.productionWindow.jtMm).toFixed(3)}。` +
        '柱主筋clearance・柱plan境界成立後に本体trim/延長と§8-2個別定着抑制をatomic適用。',
    };
  }
  if (isHorizontalDoglegCandidate(transition) && transition.productionStatus === 'UNRESOLVED') {
    return {
      ...row,
      generationStatus: 'UNRESOLVED',
      unresolvedReason: transition.productionReason || transition.unresolvedReason,
      note: `§8-3 水平折曲げ通し未生成: ${transition.productionReason || transition.unresolvedReason || 'unknown'}`,
    };
  }
  if (transition.unresolvedReason === 'horizontal-offset-auto-bend-disabled') {
    return {
      ...row,
      generationStatus: 'UNRESOLVED',
      unresolvedReason: transition.unresolvedReason,
      note:
        `§8-3 水平位置差 ${Math.round(transition.horizontalOffsetMm)}mm。` +
        '水平折曲げは自動生成せず、左右の§8-2個別定着を維持する。',
    };
  }
  return {
    ...row,
    generationStatus: 'UNRESOLVED',
    unresolvedReason: transition.unresolvedReason || 'special-required',
    note: `§8-3 未生成: ${transition.unresolvedReason || 'special-required'}`,
  };
}

function buildChecks(facts) {
  const checks = [];
  for (const joint of facts.joints) {
    if (!joint.pairResolved) {
      checks.push({
        ...checkBase(joint),
        generationStatus: 'UNRESOLVED',
        unresolvedReason: joint.unresolvedReason,
        note: `§8-3 未生成: ${joint.unresolvedReason}`,
      });
      continue;
    }

    joint.transitions
      .filter((transition) => transition.disposition !== 'STRAIGHT_THROUGH')
      .forEach((transition) => checks.push(transitionCheck(joint, transition)));

    for (const bar of joint.unmatchedLeftBars) {
      checks.push({
        ...checkBase(joint, { leftBar: bar, disposition: 'ANCHOR_LEFT' }),
        disposition: 'ANCHOR_LEFT',
        generationStatus: null,
        unresolvedReason: null,
        note: '§8-3 左梁のみの余剰筋。既存§8-2の個別定着を使用する。',
      });
    }
    for (const bar of joint.unmatchedRightBars) {
      checks.push({
        ...checkBase(joint, { rightBar: bar, disposition: 'ANCHOR_RIGHT' }),
        disposition: 'ANCHOR_RIGHT',
        generationStatus: null,
        unresolvedReason: null,
        note: '§8-3 右梁のみの余剰筋。既存§8-2の個別定着を使用する。',
      });
    }
    for (const mismatch of joint.unresolvedMatches) {
      const bar = mismatch.leftBars?.[0] || mismatch.rightBars?.[0] || null;
      checks.push({
        ...checkBase(joint, { leftBar: bar, disposition: 'SPECIAL' }),
        count: Math.max(mismatch.leftBars?.length || 0, mismatch.rightBars?.length || 0),
        generationStatus: 'UNRESOLVED',
        unresolvedReason: mismatch.reason,
        note: `§8-3 主筋対応未解決: ${mismatch.reason}`,
      });
    }
  }

  for (const joint of facts.unresolvedJoints) {
    checks.push({
      category: '大梁仕口納まり',
      kind: '大梁',
      elementId: joint.girderIds?.join(',') || '-',
      elementName: joint.girderIds?.join(' / ') || '-',
      sectionName: '-',
      position: `節点 ${joint.nodeId}`,
      role: '主筋',
      diaMm: null,
      grade: null,
      count: 0,
      requiredMm: null,
      availableMm: null,
      disposition: 'SPECIAL',
      standardId: 'NIKKENREN-JSCA-2023',
      exact: false,
      ok: null,
      generationStatus: 'UNRESOLVED',
      unresolvedReason: joint.reason,
      note: `§8-3 仕口ペア未解決: ${joint.reason}`,
    });
  }
  return checks;
}

/**
 * R7 production planを作る。
 * STRAIGHTは必要時に柱内gap path + 個別定着抑制、BENTはArc接点までの本体trim/延長 + world path + 抑制を原子的に追加する。
 */
export function buildGirderJointRenderPlan(xmlDoc, girderLayouts, columnLayouts, options = {}) {
  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const detailingChoice =
    options.detailingChoice ??
    options.commonConfig?.detailing?.choice ??
    getRebarCommonConfig().detailing?.choice;
  const facts = buildGirderJointTransitionFacts(xmlDoc, girderLayouts, columnLayouts, {
    ...options,
    scanTag,
    detailingChoice,
  });
  const paths = [];
  const memberEndTrims = new Map();
  const suppressedAnchorages = new Map();

  for (const joint of facts.joints) {
    if (!joint.pairResolved) continue;

    const horizontalTransitions = joint.transitions.filter(isHorizontalDoglegCandidate);
    if (horizontalTransitions.length) {
      const window = resolveProductionBendWindow(scanTag, joint, girderLayouts, columnLayouts);
      if (window.reason) {
        for (const transition of horizontalTransitions) {
          transition.productionStatus = 'UNRESOLVED';
          transition.productionReason = window.reason;
        }
      } else {
        const safetyFacts = collectHorizontalColumnSafetyFacts(scanTag, joint, columnLayouts);
        if (safetyFacts.reason) {
          for (const transition of horizontalTransitions) {
            transition.productionStatus = 'UNRESOLVED';
            transition.productionReason = safetyFacts.reason;
            transition.productionWindow = window;
          }
        } else {
          const production = stageHorizontalDoglegProduction({
            joint,
            transitions: horizontalTransitions,
            window,
            columnBars: safetyFacts.bars,
            columnBoundaries: safetyFacts.boundaries,
          });

          for (const decision of production.decisions) {
            const { transition, readiness } = decision;
            transition.productionStatus = decision.productionStatus;
            transition.productionReason = decision.productionReason;
            transition.productionDisposition = decision.productionDisposition;
            transition.productionWindow = window;
            transition.productionReadiness = readiness;
            if (production.ready) {
              transition.productionPath = readiness.path;
              transition.productionArcGeometry = readiness.rounded;
            }
          }

          if (production.ready) {
            paths.push(...production.paths);
            for (const trim of production.trims) {
              addSpec(memberEndTrims, trim.memberId, trim.endpoint, trim.bar, {
                trimMm: trim.trimMm,
              });
            }
            for (const suppression of production.suppressions) {
              addSpec(
                suppressedAnchorages,
                suppression.memberId,
                suppression.endpoint,
                suppression.bar,
              );
            }
          }
        }
      }
    }

    for (const transition of joint.transitions) {
      if (isHorizontalDoglegCandidate(transition)) continue;
      if (transition.disposition === 'STRAIGHT_THROUGH') {
        const geometry = pairGeometry(scanTag, joint, girderLayouts);
        if (geometry.reason) {
          transition.productionStatus = 'UNRESOLVED';
          transition.productionReason = geometry.reason;
          continue;
        }
        const built = buildStraightPath(joint, transition, geometry);
        if (built.reason) {
          transition.productionStatus = 'UNRESOLVED';
          transition.productionReason = built.reason;
          continue;
        }
        if (built.path) {
          paths.push(built.path);
          transition.productionPath = built.path;
        }
        addSpec(suppressedAnchorages, joint.leftGirderId, joint.leftEndpoint, transition.leftBar);
        addSpec(
          suppressedAnchorages,
          joint.rightGirderId,
          joint.rightEndpoint,
          transition.rightBar,
        );
        transition.productionStatus = built.path ? 'CENTERLINE_READY' : 'THROUGH_READY';
        transition.productionReason = null;
        continue;
      }
      if (transition.disposition !== 'BENT_VERTICAL_THROUGH') continue;

      const window = resolveProductionBendWindow(scanTag, joint, girderLayouts, columnLayouts);
      if (window.reason) {
        transition.productionStatus = 'UNRESOLVED';
        transition.productionReason = window.reason;
        continue;
      }
      const built = buildBentPath(joint, transition, window);
      if (!built.path) {
        transition.productionStatus = 'UNRESOLVED';
        transition.productionReason = built.reason;
        continue;
      }

      transition.productionStatus = 'CENTERLINE_READY';
      transition.productionReason = null;
      transition.productionWindow = window;
      transition.productionPath = built.path;
      transition.productionArcGeometry = built.rounded;
      paths.push(built.path);

      if (built.leftTrimMm > EPS) {
        addSpec(memberEndTrims, joint.leftGirderId, joint.leftEndpoint, transition.leftBar, {
          trimMm: built.leftTrimMm,
        });
      }
      if (built.rightTrimMm > EPS) {
        addSpec(memberEndTrims, joint.rightGirderId, joint.rightEndpoint, transition.rightBar, {
          trimMm: built.rightTrimMm,
        });
      }
      addSpec(suppressedAnchorages, joint.leftGirderId, joint.leftEndpoint, transition.leftBar);
      addSpec(suppressedAnchorages, joint.rightGirderId, joint.rightEndpoint, transition.rightBar);
    }
  }

  return {
    ...facts,
    paths,
    memberEndTrims,
    suppressedAnchorages,
    checks: buildChecks(facts),
  };
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function specPosition(spec) {
  return spec?.bar?.localPosition || spec?.bar || {};
}

function sameLocalPosition(left, right) {
  return (
    Number.isFinite(Number(left?.u)) &&
    Number.isFinite(Number(left?.v)) &&
    Number.isFinite(Number(right?.u)) &&
    Number.isFinite(Number(right?.v)) &&
    Math.abs(Number(left.u) - Number(right.u)) <= POSITION_TOLERANCE_MM &&
    Math.abs(Number(left.v) - Number(right.v)) <= POSITION_TOLERANCE_MM
  );
}

function specMatchesBar(spec, bar, endpoint) {
  const target = spec?.bar;
  const barHasLayer = bar?.layer !== null && bar?.layer !== undefined && bar?.layer !== '';
  const barGrade = gradeKey(bar?.grade);
  return (
    spec?.endpoint === endpoint &&
    target?.role === bar?.role &&
    (!barHasLayer || Number(target?.layer) === Number(bar?.layer)) &&
    Number(target?.dia) === Number(bar?.dia) &&
    (!barGrade || gradeKey(target?.grade) === barGrade) &&
    sameLocalPosition(specPosition(spec), bar)
  );
}

function specMatchesPiece(spec, piece) {
  return (
    spec?.endpoint === piece?.anchor &&
    Number(spec?.bar?.dia) === Number(piece?.dia) &&
    sameLocalPosition(specPosition(spec), piece)
  );
}

function groupSuppressionCount(specs, row) {
  return (specs || []).filter(
    (spec) =>
      spec.endpoint === row.side &&
      spec.bar?.role === row.role &&
      Number(spec.bar?.dia) === Number(row.diaMm) &&
      gradeKey(spec.bar?.grade) === gradeKey(row.grade),
  ).length;
}

/**
 * buildBeamAnchorageMaps() の結果から、R7で通し扱いにした筋だけを除去する。
 * 未解決/SPECIAL筋と小梁の§8-2個別定着は変更しない。
 */
export function applyGirderJointAnchorageSuppression(anchorageResult, plan) {
  if (!anchorageResult || !plan?.suppressedAnchorages?.size) return anchorageResult;
  const girder = new Map();

  for (const [memberId, entry] of anchorageResult.girder || []) {
    const specs = plan.suppressedAnchorages.get(String(memberId)) || [];
    if (!specs.length) {
      girder.set(memberId, entry);
      continue;
    }
    const pieces = (entry.pieces || []).filter(
      (piece) => !specs.some((spec) => specMatchesPiece(spec, piece)),
    );
    const ends = (entry.ends || []).map((end) => ({
      ...end,
      bars: (end.bars || []).filter(
        (bar) => !specs.some((spec) => specMatchesBar(spec, bar, end.side)),
      ),
    }));
    girder.set(memberId, { ...entry, pieces, ends });
  }

  const checks = [];
  for (const row of anchorageResult.checks || []) {
    if (row.kind !== '大梁') {
      checks.push(row);
      continue;
    }
    const specs = plan.suppressedAnchorages.get(String(row.elementId)) || [];
    const removed = groupSuppressionCount(specs, row);
    if (!removed) {
      checks.push(row);
      continue;
    }
    const count = Math.max(0, Number(row.count) - removed);
    if (count === 0) continue;
    checks.push({
      ...row,
      count,
      note: `${row.note || ''}、§8-3通し対象 ${removed}本を個別定着判定から除外`,
    });
  }

  return { ...anchorageResult, girder, checks };
}
