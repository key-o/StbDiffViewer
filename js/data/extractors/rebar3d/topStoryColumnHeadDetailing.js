/**
 * @fileoverview R8-C: 図8-2-5 最上階柱頭補強の柱内拘束筋facts。
 *
 * 日建連・JSCA 2023 図8-2-5では、上に柱がない最上階柱頭に柱内拘束筋を設け、
 * 「あばら筋と同径・@200以下」、梁交差部では上側となる梁主筋側へ配置する。
 * 既存の柱頭四隅180°フック／直線定着は columnAnchoragePlacement が扱うため、
 * 本moduleは重複生成せず柱内拘束筋の要求と、上側梁主筋側を一意に解ける場合の
 * world placement factsを公開する。
 */

import { barDiameterMm } from '../../../constants/beamOpeningRules.js';
import { createTagScanner, findColumnsAtNode } from '../columnSupportUtils.js';
import {
  girderEndpointBarFacts,
  resolveGirderEndpointGeometry,
} from './girderJointTransitionGeometry.js';

const STANDARD_ID = 'NIKKENREN-JSCA-2023';
const SPECIAL_TYPE = 'TOP_STORY_COLUMN_INTERNAL_RESTRAINT';
const SOURCE_ID = 'NIKKENREN-JSCA-2023-8-2-5';
const MAX_PITCH_MM = 200;
const ELEVATION_TOLERANCE_MM = 1e-3;
const AXIS_TOLERANCE = 1e-6;
const ORTHOGONAL_TOLERANCE = 1e-4;
const ENDPOINT_RATIO_TOLERANCE = 1e-9;
const ROLL_TOLERANCE_DEGREES = 1e-6;
const STB_TOP_POSITION_SOURCES = new Set([
  'stb-center',
  'stb-cover',
  'stb-apply-center',
  'stb-apply-cover',
]);

function isRc(element) {
  const kind = String(element?.getAttribute?.('kind_structure') || '').toUpperCase();
  return !kind || kind === 'RC';
}

function attachedRcGirders(scanTag, nodeId) {
  return scanTag('StbGirder').filter(
    (element) =>
      isRc(element) &&
      (element.getAttribute('id_node_start') === nodeId ||
        element.getAttribute('id_node_end') === nodeId),
  );
}

function endpointAtNode(girder, nodeId) {
  if (girder?.getAttribute?.('id_node_start') === nodeId) return 'start';
  if (girder?.getAttribute?.('id_node_end') === nodeId) return 'end';
  return null;
}

function fullSpanSegment(segment) {
  return (
    Number.isFinite(Number(segment?.startRatio)) &&
    Number.isFinite(Number(segment?.endRatio)) &&
    Math.abs(Number(segment.startRatio)) <= ENDPOINT_RATIO_TOLERANCE &&
    Math.abs(Number(segment.endRatio) - 1) <= ENDPOINT_RATIO_TOLERANCE
  );
}

function endpointSectionFacts(layout, girder, nodeId) {
  const endpoint = endpointAtNode(girder, nodeId);
  if (!endpoint || !layout) return null;
  const segments = layout.segments || [];
  if (!segments.length) return null;

  // END_CENTERはLEFTが「両端共通の端部断面」、CENTERが中央断面を表す。
  // 材軸方向のsegments配列ではLEFTが先頭側にしか現れないため、終端接続でも
  // positionFacts.LEFTを正本として利用し、CENTERへfallbackしない。
  if (layout.positionPattern === 'END_CENTER') {
    const zone = 'LEFT';
    const positionFact = layout.positionFacts?.[zone] || null;
    const segment = segments.find(
      (candidate) => String(candidate?.positionZone || '').toUpperCase() === zone,
    );
    return positionFact && segment
      ? { endpoint, zone, positionFact, segment, sharedEnd: true }
      : null;
  }

  if (segments.length === 1) {
    const segment = segments[0];
    if (!fullSpanSegment(segment)) return null;
    const zone = segment.positionZone || null;
    const positionFact = zone ? layout.positionFacts?.[zone] || null : null;
    return positionFact ? { endpoint, zone, positionFact, segment, sharedEnd: true } : null;
  }

  const expectedZones =
    endpoint === 'start' ? new Set(['LEFT', 'START']) : new Set(['RIGHT', 'END']);
  const boundary = endpoint === 'start' ? 0 : 1;
  const candidates = segments.filter((segment) => {
    const zone = String(segment?.positionZone || '').toUpperCase();
    if (!expectedZones.has(zone)) return false;
    const ratio = Number(endpoint === 'start' ? segment?.startRatio : segment?.endRatio);
    return Number.isFinite(ratio) && Math.abs(ratio - boundary) <= ENDPOINT_RATIO_TOLERANCE;
  });
  if (candidates.length !== 1) return null;
  const segment = candidates[0];
  const zone = segment.positionZone || null;
  const positionFact = zone ? layout.positionFacts?.[zone] || null : null;
  return positionFact ? { endpoint, zone, positionFact, segment, sharedEnd: false } : null;
}

function endpointFactLayout(layout, facts) {
  const bars = facts?.positionFact?.bars;
  if (!layout || !facts || !Array.isArray(bars) || bars.length === 0) return null;
  // girderEndpointBarFactsはsegmentsの先頭/末尾と0/1境界を参照するため、
  // 解決済み端部断面をendpoint専用の全長segmentへ正規化して渡す。
  return {
    ...layout,
    segments: [
      {
        ...facts.segment,
        positionZone: facts.zone,
        startRatio: 0,
        endRatio: 1,
        bars,
      },
    ],
  };
}

function resolveGirderStirrup(girder, layout, nodeId) {
  const facts = endpointSectionFacts(layout, girder, nodeId);
  const diaName = facts?.positionFact?.stirrupDia || null;
  const diaMm = diaName ? barDiameterMm(diaName, 0) : 0;
  return {
    girderId: girder.getAttribute('id') || null,
    girderName: girder.getAttribute('name') || null,
    sectionId: girder.getAttribute('id_section') || null,
    zone: facts?.zone || null,
    endpointResolved: Boolean(facts),
    diaName,
    diaMm: diaMm > 0 ? diaMm : null,
  };
}

function resolveRestraintDiameter(attached) {
  const resolved = attached.filter((entry) => Number.isFinite(entry.diaMm) && entry.diaMm > 0);
  if (resolved.length !== attached.length) {
    return {
      resolved: false,
      diaMm: null,
      diaName: null,
      reason: 'attached-girder-stirrup-unresolved',
    };
  }
  const diameters = [...new Set(resolved.map((entry) => entry.diaMm))];
  if (diameters.length !== 1) {
    return {
      resolved: false,
      diaMm: null,
      diaName: null,
      reason: 'conflicting-attached-girder-stirrup-diameters',
    };
  }
  const diaMm = diameters[0];
  const diaNames = [...new Set(resolved.map((entry) => entry.diaName).filter(Boolean))];
  return {
    resolved: true,
    diaMm,
    diaName: diaNames.length === 1 ? diaNames[0] : `D${diaMm}`,
    reason: null,
  };
}

function topStoryColumns(scanTag) {
  return [...scanTag('StbColumn'), ...scanTag('StbPost')].filter((column) => {
    if (!isRc(column)) return false;
    const topNodeId = column.getAttribute('id_node_top');
    if (!topNodeId) return false;
    return !findColumnsAtNode(scanTag, topNodeId).above;
  });
}

function normalizedRollDegrees(girder) {
  if (!girder?.hasAttribute?.('rotate')) return 0;
  const raw = Number(girder.getAttribute('rotate'));
  if (!Number.isFinite(raw)) return null;
  let normalized = ((raw % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  return normalized;
}

function canonicalPlanAxis(direction) {
  let x = Number(direction?.x);
  let y = Number(direction?.y);
  const length = Math.hypot(x, y);
  if (!(length > 0) || ![x, y].every(Number.isFinite)) return null;
  x /= length;
  y /= length;
  const flip = Math.abs(x) >= Math.abs(y) ? x < 0 : y < 0;
  return flip ? { x: -x, y: -y } : { x, y };
}

function axisDot(left, right) {
  return Number(left?.x) * Number(right?.x) + Number(left?.y) * Number(right?.y);
}

function sameAxis(left, right) {
  return Math.abs(axisDot(left, right)) >= 1 - AXIS_TOLERANCE;
}

function firstLayerTopBars(facts) {
  const topBars = (facts || []).filter((bar) => bar?.role === 'top');
  if (!topBars.length) return [];
  const layers = topBars.map((bar) => Number(bar?.layer)).filter(Number.isFinite);
  if (!layers.length) return topBars;
  const firstLayer = Math.min(...layers);
  return topBars.filter((bar) => Number(bar?.layer) === firstLayer);
}

function topElevationIsStbResolved(bar) {
  return STB_TOP_POSITION_SOURCES.has(String(bar?.positionSource || ''));
}

function resolveGirderTopLine(scanTag, girder, layout, nodeId) {
  const endpointFacts = endpointSectionFacts(layout, girder, nodeId);
  if (!endpointFacts) return { ok: false, reason: 'girder-endpoint-main-layout-unresolved' };
  const endpoint = endpointFacts.endpoint;

  const rollDegrees = normalizedRollDegrees(girder);
  if (rollDegrees === null || Math.abs(rollDegrees) > ROLL_TOLERANCE_DEGREES) {
    return { ok: false, reason: 'girder-roll-unsupported' };
  }

  const geometry = resolveGirderEndpointGeometry(scanTag, girder, layout, endpoint);
  if (!geometry) return { ok: false, reason: 'girder-endpoint-geometry-unresolved' };
  const axis = canonicalPlanAxis(geometry.planDirection);
  if (!axis) return { ok: false, reason: 'girder-plan-axis-unresolved' };

  const factLayout = endpointFactLayout(layout, endpointFacts);
  if (!factLayout) return { ok: false, reason: 'girder-endpoint-main-layout-unresolved' };
  const bars = firstLayerTopBars(girderEndpointBarFacts(girder, factLayout, geometry));
  if (!bars.length) return { ok: false, reason: 'girder-top-main-bar-unresolved' };
  if (!bars.every(topElevationIsStbResolved)) {
    return { ok: false, reason: 'girder-top-main-bar-elevation-estimated' };
  }

  const elevations = bars.map((bar) => Number(bar?.worldPosition?.z)).filter(Number.isFinite);
  if (elevations.length !== bars.length) {
    return { ok: false, reason: 'girder-top-main-bar-unresolved' };
  }
  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  if (maxElevation - minElevation > ELEVATION_TOLERANCE_MM) {
    return { ok: false, reason: 'girder-top-main-bar-elevation-nonuniform' };
  }

  return {
    ok: true,
    value: {
      girderId: girder.getAttribute('id') || null,
      girderName: girder.getAttribute('name') || null,
      endpoint,
      axis,
      elevationMm: (minElevation + maxElevation) / 2,
    },
  };
}

function groupGirderAxes(entries) {
  const groups = [];
  for (const entry of entries) {
    const group = groups.find((candidate) => sameAxis(candidate.axis, entry.axis));
    if (group) group.entries.push(entry);
    else groups.push({ axis: entry.axis, entries: [entry] });
  }
  return groups;
}

function resolveAxisElevation(group) {
  const elevations = group.entries.map((entry) => entry.elevationMm);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  if (max - min > ELEVATION_TOLERANCE_MM) return null;
  return (min + max) / 2;
}

/**
 * 図8-2-5の「梁交差部では上側となる梁主筋側」をworld座標から解く。
 * 同レベル、非直交、多方向、傾斜・roll等で上側を一意に決められない場合はfail-closed。
 */
function resolveTopStoryColumnHeadRestraintPlacement(scanTag, nodeId, girders, girderLayouts) {
  if (!nodeId || !Array.isArray(girders) || girders.length < 2) {
    return {
      resolved: false,
      reason: 'girder-intersection-requires-two-directions',
      geometry: null,
    };
  }

  const entries = [];
  for (const girder of girders) {
    const sectionId = String(girder.getAttribute('id_section') || '');
    const layout = girderLayouts?.get(sectionId) || null;
    const resolved = resolveGirderTopLine(scanTag, girder, layout, nodeId);
    if (!resolved.ok) {
      return {
        resolved: false,
        reason: resolved.reason,
        geometry: null,
      };
    }
    entries.push(resolved.value);
  }

  const groups = groupGirderAxes(entries);
  if (groups.length !== 2) {
    return {
      resolved: false,
      reason: 'girder-intersection-axis-count-unresolved',
      geometry: null,
    };
  }
  if (Math.abs(axisDot(groups[0].axis, groups[1].axis)) > ORTHOGONAL_TOLERANCE) {
    return { resolved: false, reason: 'girder-intersection-not-orthogonal', geometry: null };
  }

  const axisFacts = groups.map((group) => ({
    ...group,
    elevationMm: resolveAxisElevation(group),
  }));
  if (axisFacts.some((group) => !Number.isFinite(group.elevationMm))) {
    return {
      resolved: false,
      reason: 'same-axis-upper-main-bar-elevation-conflict',
      geometry: null,
    };
  }

  axisFacts.sort((left, right) => right.elevationMm - left.elevationMm);
  const upper = axisFacts[0];
  const lower = axisFacts[1];
  const separationMm = upper.elevationMm - lower.elevationMm;
  if (!(separationMm > ELEVATION_TOLERANCE_MM)) {
    return { resolved: false, reason: 'upper-main-bar-side-ambiguous', geometry: null };
  }

  return {
    resolved: true,
    reason: null,
    geometry: {
      coordinateSpace: 'world',
      nodeId: String(nodeId),
      upperAxis: { ...upper.axis },
      lowerAxis: { ...lower.axis },
      upperMainBarElevationMm: upper.elevationMm,
      lowerMainBarElevationMm: lower.elevationMm,
      verticalSeparationMm: separationMm,
      upperGirderIds: upper.entries.map((entry) => entry.girderId).filter(Boolean),
      lowerGirderIds: lower.entries.map((entry) => entry.girderId).filter(Boolean),
    },
  };
}

function axisText(axis) {
  if (!axis) return '-';
  return `(${Number(axis.x).toFixed(3)},${Number(axis.y).toFixed(3)})`;
}

/**
 * 図8-2-5の柱内拘束筋要求を判定一覧用factsとして返す。
 * world上で上側梁主筋側まで一意に解けた場合は restraintPlacementGeometry を付与する。
 * 拘束筋そのものの閉鎖形状・フック形状はここでは生成しない。
 */
export function buildTopStoryColumnHeadDetailingChecks(
  xmlDoc,
  girderLayouts,
  sharedScanTag = null,
) {
  if (!xmlDoc) return [];
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const checks = [];

  for (const column of topStoryColumns(scanTag)) {
    const nodeId = column.getAttribute('id_node_top');
    const girders = attachedRcGirders(scanTag, nodeId);
    if (!girders.length) continue;

    const attached = girders.map((girder) =>
      resolveGirderStirrup(
        girder,
        girderLayouts?.get(String(girder.getAttribute('id_section'))) || null,
        nodeId,
      ),
    );
    const diameter = resolveRestraintDiameter(attached);
    const placement = resolveTopStoryColumnHeadRestraintPlacement(
      scanTag,
      nodeId,
      girders,
      girderLayouts,
    );
    const attachedNames = attached
      .map((entry) => entry.girderName || entry.girderId)
      .filter(Boolean)
      .join(', ');
    const diaText = diameter.resolved
      ? `${diameter.diaName || `D${diameter.diaMm}`}`
      : `未解決(${diameter.reason})`;
    const placementText = placement.resolved
      ? `上側梁軸=${axisText(placement.geometry.upperAxis)}、主筋Z=${Math.round(placement.geometry.upperMainBarElevationMm)}mm`
      : `上側梁主筋側=未解決(${placement.reason})`;

    checks.push({
      category: '柱頭特殊納まり',
      kind: '柱',
      elementId: column.getAttribute('id') || null,
      elementName: column.getAttribute('name') || null,
      sectionName: null,
      nodeId,
      position: `最上階柱頭（節点 ${nodeId}）`,
      role: '柱内拘束筋',
      diaMm: diameter.diaMm,
      diaName: diameter.diaName,
      grade: null,
      count: null,
      fc: null,
      requiredMm: null,
      availableMm: null,
      exact: false,
      ok: null,
      standardId: STANDARD_ID,
      maxPitchMm: MAX_PITCH_MM,
      attachedGirderCount: attached.length,
      attachedGirderStirrups: attached,
      requirementResolved: diameter.resolved,
      unresolvedReason: diameter.reason,
      restraintPlacementResolved: placement.resolved,
      restraintPlacementReason: placement.reason,
      restraintPlacementGeometry: placement.geometry,
      generationStatus: 'UNRESOLVED',
      specialDetailingRequired: true,
      specialDetailingType: SPECIAL_TYPE,
      specialDetailingStatus: diameter.resolved ? 'REQUIRED' : 'UNRESOLVED',
      specialDetailingSource: SOURCE_ID,
      existingCornerHookSource: 'columnAnchoragePlacement',
      placementRule: 'girder-intersection-use-upper-main-bar-side',
      note:
        `図8-2-5: 柱内拘束筋はあばら筋と同径・@${MAX_PITCH_MM}以下。` +
        `接続大梁=${attachedNames || '-'}、拘束筋径=${diaText}、${placementText}。` +
        '柱頭四隅フックは既存柱定着で扱い、拘束筋の閉鎖形状・フック形状は未生成。',
    });
  }

  return checks;
}
