/**
 * @fileoverview R8-B: RC大梁ハンチ部のコーナー主筋納まりfacts。
 *
 * 日建連・JSCA 2023 図8-2-4では、ハンチ部の梁コーナー主筋を折曲げ通し筋とする。
 * ST-Bridgeでハンチが明示されている大梁だけを対象に要求を公開する。
 * R8-Dでは、実ハンチ長と端部/中央断面のコーナー主筋対応を一意に解ける場合だけ
 * member-localのproduction geometry factsを付与する。実RebarPath生成は後段で行う。
 *
 * 汎用のLEFT/CENTER/RIGHT多断面だけからハンチを推定しない。
 */

import { createTagScanner } from '../columnSupportUtils.js';

const STANDARD_ID = 'NIKKENREN-JSCA-2023';
const SPECIAL_TYPE = 'GIRDER_HAUNCH_CORNER_CONTINUITY';
const SOURCE_ID = 'NIKKENREN-JSCA-2023-8-2-4';
const SIDE_LABELS = { start: '始端', end: '終端' };
const RATIO_TOLERANCE = 1e-9;
const LENGTH_TOLERANCE_MM = 1e-6;

function positiveAttribute(element, name) {
  if (!element?.hasAttribute?.(name)) return null;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function finiteAttribute(element, name) {
  if (!element?.hasAttribute?.(name)) return null;
  const raw = element.getAttribute(name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function textAttribute(element, name) {
  const value = element?.getAttribute?.(name);
  return value === null || value === undefined || value === '' ? null : String(value);
}

function isFoundationGirder(element) {
  const value = String(element?.getAttribute?.('isFoundation') || '')
    .trim()
    .toLowerCase();
  // xs:boolean の true lexical space は true / 1。
  return value === 'true' || value === '1';
}

function isRcGirder(element) {
  const kind = String(element?.getAttribute?.('kind_structure') || '').toUpperCase();
  return !kind || kind === 'RC';
}

function sectionIdOfAncestor(element) {
  let current = element?.parentNode || null;
  while (current) {
    const localName = current.localName || current.nodeName;
    if (localName === 'StbSecBeam_RC' || localName === 'StbSecGirder_RC') {
      return current.getAttribute?.('id') || null;
    }
    current = current.parentNode;
  }
  return null;
}

function buildExplicitSectionHaunchMap(scanTag) {
  const result = new Map();
  for (const tagName of ['StbSecBeam_RC_Haunch', 'StbSecGirder_RC_Haunch']) {
    for (const element of scanTag(tagName)) {
      const sectionId = sectionIdOfAncestor(element);
      if (!sectionId) continue;
      const set = result.get(String(sectionId)) || new Set();
      const pos = String(element.getAttribute('pos') || '').toUpperCase();
      if (pos) set.add(pos);
      result.set(String(sectionId), set);
    }
  }
  return result;
}

function buildNodePointMap(scanTag) {
  const result = new Map();
  for (const node of scanTag('StbNode')) {
    const id = node.getAttribute('id');
    const x = finiteAttribute(node, 'X');
    const y = finiteAttribute(node, 'Y');
    const z = finiteAttribute(node, 'Z');
    if (!id || ![x, y, z].every(Number.isFinite)) continue;
    result.set(String(id), { x, y, z });
  }
  return result;
}

function memberEndpointPoint(girder, nodePoints, side) {
  const nodeId = girder.getAttribute(side === 'start' ? 'id_node_start' : 'id_node_end');
  const node = nodePoints.get(String(nodeId || ''));
  if (!node) return null;

  const point = { ...node };
  for (const axis of ['X', 'Y', 'Z']) {
    const name = `offset_${side}_${axis}`;
    const offset = girder.hasAttribute(name) ? finiteAttribute(girder, name) : 0;
    if (!Number.isFinite(offset)) return null;
    point[axis.toLowerCase()] += offset;
  }
  return point;
}

function girderMemberLengthMm(girder, nodePoints) {
  const start = memberEndpointPoint(girder, nodePoints, 'start');
  const end = memberEndpointPoint(girder, nodePoints, 'end');
  if (!start || !end) return null;
  const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  return Number.isFinite(length) && length > 0 ? length : null;
}

function fullSpanSegment(segment) {
  return (
    Number.isFinite(Number(segment?.startRatio)) &&
    Number.isFinite(Number(segment?.endRatio)) &&
    Math.abs(Number(segment.startRatio)) <= RATIO_TOLERANCE &&
    Math.abs(Number(segment.endRatio) - 1) <= RATIO_TOLERANCE
  );
}

function endpointSegment(layout, side) {
  const segments = layout?.segments || [];
  if (!segments.length) return null;

  // SAMEのような全長1区間だけは両端の正本として扱える。
  if (segments.length === 1) return fullSpanSegment(segments[0]) ? segments[0] : null;

  const expectedZones = side === 'start' ? new Set(['LEFT', 'START']) : new Set(['RIGHT', 'END']);
  const candidates = segments.filter((segment) => {
    const zone = String(segment?.positionZone || '').toUpperCase();
    if (!expectedZones.has(zone)) return false;
    const ratio = Number(side === 'start' ? segment?.startRatio : segment?.endRatio);
    return (
      Number.isFinite(ratio) && Math.abs(ratio - (side === 'start' ? 0 : 1)) <= RATIO_TOLERANCE
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function centerSegment(layout) {
  const segments = layout?.segments || [];
  const candidates = segments.filter(
    (segment) => String(segment?.positionZone || '').toUpperCase() === 'CENTER',
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function haunchExceedsTargetRun(layout, side, lengthMm, memberLengthMm) {
  if (!(Number(lengthMm) > 0) || !(Number(memberLengthMm) > 0)) return false;
  const center = centerSegment(layout);
  if (!center) return false;
  const startRatio = Number(center.startRatio);
  const endRatio = Number(center.endRatio);
  if (![startRatio, endRatio].every(Number.isFinite)) return true;

  const boundaryRatio =
    side === 'start' ? lengthMm / memberLengthMm : 1 - lengthMm / memberLengthMm;
  // beamRebarPathBuilderはstart側でtarget runの終端より前、end側でtarget runの始端より後に
  // 少なくとも正長さのCENTER側runを残す必要がある。ここで先に検証してUIと実描画を一致させる。
  return side === 'start'
    ? !(boundaryRatio < endRatio - RATIO_TOLERANCE)
    : !(boundaryRatio > startRatio + RATIO_TOLERANCE);
}

function firstLayerBars(bars, role) {
  const roleBars = (bars || []).filter((bar) => bar?.role === role);
  if (!roleBars.length) return [];
  const layers = roleBars.map((bar) => Number(bar?.layer)).filter(Number.isFinite);
  if (!layers.length) return roleBars;
  const firstLayer = Math.min(...layers);
  return roleBars.filter((bar) => Number(bar?.layer) === firstLayer);
}

function extremeBars(bars) {
  const sorted = (bars || [])
    .filter(
      (bar) =>
        Number.isFinite(Number(bar?.u)) && Number.isFinite(Number(bar?.v)) && Number(bar?.dia) > 0,
    )
    .slice()
    .sort((left, right) => Number(left.u) - Number(right.u));
  if (!sorted.length) return [];
  if (sorted.length === 1) return [sorted[0]];
  return [sorted[0], sorted[sorted.length - 1]];
}

function cornerBarsOfSegment(segment) {
  const bars = segment?.bars || [];
  return [
    ...extremeBars(firstLayerBars(bars, 'top')),
    ...extremeBars(firstLayerBars(bars, 'bottom')),
  ];
}

function hasEstimatedCornerDiameter(segment) {
  return cornerBarsOfSegment(segment).some((bar) => bar?.diaEstimated === true);
}

function haunchHasEstimatedCornerDiameter(layout, side) {
  const endpoint = endpointSegment(layout, side);
  const center = centerSegment(layout);
  return (
    Boolean(endpoint && center) &&
    (hasEstimatedCornerDiameter(endpoint) || hasEstimatedCornerDiameter(center))
  );
}

/** 梁断面四隅に相当する1段目主筋を抽出する。 */
function endpointCornerBars(layout, side) {
  return cornerBarsOfSegment(endpointSegment(layout, side));
}

function normalizedGrade(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function groupKey(bar) {
  const diaMm = Number(bar?.dia);
  return `${Number.isFinite(diaMm) ? diaMm : '-'}|${normalizedGrade(bar?.grade) || '-'}`;
}

function groupCornerBars(bars) {
  const groups = new Map();
  for (const bar of bars || []) {
    const diaMm = Number(bar?.dia);
    const grade = bar?.grade || null;
    const key = groupKey(bar);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { diaMm: Number.isFinite(diaMm) ? diaMm : null, grade, count: 1 });
  }
  return [...groups.values()];
}

function normalizedHaunchKind(girder, side) {
  const suffix = side === 'start' ? 'start' : 'end';
  const value = textAttribute(girder, `kind_haunch_${suffix}`);
  return value ? value.trim().toUpperCase() : null;
}

function normalizedOrientation(girder, attributeName, defaultValue) {
  const value = textAttribute(girder, attributeName);
  return value ? value.trim().toUpperCase() : defaultValue;
}

function haunchKindProductionBlocker(kind) {
  if (!kind || kind === 'SLOPE') return null;
  return kind === 'DROP' ? 'stb-haunch-drop-production-unsupported' : 'stb-haunch-kind-unsupported';
}

function haunchOrientationProductionBlocker(horizontalType, verticalType) {
  if (horizontalType && horizontalType !== 'BOTH') {
    return 'stb-haunch-horizontal-orientation-unsupported';
  }
  if (verticalType && verticalType !== 'BOTH') {
    return 'stb-haunch-vertical-orientation-unsupported';
  }
  return null;
}

function haunchLengthProductionBlocker(lengthMm, memberLengthMm) {
  if (!(Number(lengthMm) > 0)) return null;
  if (!(Number.isFinite(memberLengthMm) && memberLengthMm > 0)) {
    return 'stb-girder-member-length-unresolved';
  }
  return lengthMm >= memberLengthMm - LENGTH_TOLERANCE_MM
    ? 'stb-haunch-length-outside-member'
    : null;
}

function sideIsExplicitHaunch(girder, sectionPositions, side, memberLengthMm, layout) {
  const haunchLengthMm = positiveAttribute(
    girder,
    side === 'start' ? 'haunch_start' : 'haunch_end',
  );
  const sectionPos = side === 'start' ? 'START' : 'END';
  const kind = normalizedHaunchKind(girder, side);
  // ST-Bridge XSDの省略時既定値: H=BOTH / V=BOTTOM。
  // V省略はBOTTOMのみを意味するため、両側コーナー筋を動かす現consumerではfail-closedになる。
  const horizontalType = normalizedOrientation(girder, 'type_haunch_H', 'BOTH');
  const verticalType = normalizedOrientation(girder, 'type_haunch_V', 'BOTTOM');
  const productionBlocker =
    haunchKindProductionBlocker(kind) ||
    haunchOrientationProductionBlocker(horizontalType, verticalType) ||
    haunchLengthProductionBlocker(haunchLengthMm, memberLengthMm) ||
    (haunchExceedsTargetRun(layout, side, haunchLengthMm, memberLengthMm)
      ? 'stb-haunch-length-exceeds-target-run'
      : null) ||
    (haunchHasEstimatedCornerDiameter(layout, side)
      ? 'stb-haunch-corner-diameter-estimated'
      : null);
  return {
    required: haunchLengthMm !== null || sectionPositions?.has(sectionPos) === true,
    lengthMm: haunchLengthMm,
    memberLengthMm,
    kind,
    horizontalType,
    verticalType,
    productionBlocker,
    source:
      haunchLengthMm !== null && sectionPositions?.has(sectionPos)
        ? 'stb-member+section-haunch'
        : haunchLengthMm !== null
          ? 'stb-member-haunch'
          : sectionPositions?.has(sectionPos)
            ? 'stb-section-haunch'
            : null,
  };
}

function describeHaunch(girder, side, resolved) {
  const length = Number.isFinite(resolved.lengthMm)
    ? `ハンチ長=${Math.round(resolved.lengthMm)}mm`
    : 'ハンチ長=未明示';
  const attributes = [
    resolved.kind ? `種別=${resolved.kind}` : null,
    resolved.horizontalType ? `H=${resolved.horizontalType}` : null,
    resolved.verticalType ? `V=${resolved.verticalType}` : null,
  ]
    .filter(Boolean)
    .join('、');
  return `${length}${attributes ? `、${attributes}` : ''}`;
}

function roleCornerPairs(endpointBars, centerBars, role) {
  const endpoint = extremeBars(firstLayerBars(endpointBars, role));
  const center = extremeBars(firstLayerBars(centerBars, role));
  if (!endpoint.length || endpoint.length !== center.length) return null;
  if ([...endpoint, ...center].some((bar) => bar?.diaEstimated === true)) return null;

  const pairs = [];
  for (let index = 0; index < endpoint.length; index += 1) {
    const fromBar = endpoint[index];
    const toBar = center[index];
    if (
      Number(fromBar.dia) !== Number(toBar.dia) ||
      normalizedGrade(fromBar.grade) !== normalizedGrade(toBar.grade)
    ) {
      return null;
    }
    pairs.push({
      role,
      diaMm: Number(fromBar.dia),
      grade: fromBar.grade || toBar.grade || null,
      from: { u: Number(fromBar.u), v: Number(fromBar.v) },
      to: { u: Number(toBar.u), v: Number(toBar.v) },
    });
  }
  return pairs;
}

function buildHaunchProductionGeometry(layout, side, resolved) {
  if (!(Number(resolved?.lengthMm) > 0) || resolved?.productionBlocker) return null;
  const endpoint = endpointSegment(layout, side);
  const center = centerSegment(layout);
  if (!endpoint || !center) return null;

  const top = roleCornerPairs(endpoint.bars || [], center.bars || [], 'top');
  const bottom = roleCornerPairs(endpoint.bars || [], center.bars || [], 'bottom');
  if (!top || !bottom) return null;
  const cornerTransitions = [...top, ...bottom];
  if (!cornerTransitions.length) return null;

  return {
    coordinateSpace: 'member-local',
    side,
    lengthMm: Number(resolved.lengthMm),
    endpointZone: endpoint.positionZone || (side === 'start' ? 'LEFT' : 'RIGHT'),
    targetZone: center.positionZone || 'CENTER',
    cornerTransitions,
  };
}

function geometryForGroup(geometry, group) {
  if (!geometry || !group) return null;
  const transitions = geometry.cornerTransitions.filter(
    (transition) =>
      Number(transition.diaMm) === Number(group.diaMm) &&
      normalizedGrade(transition.grade) === normalizedGrade(group.grade),
  );
  if (transitions.length !== group.count) return null;
  return { ...geometry, cornerTransitions: transitions };
}

function baseCheck(girder, layout, side, resolved) {
  return {
    category: '大梁特殊納まり',
    kind: '大梁',
    elementId: girder.getAttribute('id') || null,
    elementName: girder.getAttribute('name') || null,
    sectionName: layout?.sectionName || null,
    side,
    position: `${SIDE_LABELS[side]}ハンチ`,
    role: 'コーナー主筋',
    fc: null,
    requiredMm: null,
    availableMm: resolved.lengthMm,
    exact: false,
    ok: null,
    standardId: STANDARD_ID,
    generationStatus: 'UNRESOLVED',
    specialDetailingRequired: true,
    specialDetailingType: SPECIAL_TYPE,
    specialDetailingStatus: 'REQUIRED',
    specialDetailingSource: SOURCE_ID,
    haunchLengthMm: resolved.lengthMm,
    memberLengthMm: resolved.memberLengthMm,
    haunchKind: resolved.kind,
    haunchHorizontalType: resolved.horizontalType,
    haunchVerticalType: resolved.verticalType,
    haunchGeometrySource: resolved.source,
    haunchProductionBlocker: resolved.productionBlocker,
    note:
      `図8-2-4: 梁のコーナー主筋は折曲げ通し筋とする。${describeHaunch(girder, side, resolved)}。` +
      (resolved.productionBlocker
        ? `production未生成(${resolved.productionBlocker})。`
        : 'R8-Dで端部/中央のコーナー主筋対応を解ける場合はproduction geometry factsを保持するが、RebarPathは未生成。'),
  };
}

function applyOverlapBlocker(resolvedBySide, memberLengthMm) {
  const start = resolvedBySide.start;
  const end = resolvedBySide.end;
  if (!(Number(memberLengthMm) > 0) || !start || !end) return;
  if (!(Number(start.lengthMm) > 0) || !(Number(end.lengthMm) > 0)) return;
  // 一方が既に長さ・target run・orientation等でinvalidなら、その端はproductionされない。
  // そのinvalid長を使って反対側の正常端までoverlap扱いにしない。
  if (start.productionBlocker || end.productionBlocker) return;
  if (start.lengthMm + end.lengthMm < memberLengthMm - LENGTH_TOLERANCE_MM) return;

  start.productionBlocker = 'stb-haunch-boundaries-overlap';
  end.productionBlocker = 'stb-haunch-boundaries-overlap';
}

/**
 * STB明示ハンチを持つRC大梁について、図8-2-4のコーナー主筋折曲げ通し要求を返す。
 * 基礎梁は§6対象なのでここでは扱わない。
 */
export function buildGirderHaunchDetailingChecks(xmlDoc, girderLayouts, sharedScanTag = null) {
  if (!xmlDoc) return [];
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const sectionHaunchMap = buildExplicitSectionHaunchMap(scanTag);
  const nodePoints = buildNodePointMap(scanTag);
  const checks = [];

  for (const girder of scanTag('StbGirder')) {
    if (!isRcGirder(girder) || isFoundationGirder(girder)) continue;
    const sectionId = String(girder.getAttribute('id_section') || '');
    if (!sectionId) continue;
    const sectionPositions = sectionHaunchMap.get(sectionId) || null;
    const layout = girderLayouts?.get(sectionId) || null;
    const memberLengthMm = girderMemberLengthMm(girder, nodePoints);
    const resolvedBySide = {
      start: sideIsExplicitHaunch(girder, sectionPositions, 'start', memberLengthMm, layout),
      end: sideIsExplicitHaunch(girder, sectionPositions, 'end', memberLengthMm, layout),
    };
    applyOverlapBlocker(resolvedBySide, memberLengthMm);

    for (const side of ['start', 'end']) {
      const resolved = resolvedBySide[side];
      if (!resolved.required) continue;

      const groups = groupCornerBars(endpointCornerBars(layout, side));
      const productionGeometry = buildHaunchProductionGeometry(layout, side, resolved);
      const common = baseCheck(girder, layout, side, resolved);
      if (!groups.length) {
        checks.push({
          ...common,
          diaMm: null,
          grade: null,
          count: null,
          haunchProductionGeometry: null,
        });
        continue;
      }
      for (const group of groups) {
        checks.push({
          ...common,
          ...group,
          haunchProductionGeometry: geometryForGroup(productionGeometry, group),
        });
      }
    }
  }

  return checks;
}
