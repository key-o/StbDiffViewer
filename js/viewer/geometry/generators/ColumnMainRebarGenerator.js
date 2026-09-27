/**
 * @fileoverview RC柱主筋を部材ごとの材軸範囲で描画するアダプター
 */

import { calculateColumnPlacement } from '../core/GeometryCalculator.js';
import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';
import { buildColumnMainMemberRangeMap } from '../../../data/extractors/rebar3d/columnMainMemberPlacement.js';
import { buildColumnAnchorageMaps } from '../../../data/extractors/rebar3d/columnAnchoragePlacement.js';
import { buildAnchoredReturnHookPath } from '../../../data/extractors/rebar3d/rebarReturnHookGeometry.js';
import { createColumnRebarMeshes } from './RebarGenerator.js';
import { createColumnJointRebarMeshes } from './ColumnJointRebarGenerator.js';

const EPS = 1e-9;
const POSITION_TOLERANCE_MM = 1e-6;

function clipLayout(layout, startRatio) {
  if (!(startRatio > EPS) || !Array.isArray(layout?.segments)) return layout;

  const segments = layout.segments
    .map((segment) => {
      const start = Math.max(Number(segment.startRatio) || 0, startRatio);
      const end = Number.isFinite(Number(segment.endRatio)) ? Number(segment.endRatio) : 1;
      if (end - start <= EPS) return null;
      return { ...segment, startRatio: start, endRatio: end };
    })
    .filter(Boolean);

  return {
    ...layout,
    segments,
    memberStartRatio: startRatio,
  };
}

/**
 * TOP/BOTTOM位置が異なる通し筋はidentityだけ確定しており、柱内の遷移位置・形状は未解決。
 * BOTTOM座標の全長直線として描画すると実在しない主筋になるためproduction描画から除外する。
 */
function suppressUnresolvedMemberTransitions(layout) {
  if (!Array.isArray(layout?.segments)) return layout;
  let suppressedCount = 0;
  const segments = layout.segments.map((segment) => {
    const bars = (segment.bars || []).filter((bar) => {
      const suppress = bar?.memberTransitionRequired === true;
      if (suppress) suppressedCount += 1;
      return !suppress;
    });
    return bars.length === (segment.bars || []).length ? segment : { ...segment, bars };
  });
  if (suppressedCount === 0) return layout;
  return {
    ...layout,
    segments,
    memberTransitionSuppressed: true,
    suppressedMemberTransitionCount: suppressedCount,
  };
}

function safeSectionLayouts(sectionLayoutMap) {
  const result = new Map();
  for (const [key, layout] of sectionLayoutMap || []) {
    result.set(key, suppressUnresolvedMemberTransitions(layout));
  }
  return result;
}

function resolveColumnPlacement(column, nodes) {
  const bottom = nodes?.get(String(column.id_node_bottom));
  const top = nodes?.get(String(column.id_node_top));
  if (!bottom || !top) return null;

  const rollAngleDegrees = Number(column.rotate ?? column.angle ?? 0) || 0;
  return calculateColumnPlacement(
    { x: bottom.x, y: bottom.y, z: bottom.z },
    { x: top.x, y: top.y, z: top.z },
    {
      bottomOffset: {
        x: Number(column.offset_bottom_X || 0),
        y: Number(column.offset_bottom_Y || 0),
        z: Number(column.offset_bottom_Z || 0),
      },
      topOffset: {
        x: Number(column.offset_top_X || 0),
        y: Number(column.offset_top_Y || 0),
        z: Number(column.offset_top_Z || 0),
      },
      rollAngle: (rollAngleDegrees * Math.PI) / 180,
    },
  );
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function layerKey(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function sameBar(left, right) {
  return (
    Math.abs(Number(left?.u) - Number(right?.u)) <= POSITION_TOLERANCE_MM &&
    Math.abs(Number(left?.v) - Number(right?.v)) <= POSITION_TOLERANCE_MM &&
    Number(left?.dia) === Number(right?.dia) &&
    layerKey(left?.layer) === layerKey(right?.layer) &&
    gradeKey(left?.grade) === gradeKey(right?.grade)
  );
}

function samePiecePosition(piece, bar) {
  return (
    Math.abs(Number(piece?.u) - Number(bar?.u)) <= POSITION_TOLERANCE_MM &&
    Math.abs(Number(piece?.v) - Number(bar?.v)) <= POSITION_TOLERANCE_MM &&
    Number(piece?.dia) === Number(bar?.dia)
  );
}

function topEndpointBars(layout) {
  return layout?.endpointFacts?.top?.bars?.length
    ? layout.endpointFacts.top.bars
    : layout?.segments?.[0]?.bars || [];
}

function isLegacyTopReturnPiece(piece) {
  return (
    piece?.kind === 'tail' &&
    piece?.anchor === 'end' &&
    piece?.dir === 'axial' &&
    (Math.abs(Number(piece?.offsetU) || 0) > EPS || Math.abs(Number(piece?.offsetV) || 0) > EPS)
  );
}

function returnDirectionFromPiece(piece) {
  const x = Math.sign(Number(piece?.offsetU) || 0);
  const y = Math.sign(Number(piece?.offsetV) || 0);
  return x === 0 && y === 0 ? null : { x, y, z: 0 };
}

function findTopSourceBar(layout, piece) {
  const candidates = topEndpointBars(layout).filter(
    (bar) => bar?.corner === true && samePiecePosition(piece, bar),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function findRenderableBar(layout, sourceBar) {
  const candidates = [];
  for (const segment of layout?.segments || []) {
    const endRatio = Number.isFinite(Number(segment.endRatio)) ? Number(segment.endRatio) : 1;
    if (endRatio < 1 - EPS) continue;
    for (const bar of segment.bars || []) {
      if (bar?.memberTransitionRequired === true || !sameBar(bar, sourceBar)) continue;
      candidates.push({ bar, segment });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function buildTopReturnHookPlans(
  columnElements,
  nodes,
  sectionLayoutMap,
  xmlDoc,
  scanTag,
  jointRenderPlan,
) {
  const result = new Map();
  if (!xmlDoc || !columnElements?.length || !sectionLayoutMap?.size) return result;

  const anchorages = buildColumnAnchorageMaps(xmlDoc, sectionLayoutMap, {}, scanTag);
  for (const column of columnElements) {
    const memberId = String(column.id);
    const anchorage = anchorages.columns.get(memberId);
    if (!anchorage?.pieces?.length) continue;

    const sourceLayout = sectionLayoutMap.get(String(column.id_section));
    const renderLayout = jointRenderPlan?.memberLayouts?.get(memberId) || sourceLayout;
    const placement = resolveColumnPlacement(column, nodes);
    if (!sourceLayout || !renderLayout || !placement || !(placement.length > 0)) continue;

    const entries = [];
    for (const piece of anchorage.pieces.filter(isLegacyTopReturnPiece)) {
      const sourceBar = findTopSourceBar(sourceLayout, piece);
      const renderMatch = sourceBar ? findRenderableBar(renderLayout, sourceBar) : null;
      const returnDirection = returnDirectionFromPiece(piece);
      if (!sourceBar || !renderMatch || !returnDirection) continue;

      const built = buildAnchoredReturnHookPath({
        anchor: 'end',
        apexAtMm: piece.at,
        u: sourceBar.u,
        v: sourceBar.v,
        barDiaMm: sourceBar.dia,
        grade: sourceBar.grade,
        returnDirection,
        tailLengthMm: piece.length,
        metadata: {
          memberId,
          role: sourceBar.role || 'main',
          layer: sourceBar.layer ?? null,
          source: 'column-r10-top-180-hook',
          ruleId: 'R10-B',
        },
      });
      if (!built.ok || !built.path || !(built.requiredMainBarTrimMm > 0)) continue;

      const segmentStart = Number(renderMatch.segment.startRatio) || 0;
      const trimmedEnd = 1 - built.requiredMainBarTrimMm / placement.length;
      if (!(trimmedEnd > segmentStart + EPS)) continue;

      const worldPath = anchorLocalPathToWorldLines(built.path, placement, {
        memberId,
        memberTag: 'StbColumn',
      });
      if (!worldPath) continue;
      entries.push({
        bar: renderMatch.bar,
        trimMm: built.requiredMainBarTrimMm,
        worldPath,
      });
    }
    if (entries.length) result.set(memberId, { placement, entries });
  }
  return result;
}

function findTrimEntry(bar, entries) {
  const candidates = (entries || []).filter((entry) => sameBar(bar, entry.bar));
  return candidates.length === 1 ? candidates[0] : null;
}

function applyTopHookTrims(layout, plan, memberLengthMm) {
  if (!plan?.entries?.length || !Array.isArray(layout?.segments) || !(memberLengthMm > 0)) {
    return { layout, applied: new Set() };
  }

  const applied = new Set();
  const segments = [];
  for (const segment of layout.segments) {
    const startRatio = Number(segment.startRatio) || 0;
    const endRatio = Number.isFinite(Number(segment.endRatio)) ? Number(segment.endRatio) : 1;
    if (endRatio < 1 - EPS) {
      segments.push(segment);
      continue;
    }

    const groups = new Map();
    for (const bar of segment.bars || []) {
      const entry = findTrimEntry(bar, plan.entries);
      const nextEnd = entry ? Math.min(endRatio, 1 - entry.trimMm / memberLengthMm) : endRatio;
      if (!(nextEnd > startRatio + EPS)) continue;
      if (entry) applied.add(entry);
      const key = nextEnd.toFixed(12);
      const group = groups.get(key);
      if (group) group.bars.push(bar);
      else groups.set(key, { endRatio: nextEnd, bars: [bar] });
    }

    for (const group of groups.values()) {
      segments.push({ ...segment, endRatio: group.endRatio, bars: group.bars });
    }
  }

  return {
    layout: {
      ...layout,
      segments,
      topReturnHookTrimApplied: applied.size > 0,
      topReturnHookTrimCount: applied.size,
    },
    applied,
  };
}

/**
 * RC柱主筋を、接続梁下端から求めた部材別の下端で生成する。
 *
 * RebarGenerator は断面ID→配置を共有する設計のため、端部形状が部材固有になる柱だけ
 * 一時的な断面キーへ差し替える。元の STB 要素・断面配置は変更しない。
 *
 * TOP/BOTTOMで断面内位置が変わる筋は、実遷移pathが解決するまで描画しない。
 * R10-Bでは最上階四隅の180°フックを実Arc化し、incoming tangentまで主筋本体を
 * 筋単位でtrimできた場合に限ってArcを同時生成する。
 *
 * @param {Array<Object>} columnElements - parseStbFile の柱要素
 * @param {Map<string, Object>} nodes - 節点マップ
 * @param {Map<string, Object>} sectionLayoutMap - 断面ID→柱主筋配置
 * @param {Object} [options] - {xmlDoc, scanTag, modelSource, material}
 * @returns {Array<Object>} 生成メッシュ
 */
export function createColumnMainMemberMeshes(
  columnElements,
  nodes,
  sectionLayoutMap,
  options = {},
) {
  const { xmlDoc, scanTag, jointRenderPlan, ...meshOptions } = options;
  const safeLayouts = safeSectionLayouts(sectionLayoutMap);
  const ranges =
    jointRenderPlan?.memberRanges ||
    (xmlDoc ? buildColumnMainMemberRangeMap(xmlDoc, scanTag) : new Map());
  const topHookPlans = buildTopReturnHookPlans(
    columnElements,
    nodes,
    sectionLayoutMap,
    xmlDoc,
    scanTag,
    jointRenderPlan,
  );

  if (ranges.size === 0 && !jointRenderPlan?.memberLayouts?.size && topHookPlans.size === 0) {
    return createColumnRebarMeshes(columnElements, nodes, safeLayouts, meshOptions);
  }

  const memberLayouts = new Map(safeLayouts);
  const hookWorldPaths = [];
  const remappedColumns = columnElements.map((column) => {
    const memberId = String(column.id);
    const range = ranges.get(memberId);
    const jointLayout = jointRenderPlan?.memberLayouts?.get(memberId);
    const hookPlan = topHookPlans.get(memberId);
    if (!(range?.startRatio > EPS) && !jointLayout && !hookPlan) return column;

    const layout = jointLayout || sectionLayoutMap.get(String(column.id_section));
    if (!layout) return column;

    const placement = hookPlan?.placement || resolveColumnPlacement(column, nodes);
    const memberSectionKey = `__column_main_member_${column.id}_${column.id_section}`;
    const clipped = suppressUnresolvedMemberTransitions(clipLayout(layout, range?.startRatio || 0));
    const trimmed = placement
      ? applyTopHookTrims(clipped, hookPlan, placement.length)
      : { layout: clipped, applied: new Set() };
    memberLayouts.set(memberSectionKey, trimmed.layout);
    for (const entry of trimmed.applied) hookWorldPaths.push(entry.worldPath);
    return { ...column, id_section: memberSectionKey };
  });

  const mainMeshes = createColumnRebarMeshes(remappedColumns, nodes, memberLayouts, meshOptions);
  const hookMeshes = hookWorldPaths.length
    ? createColumnJointRebarMeshes(hookWorldPaths, {
        modelSource: meshOptions.modelSource,
        rebarKind: 'columnTopReturnHook',
      })
    : [];
  return [...mainMeshes, ...hookMeshes];
}
