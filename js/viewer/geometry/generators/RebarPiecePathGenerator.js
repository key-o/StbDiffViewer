/**
 * @fileoverview 定着・カットオフpiece描画にRebarPath実曲げ形状を重ねるadapter。
 *
 * R10-Aでは梁柱90°定着を、beamAnchoragePlacementが既に解決した
 * sharp corner / tail length / anchorage modeから実半径Arcへ変換する。
 * R10-Bでは柱頭180°フックをColumnMainRebarGenerator側でmain bar trimと
 * 原子的に生成するため、従来の直線return tailはここで抑制する。
 * R10-Cでは最下階柱脚90°定着のsharp axial + tail pairを同じhook geometryへ
 * 置換し、解決不能時に旧直角pieceへ黙ってフォールバックしない。
 */

import { calculateBeamPlacement, calculateColumnPlacement } from '../core/GeometryCalculator.js';
import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';
import { buildAnchoredHookPath } from '../../../data/extractors/rebar3d/rebarHookGeometry.js';
import { createRebarPieceMeshes as createLegacyRebarPieceMeshes } from './RebarGenerator.js';
import { createColumnJointRebarMeshes } from './ColumnJointRebarGenerator.js';

// NGでも既知の曲げ位置・余長が解決済みなら診断形状として描画する。
// SPECIALは形状自体が未解決なのでfail-closedのまま描画しない。
const RENDERABLE_ANCHORAGE_MODES = new Set(['L2H', 'L2_FALLBACK', 'NG']);
const EPS = 1e-9;
const POSITION_TOLERANCE_MM = 1e-6;

function resolveBeamPlacement(beam, nodes, layout) {
  const start = nodes?.get(String(beam.id_node_start));
  const end = nodes?.get(String(beam.id_node_end));
  if (!start || !end) return null;

  const placement = calculateBeamPlacement(
    { x: start.x, y: start.y, z: start.z },
    { x: end.x, y: end.y, z: end.z },
    {
      startOffset: {
        x: Number(beam.offset_start_X || 0),
        y: Number(beam.offset_start_Y || 0),
        z: Number(beam.offset_start_Z || 0),
      },
      endOffset: {
        x: Number(beam.offset_end_X || 0),
        y: Number(beam.offset_end_Y || 0),
        z: Number(beam.offset_end_Z || 0),
      },
      placementMode: 'top-aligned',
      sectionHeight: layout.depth || 0,
    },
  );
  const rollAngleDegrees = Number(beam.rotate ?? beam.angle ?? 0) || 0;
  return { ...placement, localRollRad: (rollAngleDegrees * Math.PI) / 180 };
}

function resolveColumnPlacement(column, nodes) {
  const bottom = nodes?.get(String(column.id_node_bottom));
  const top = nodes?.get(String(column.id_node_top));
  if (!bottom || !top) return null;

  const rollAngleDegrees = Number(column.rotate ?? column.angle ?? 0) || 0;
  const placement = calculateColumnPlacement(
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
  return { ...placement, localRollRad: 0 };
}

function uniqueCheckForBar(end, bar) {
  const candidates = (end?.checks || []).filter(
    (check) =>
      check?.role === bar?.role &&
      Number(check?.diaMm) === Number(bar?.dia) &&
      check?.anchorageMode === bar?.anchorageMode,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * beamAnchoragePlacementの結果からR10-Aの90°実曲げworld pathを生成する。
 * L2H/L2_FALLBACKに加え、形状factが解決済みのNGも診断形状として生成する。
 * SPECIAL、gradeが一意に解けない筋、曲げ接点が梁本体内へ入る筋は生成しない。
 */
export function buildBeamAnchorageWorldPaths(elements, nodes, layoutMap, pieceMap) {
  const result = [];
  if (!elements?.length || !nodes?.size || !layoutMap?.size || !pieceMap?.size) return result;

  for (const element of elements) {
    const memberId = String(element.id);
    const entry = pieceMap.get(memberId);
    if (!entry?.ends?.length) continue;
    const layout = layoutMap.get(String(element.id_section));
    if (!layout) continue;
    const placement = resolveBeamPlacement(element, nodes, layout);
    if (!placement || !(placement.length > 0)) continue;

    for (const end of entry.ends) {
      if (!['start', 'end'].includes(end?.side) || !Number.isFinite(end?.bendFromBeamEndMm))
        continue;
      for (const bar of end.bars || []) {
        if (!RENDERABLE_ANCHORAGE_MODES.has(bar?.anchorageMode)) continue;
        const check = uniqueCheckForBar(end, bar);
        if (!check?.grade) continue;

        const built = buildAnchoredHookPath({
          anchor: end.side,
          at: end.bendFromBeamEndMm,
          u: bar.u,
          v: bar.v,
          barDiaMm: bar.dia,
          grade: check.grade,
          bendAngleDeg: 90,
          outgoingDirection: { x: 0, y: Number(bar.tailDir), z: 0 },
          tailLengthMm: bar.tailLengthMm,
          metadata: {
            memberId,
            memberTag: 'StbBeam',
            endpoint: end.side,
            role: bar.role || null,
            anchorageMode: bar.anchorageMode,
            source: 'beam-r10-anchorage-hook',
            ruleId: 'R10-A',
          },
        });
        if (!built.ok || !built.path) continue;
        const worldPath = anchorLocalPathToWorldLines(built.path, placement, {
          anchor: end.side,
          memberId,
          memberTag: 'StbBeam',
        });
        if (worldPath) result.push(worldPath);
      }
    }
  }
  return result;
}

function withoutBeamAnchorageEntries(pieceMap) {
  const result = new Map();
  for (const [key, entry] of pieceMap || []) {
    if (entry?.ends?.length) continue;
    result.set(key, entry);
  }
  return result;
}

function samePiecePosition(left, right) {
  return (
    Math.abs(Number(left?.u) - Number(right?.u)) <= POSITION_TOLERANCE_MM &&
    Math.abs(Number(left?.v) - Number(right?.v)) <= POSITION_TOLERANCE_MM &&
    Number(left?.dia) === Number(right?.dia)
  );
}

function isLegacyColumnTopReturnPiece(piece) {
  return (
    piece?.kind === 'tail' &&
    piece?.anchor === 'end' &&
    piece?.dir === 'axial' &&
    (Math.abs(Number(piece?.offsetU) || 0) > EPS || Math.abs(Number(piece?.offsetV) || 0) > EPS)
  );
}

function isLegacyColumnBottomHookTail(piece) {
  return (
    piece?.kind === 'tail' &&
    piece?.anchor === 'start' &&
    (piece?.dir === 'u' || piece?.dir === 'v') &&
    (Number(piece?.sign) === 1 || Number(piece?.sign) === -1) &&
    Number(piece?.length) > 0
  );
}

function findMatchingBottomAxialPiece(pieces, tail) {
  const candidates = (pieces || []).filter(
    (piece) =>
      piece?.kind === 'axial' &&
      piece?.anchor === 'start' &&
      Math.abs(Number(piece?.to)) <= POSITION_TOLERANCE_MM &&
      Math.abs(Number(piece?.from) - Number(tail?.at)) <= POSITION_TOLERANCE_MM &&
      samePiecePosition(piece, tail),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function bottomEndpointBars(layout) {
  return layout?.endpointFacts?.bottom?.bars?.length
    ? layout.endpointFacts.bottom.bars
    : layout?.segments?.[0]?.bars || [];
}

function uniqueBottomSourceBar(layout, piece) {
  const candidates = bottomEndpointBars(layout).filter((bar) => samePiecePosition(bar, piece));
  return candidates.length === 1 ? candidates[0] : null;
}

function outgoingDirectionForTail(tail) {
  const sign = Number(tail?.sign);
  if (tail?.dir === 'u' && (sign === 1 || sign === -1)) return { x: sign, y: 0, z: 0 };
  if (tail?.dir === 'v' && (sign === 1 || sign === -1)) return { x: 0, y: sign, z: 0 };
  return null;
}

/**
 * R10-C 最下階柱脚90°定着を実Arc world pathへ変換する。
 *
 * 旧pieceの `axial(start, from<0, to=0)` と `tail(start, at=from, dir=u/v)` を
 * 1組のsharp hook factとして読み替える。断面bar factからgradeを一意に解ける場合だけ
 * 表2-1の実曲げ半径へ変換する。
 */
export function buildColumnBottomAnchorageWorldPaths(elements, nodes, layoutMap, pieceMap) {
  const result = [];
  if (!elements?.length || !nodes?.size || !layoutMap?.size || !pieceMap?.size) return result;

  for (const element of elements) {
    const memberId = String(element.id);
    const entry = pieceMap.get(memberId);
    if (!entry?.pieces?.length) continue;
    const layout = layoutMap.get(String(element.id_section));
    if (!layout) continue;
    const placement = resolveColumnPlacement(element, nodes);
    if (!placement || !(placement.length > 0)) continue;

    for (const tail of entry.pieces.filter(isLegacyColumnBottomHookTail)) {
      const axial = findMatchingBottomAxialPiece(entry.pieces, tail);
      const sourceBar = axial ? uniqueBottomSourceBar(layout, tail) : null;
      const outgoingDirection = outgoingDirectionForTail(tail);
      if (!axial || !sourceBar?.grade || !outgoingDirection) continue;

      const built = buildAnchoredHookPath({
        anchor: 'start',
        at: Number(tail.at),
        u: Number(tail.u),
        v: Number(tail.v),
        barDiaMm: Number(tail.dia),
        grade: sourceBar.grade,
        bendAngleDeg: 90,
        outgoingDirection,
        tailLengthMm: Number(tail.length),
        metadata: {
          memberId,
          memberTag: 'StbColumn',
          endpoint: 'start',
          role: sourceBar.role || 'main',
          layer: sourceBar.layer ?? null,
          source: 'column-r10-bottom-90-hook',
          ruleId: 'R10-C',
        },
      });
      if (!built.ok || !built.path) continue;
      const worldPath = anchorLocalPathToWorldLines(built.path, placement, {
        anchor: 'start',
        memberId,
        memberTag: 'StbColumn',
      });
      if (worldPath) result.push(worldPath);
    }
  }
  return result;
}

function bottomHookPairPieces(entry) {
  const pairs = new Set();
  for (const tail of (entry?.pieces || []).filter(isLegacyColumnBottomHookTail)) {
    const axial = findMatchingBottomAxialPiece(entry.pieces, tail);
    if (!axial) continue;
    pairs.add(tail);
    pairs.add(axial);
  }
  return pairs;
}

/**
 * R10-B/Cで実形状化する旧直線pieceだけを除去する。
 * bottom hook pairはgrade解決や表2-1適用に失敗しても旧直角形状へ戻さない。
 */
function withoutLegacyColumnBends(pieceMap) {
  const result = new Map();
  for (const [key, entry] of pieceMap || []) {
    const bottomPairs = bottomHookPairPieces(entry);
    const pieces = (entry?.pieces || []).filter(
      (piece) => !isLegacyColumnTopReturnPiece(piece) && !bottomPairs.has(piece),
    );
    if (pieces.length) result.set(key, { ...entry, pieces });
  }
  return result;
}

/**
 * 既存createRebarPieceMeshes互換の公開adapter。
 *
 * - 柱: R10-B/C対象の旧直線pieceを抑制し、柱脚90°は実Arcを生成
 * - 梁のanchorage entry (`ends`あり): R10-AのArc中心線を描画
 * - 梁cutoff等 (`ends`なし): 従来piece描画
 */
export function createRebarPieceMeshes(elements, nodes, layoutMap, pieceMap, options = {}) {
  if (options.memberType === 'column') {
    const passthroughMap = withoutLegacyColumnBends(pieceMap);
    const legacyMeshes = passthroughMap.size
      ? createLegacyRebarPieceMeshes(elements, nodes, layoutMap, passthroughMap, options)
      : [];
    const bottomHookPaths = buildColumnBottomAnchorageWorldPaths(
      elements,
      nodes,
      layoutMap,
      pieceMap,
    );
    const bottomHookMeshes = bottomHookPaths.length
      ? createColumnJointRebarMeshes(bottomHookPaths, {
          modelSource: options.modelSource,
          rebarKind: options.rebarKind || 'columnAnchorage',
        })
      : [];
    return [...legacyMeshes, ...bottomHookMeshes];
  }

  const passthroughMap = withoutBeamAnchorageEntries(pieceMap);
  const legacyMeshes = passthroughMap.size
    ? createLegacyRebarPieceMeshes(elements, nodes, layoutMap, passthroughMap, options)
    : [];
  const hookPaths = buildBeamAnchorageWorldPaths(elements, nodes, layoutMap, pieceMap);
  const hookMeshes = hookPaths.length
    ? createColumnJointRebarMeshes(hookPaths, {
        modelSource: options.modelSource,
        rebarKind: options.rebarKind || 'beamAnchorage',
      })
    : [];
  return [...legacyMeshes, ...hookMeshes];
}
