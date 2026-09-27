/**
 * @fileoverview RC梁（大梁・小梁）主筋のカットオフ筋長さの算定（3D配筋用）
 *
 * 大梁は日建連2023へ移行するため、回転・偏心・柱端/梁端オフセットを反映した
 * 実柱面間 Lo を基準にする。小梁は後続対象のため従来近似を維持する。
 *
 * @module data/extractors/rebar3d/beamCutoffPlacement
 */

import { beamCutoffLengthMm } from '../../../constants/rebarCutoffRules.js';
import {
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnAtNode,
  getNodeCoord,
  projectColumnDepth,
} from '../columnSupportUtils.js';
import { axialPiece } from './rebarPieces.js';
import { resolveBeamClearSpanFromScanner } from './rebarClearGeometry.js';
import { assignBeamBarIdentities, matchRebarFacts } from './rebarIdentityMatcher.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

/** カットオフの対象とする主筋の役割（腹筋はカットオフしない） */
const CUTOFF_ROLES = new Set(['top', 'bottom']);

/** 梁端の定義（区間の並びと基準にする部材端） */
const BEAM_ENDS = [
  { side: 'start', nodeAttr: 'id_node_start', anchor: 'start', outerIndex: 0 },
  { side: 'end', nodeAttr: 'id_node_end', anchor: 'end', outerIndex: -1 },
];

/** 梁端の表示名 */
const SIDE_LABELS = { start: '始端', end: '終端' };

/**
 * 小梁互換用に、節点間の平面方向と距離を求める。
 * @param {function(string): Element[]} scanTag タグ走査関数
 * @param {Element} beamEl 梁要素
 * @param {Object|null} [index=null] RebarModelIndex
 * @returns {{dir:{x:number,y:number},spanMm:number}|null}
 */
function resolveLegacyBeamSpan(scanTag, beamEl, index = null) {
  const start = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'), index);
  const end = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'), index);
  if (!start || !end) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const spanMm = Math.hypot(dx, dy);
  if (!(spanMm > 0)) return null;
  return { dir: { x: dx / spanMm, y: dy / spanMm }, spanMm };
}

/** 小梁互換用の柱せい投影 */
function legacyColumnDepthAtNode(scanTag, nodeId, beamDir, index = null) {
  const columnEl = findColumnAtNode(scanTag, nodeId, index);
  if (!columnEl) return 0;
  const dims = extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'), index);
  return Math.max(0, projectColumnDepth(dims, beamDir));
}

function readBeamOffsetZ(beamEl, prefix) {
  return parseFloat(beamEl?.getAttribute(`${prefix}_Z`)) || 0;
}

/**
 * 平面上で解いた柱面位置を、viewer が使う実3D材軸距離へ変換する。
 * 柱面交点はXY平面上の鉛直柱プリズムとの交点なので、直線梁では
 * 平面距離に 3D材長/平面長 を掛ければ同じ材軸位置を得られる。
 */
function resolveGirderAxisMetric(scanTag, beamEl, exact, index = null) {
  const planSpanMm = exact?.beamAxis?.lengthMm;
  if (!(planSpanMm > 0)) return null;

  const startNode = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'), index);
  const endNode = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'), index);
  if (!startNode || !endNode) return null;

  const startZ = startNode.z + readBeamOffsetZ(beamEl, 'offset_start');
  const endZ = endNode.z + readBeamOffsetZ(beamEl, 'offset_end');
  const memberSpanMm = Math.hypot(planSpanMm, endZ - startZ);
  if (!(memberSpanMm > 0)) return null;

  const planToAxis = memberSpanMm / planSpanMm;
  return {
    memberSpanMm,
    clearSpanMm: exact.loMm * planToAxis,
    startFaceOffsetMm: exact.startFace.faceT * planToAxis,
    endFaceOffsetMm: (planSpanMm - exact.endFace.faceT) * planToAxis,
  };
}

function barsByRole(segment) {
  const byRole = new Map();
  for (const bar of segment?.bars || []) {
    if (!CUTOFF_ROLES.has(bar.role)) continue;
    const list = byRole.get(bar.role);
    if (list) list.push(bar);
    else byRole.set(bar.role, [bar]);
  }
  return byRole;
}

function cutoffGroupKey(bar) {
  return `${bar.role}|${bar.layer ?? '-'}|${bar.diaName ?? bar.dia}|${bar.grade ?? '-'}`;
}

function groupCutoffBars(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const key = cutoffGroupKey(bar);
    const list = groups.get(key);
    if (list) list.push(bar);
    else groups.set(key, [bar]);
  }
  return groups;
}

function createCutoffPiecesAndChecks({
  bars,
  atEnd,
  endSpec,
  boundaryMm,
  clearSpanMm,
  faceOffsetMm,
  isSmallBeam,
}) {
  const pieces = [];
  const checks = [];
  for (const group of groupCutoffBars(bars).values()) {
    for (const bar of group) {
      const { spanMm, extensionMm } = beamCutoffLengthMm({
        clearSpanMm,
        barDiaMm: bar.dia,
        atEnd,
        isSmallBeam,
        role: bar.role,
      });
      const target = faceOffsetMm + spanMm + (atEnd ? extensionMm : -extensionMm);
      pieces.push(
        axialPiece({
          anchor: endSpec.anchor,
          from: boundaryMm,
          to: target,
          u: bar.u,
          v: bar.v,
          dia: bar.dia,
        }),
      );
    }

    const representative = group[0];
    const { spanMm, extensionMm, totalMm } = beamCutoffLengthMm({
      clearSpanMm,
      barDiaMm: representative.dia,
      atEnd,
      isSmallBeam,
      role: representative.role,
    });
    checks.push({
      category: '梁カットオフ',
      position: `${SIDE_LABELS[endSpec.side]} ${atEnd ? '端部カットオフ筋' : '中央カットオフ筋'}`,
      role: representative.role === 'top' ? '上端筋' : '下端筋',
      layer: representative.layer ?? null,
      diaMm: representative.dia,
      grade: representative.grade || null,
      count: group.length,
      fc: null,
      requiredMm: atEnd ? 2 * totalMm : totalMm,
      availableMm: atEnd ? clearSpanMm : null,
      exact: true,
      ok: atEnd ? clearSpanMm >= 2 * totalMm : null,
      note:
        `${representative.layer ? `${representative.layer}段 ` : ''}` +
        `柱面から ${Math.round(spanMm)}mm＋余長 ${Math.round(extensionMm)}mm ＝ ${Math.round(totalMm)}mm` +
        `（Lo=${Math.round(clearSpanMm)}mm）。` +
        (atEnd
          ? '両側の合計が内法スパンを超えると中央で重なるため通し筋とする'
          : '中央側からの伸ばし'),
    });
  }
  return { pieces, checks };
}

function unresolvedIdentityChecks(endSpec, role, unresolved) {
  return unresolved.map((item) => ({
    category: '梁カットオフ',
    position: `${SIDE_LABELS[endSpec.side]} identity未解決`,
    role: role === 'top' ? '上端筋' : '下端筋',
    layer: null,
    diaMm: null,
    grade: null,
    count: (item.leftBars?.length || 0) + (item.rightBars?.length || 0),
    fc: null,
    requiredMm: null,
    availableMm: null,
    exact: false,
    ok: null,
    identityStatus: 'unresolvedMatch',
    note:
      item.reason === 'semantic-mismatch'
        ? `role/layerは同じだが径・材質等が一致せず通し筋identityを確定できない（${item.semanticKey}）`
        : `断面内位置の候補が同距離または許容距離外で通し筋identityを一意に確定できない（${item.semanticKey}）`,
  }));
}

function buildEndCutoff({ endSpec, layout, clearSpanMm, faceOffsetMm, isSmallBeam }) {
  const pieces = [];
  const checks = [];
  const segments = layout.segments;
  const outer = endSpec.outerIndex === 0 ? segments[0] : segments[segments.length - 1];
  const inner = endSpec.outerIndex === 0 ? segments[1] : segments[segments.length - 2];
  if (!outer || !inner) return { pieces, checks };

  const boundaryRatio = endSpec.outerIndex === 0 ? outer.endRatio : 1 - outer.startRatio;
  const boundaryMm = boundaryRatio * (layout.spanMm || 0);
  const outerByRole = barsByRole(outer);
  const innerByRole = barsByRole(inner);
  const roles = new Set([...outerByRole.keys(), ...innerByRole.keys()]);

  for (const role of roles) {
    const outerBars = outerByRole.get(role) || [];
    const innerBars = innerByRole.get(role) || [];
    const matched = matchRebarFacts(outerBars, innerBars);

    const endBuilt = createCutoffPiecesAndChecks({
      bars: matched.unmatchedLeft,
      atEnd: true,
      endSpec,
      boundaryMm,
      clearSpanMm,
      faceOffsetMm,
      isSmallBeam,
    });
    pieces.push(...endBuilt.pieces);
    checks.push(...endBuilt.checks);

    const centerBuilt = createCutoffPiecesAndChecks({
      bars: matched.unmatchedRight,
      atEnd: false,
      endSpec,
      boundaryMm,
      clearSpanMm,
      faceOffsetMm,
      isSmallBeam,
    });
    pieces.push(...centerBuilt.pieces);
    checks.push(...centerBuilt.checks);
    checks.push(...unresolvedIdentityChecks(endSpec, role, matched.unresolved));
  }
  return { pieces, checks };
}

function resolveCutoffGeometry(scanTag, beamEl, isSmallBeam, index = null) {
  if (!isSmallBeam) {
    const exact = resolveBeamClearSpanFromScanner(scanTag, beamEl, index);
    if (!exact) return null;
    const metric = resolveGirderAxisMetric(scanTag, beamEl, exact, index);
    if (!metric) return null;
    return {
      ...metric,
      geometrySource: 'exact-column-face',
    };
  }

  const span = resolveLegacyBeamSpan(scanTag, beamEl, index);
  if (!span) return null;
  const depthStart = legacyColumnDepthAtNode(
    scanTag,
    beamEl.getAttribute('id_node_start'),
    span.dir,
    index,
  );
  const depthEnd = legacyColumnDepthAtNode(
    scanTag,
    beamEl.getAttribute('id_node_end'),
    span.dir,
    index,
  );
  const clearSpanMm = span.spanMm - (depthStart + depthEnd) / 2;
  if (!(clearSpanMm > 0)) return null;
  return {
    memberSpanMm: span.spanMm,
    clearSpanMm,
    startFaceOffsetMm: depthStart / 2,
    endFaceOffsetMm: depthEnd / 2,
    geometrySource: 'legacy-projected-depth',
  };
}

function buildBeamCutoff({ beamEl, layout, scanTag, isSmallBeam, index = null }) {
  if (!layout.segments || layout.segments.length < 3) return null;
  const geometry = resolveCutoffGeometry(scanTag, beamEl, isSmallBeam, index);
  if (!geometry) return null;

  const pieces = [];
  const checks = [];
  for (const endSpec of BEAM_ENDS) {
    const built = buildEndCutoff({
      endSpec,
      layout: { ...layout, spanMm: geometry.memberSpanMm },
      clearSpanMm: geometry.clearSpanMm,
      faceOffsetMm:
        endSpec.side === 'start' ? geometry.startFaceOffsetMm : geometry.endFaceOffsetMm,
      isSmallBeam,
    });
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }

  const filtered = pieces.filter(Boolean);
  if (filtered.length === 0 && checks.length === 0) return null;
  return {
    pieces: filtered,
    checks,
    clearSpanMm: geometry.clearSpanMm,
    geometrySource: geometry.geometrySource,
  };
}

export function buildBeamCutoffMaps(xmlDoc, beamLayoutMaps, sharedScanTag = null) {
  const result = { girder: new Map(), beam: new Map(), checks: [] };
  if (!xmlDoc || !beamLayoutMaps) return result;

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex = buildRebarModelIndex(xmlDoc, { scanTag });
  const targets = [
    {
      tagName: 'StbGirder',
      layouts: beamLayoutMaps.girder,
      map: result.girder,
      kind: '大梁',
      isSmallBeam: false,
    },
    {
      tagName: 'StbBeam',
      layouts: beamLayoutMaps.beam,
      map: result.beam,
      kind: '小梁',
      isSmallBeam: true,
    },
  ];

  for (const target of targets) {
    if (!target.layouts?.size) continue;
    for (const beamEl of scanTag(target.tagName)) {
      const layout = target.layouts.get(String(beamEl.getAttribute('id_section')));
      if (!layout) continue;
      const elementId = beamEl.getAttribute('id');
      if (!elementId) continue;

      const identity = assignBeamBarIdentities(layout.segments);
      const built = buildBeamCutoff({
        beamEl,
        layout,
        scanTag,
        isSmallBeam: target.isSmallBeam,
        index: modelIndex,
      });
      if (!built) continue;

      if (built.pieces.length > 0 || identity.unresolvedMatches.length > 0) {
        target.map.set(elementId, {
          elementId,
          pieces: built.pieces,
          clearSpanMm: built.clearSpanMm,
          geometrySource: built.geometrySource,
          identityTransitions: identity.transitions,
          unresolvedMatches: identity.unresolvedMatches,
        });
      }
      const elementName = beamEl.getAttribute('name') || null;
      for (const check of built.checks) {
        result.checks.push({
          kind: target.kind,
          elementId,
          elementName,
          sectionName: layout.sectionName || null,
          geometrySource: built.geometrySource,
          ...check,
        });
      }
    }
  }
  return result;
}
