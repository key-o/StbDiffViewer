/**
 * @fileoverview RC梁主筋の柱内定着（90°折曲げ定着）の算定（3D配筋用）
 *
 * P0-D2 では、日建連・JSCA 2023 の「フック付定着長さ L2h」と、
 * L2h を確保できない場合の「投影長さ La + 全長 L2」代替定着を分離して扱う。
 * ST-Bridgeには定着形状の情報が無いため、標準図に基づく想定配置として生成する。
 * R8-A では大梁の折曲げ定着に伴う吊上げ筋を「構造図依存の未生成要求」として
 * 既存の定着判定行へ明示し、仕様を推定して3D形状を自動生成しない。
 * @module data/extractors/rebar3d/beamAnchoragePlacement
 */

import {
  DEFAULT_BAR_GRADE,
  DEFAULT_CONCRETE_FC,
  REBAR_ANCHORAGE_RULES,
  parseConcreteFc,
} from '../../../constants/rebarAnchorageRules.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { resolveMemberConcreteStrength } from '../concreteStrengthResolver.js';
import {
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnAtNode,
  getNodeCoord,
} from '../columnSupportUtils.js';
import { axialPiece, tailPiece } from './rebarPieces.js';
import { buildColumnRebarLayoutMap } from './columnRebarPlacement.js';
import { resolveColumnRebarAvailableProjection } from './columnRebarClearProjection.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { collectRebarAppendixA2JointAssemblyChecks } from './rebarAppendixA2JointAssemblyChecks.js';
import { buildAppendixA2CornerAnchorageGateMap } from './rebarAppendixA2JointProductionChoice.js';
import { buildAppendixA2CornerAnchoragePaths } from './rebarAppendixA2CornerAnchoragePath.js';
import { resolveAppendixA2UShapePairingAssignment } from './rebarAppendixA2UShapeProduction.js';

/** 梁端の位置と、そこで参照する区間・材軸方向の符号 */
const BEAM_ENDS = [
  { side: 'start', nodeAttr: 'id_node_start', segmentIndex: 'first', axialSign: -1 },
  { side: 'end', nodeAttr: 'id_node_end', segmentIndex: 'last', axialSign: 1 },
];

/** 梁端の表示名 */
const SIDE_LABELS = { start: '始端', end: '終端' };

/** 定着筋として扱う主筋の役割（腹筋は柱へ定着させない） */
const ANCHORED_ROLES = new Set(['top', 'bottom']);

const ANCHORAGE_MODES = Object.freeze({
  L2H: 'L2H',
  L2_FALLBACK: 'L2_FALLBACK',
  NG: 'NG',
  SPECIAL: 'SPECIAL',
});

function readPlanOffset(element, prefix) {
  return {
    x: parseFloat(element?.getAttribute(`${prefix}_X`)) || 0,
    y: parseFloat(element?.getAttribute(`${prefix}_Y`)) || 0,
  };
}

/**
 * 梁端オフセットを反映した平面上の始終点と材軸方向を求める。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} beamEl - 梁要素
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {{start:{x:number,y:number},end:{x:number,y:number},direction:{x:number,y:number}}|null}
 */
function resolveBeamPlanGeometry(scanTag, beamEl, index = null) {
  const startNode = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'), index);
  const endNode = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'), index);
  if (!startNode || !endNode) return null;

  const startOffset = readPlanOffset(beamEl, 'offset_start');
  const endOffset = readPlanOffset(beamEl, 'offset_end');
  const start = { x: startNode.x + startOffset.x, y: startNode.y + startOffset.y };
  const end = { x: endNode.x + endOffset.x, y: endNode.y + endOffset.y };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const planLength = Math.hypot(dx, dy);
  if (!(planLength > 0)) return null;
  return { start, end, direction: { x: dx / planLength, y: dy / planLength } };
}

/**
 * 梁接続節点における実柱芯の平面座標を求める。
 * @param {Element} columnEl - 柱要素
 * @param {string} nodeId - 梁端節点ID
 * @param {{x:number,y:number}} node - 節点座標
 * @returns {{x:number,y:number}} 実柱芯座標
 */
function resolveColumnCenterAtNode(columnEl, nodeId, node) {
  let prefix = null;
  if (columnEl.getAttribute('id_node_top') === nodeId) prefix = 'offset_top';
  else if (columnEl.getAttribute('id_node_bottom') === nodeId) prefix = 'offset_bottom';
  const offset = prefix ? readPlanOffset(columnEl, prefix) : { x: 0, y: 0 };
  return { x: node.x + offset.x, y: node.y + offset.y };
}

function anchoredBarsOf(segment) {
  return (segment?.bars || []).filter((bar) => ANCHORED_ROLES.has(bar.role));
}

function normalizedGrade(grade) {
  return REBAR_STANDARD_RULES.normalizeGrade(grade) || DEFAULT_BAR_GRADE;
}

function groupKey(role, dia, grade) {
  return `${role}|${dia}|${normalizedGrade(grade)}`;
}

/**
 * 90°折曲げ定着について L2 / L2h / La を別々に保持し、採用モードを決定する。
 *
 * - L2h を確保できる場合: L2H
 * - L2h は不足するが La を確保できる場合:
 *   投影長 La を満足させ、折曲げ後余長を伸ばして全長 L2 を確保する L2_FALLBACK
 * - La も不足する場合: NG
 * - 表外Fc/鋼種: SPECIAL
 *
 * @param {Array<Object>} bars - 定着対象の主筋
 * @param {Object} context - {fc, fcSource, columnDepthMm, availableMm, tailFactor}
 * @returns {Array<Object>} 判定行
 */
function buildChecks(bars, context) {
  const groups = new Map();
  for (const bar of bars) {
    const grade = normalizedGrade(bar.grade);
    const key = groupKey(bar.role, bar.dia, grade);
    const group = groups.get(key);
    if (group) {
      group.count++;
    } else {
      groups.set(key, { role: bar.role, diaMm: bar.dia, grade, count: 1 });
    }
  }

  const projectionDepthRatio = REBAR_STANDARD_RULES.resolveColumnProjectionDepthRatio();
  return [...groups.values()].map((group) => {
    const l2 = REBAR_STANDARD_RULES.resolveLengthFactor({
      kind: 'l2',
      fc: context.fc,
      grade: group.grade,
    });
    const l2h = REBAR_STANDARD_RULES.resolveLengthFactor({
      kind: 'l2h',
      fc: context.fc,
      grade: group.grade,
    });
    const la = REBAR_STANDARD_RULES.resolveLengthFactor({
      kind: 'la',
      fc: context.fc,
      grade: group.grade,
    });

    const l2RequiredMm = l2.ok ? l2.factor * group.diaMm : null;
    const l2hRequiredMm = l2h.ok ? l2h.factor * group.diaMm : null;
    const laByTableMm = la.ok ? la.factor * group.diaMm : null;
    const minByColumnMm = context.columnDepthMm * projectionDepthRatio;
    const laRequiredMm = la.ok ? Math.max(laByTableMm, minByColumnMm) : null;
    const hasAvailableProjection = Number.isFinite(context.availableMm);
    const l2hOk =
      Number.isFinite(l2hRequiredMm) && hasAvailableProjection
        ? context.availableMm >= l2hRequiredMm
        : null;
    const laOk =
      Number.isFinite(laRequiredMm) && hasAvailableProjection
        ? context.availableMm >= laRequiredMm
        : null;
    const specialRequired = !l2.ok || !l2h.ok || !la.ok || context.projectionResolved === false;
    const baseTailMm = context.tailFactor * group.diaMm;

    let anchorageMode = ANCHORAGE_MODES.SPECIAL;
    let ok = null;
    let requiredMm = null;
    let totalRequiredMm = null;
    let requiredTailMm = baseTailMm;

    if (!specialRequired) {
      if (l2hOk) {
        anchorageMode = ANCHORAGE_MODES.L2H;
        ok = true;
        requiredMm = l2hRequiredMm;
      } else if (laOk) {
        anchorageMode = ANCHORAGE_MODES.L2_FALLBACK;
        ok = true;
        requiredMm = laRequiredMm;
        totalRequiredMm = l2RequiredMm;
        requiredTailMm = Math.max(baseTailMm, l2RequiredMm - context.availableMm);
      } else {
        anchorageMode = ANCHORAGE_MODES.NG;
        ok = false;
        requiredMm = laRequiredMm;
        totalRequiredMm = l2RequiredMm;
      }
    }

    return {
      ...group,
      fc: context.fc,
      fcSource: context.fcSource,
      standardId: REBAR_STANDARD_RULES.standardId,
      availableMm: context.availableMm,
      columnRebarSource: context.columnRebarSource || null,
      projectionResolved: context.projectionResolved !== false,
      unresolvedReasons: context.unresolvedReasons || [],
      requiredMm,
      totalRequiredMm,
      l2Factor: l2.factor,
      l2RequiredMm,
      l2hFactor: l2h.factor,
      l2hMm: l2hRequiredMm,
      l2hRequiredMm,
      l2hOk,
      laFactor: la.factor,
      laByTableMm,
      laRequiredMm,
      laOk,
      minByColumnMm,
      projectionDepthRatio,
      baseTailMm,
      requiredTailMm,
      anchorageMode,
      specialRequired,
      exact: !specialRequired,
      ok,
    };
  });
}

/**
 * 梁端1か所分の定着を組み立てる。
 * @param {Object} params - 算定パラメータ
 * @returns {Object|null} 定着データ
 */
function buildEndAnchorage({
  beamEl,
  endSpec,
  layout,
  scanTag,
  beamGeometry,
  columnLayouts,
  options,
  index = null,
}) {
  const nodeId = beamEl.getAttribute(endSpec.nodeAttr);
  const node = getNodeCoord(scanTag, nodeId, index);
  const columnEl = findColumnAtNode(scanTag, nodeId, index);
  if (!node || !columnEl) return null;

  const beamDir = beamGeometry.direction;
  const columnSectionId = columnEl.getAttribute('id_section');
  const dims = extractColumnPlanDimensions(scanTag, columnSectionId, index);
  if (!dims) return null;
  const columnLayout = columnLayouts?.get(String(columnSectionId)) || null;
  const projection = resolveColumnRebarAvailableProjection({
    columnEl,
    columnLayout,
    columnDimensions: dims,
    nodeId,
    beamDirection: beamDir,
    beamSide: endSpec.side,
  });
  const columnDepthMm = projection.columnDepthMm;
  if (!(columnDepthMm > 0)) return null;

  const segments = layout.segments;
  const segment = endSpec.segmentIndex === 'first' ? segments[0] : segments[segments.length - 1];
  const bars = anchoredBarsOf(segment);
  if (bars.length === 0) return null;

  const standardCoverMm = REBAR_STANDARD_RULES.resolveColumnBeamCover().designMm;
  const coverMm = options.columnCoverMm ?? standardCoverMm;
  const availableMm = projection.availableProjectionMm;
  const strength = resolveMemberConcreteStrength({
    scanTag,
    memberEl: columnEl,
    sectionStrength: dims?.strengthConcrete,
    storyNodeId: columnEl.getAttribute('id_node_top'),
  });
  const parsedFc = parseConcreteFc(strength.value);
  const fc = parsedFc ?? DEFAULT_CONCRETE_FC;
  const fcSource = parsedFc === null ? 'default' : strength.source;

  const beamEndPoint = endSpec.side === 'start' ? beamGeometry.start : beamGeometry.end;
  const columnCenter = resolveColumnCenterAtNode(columnEl, nodeId, node);
  const columnCenterOffsetAlongBeamMm =
    (columnCenter.x - beamEndPoint.x) * beamDir.x + (columnCenter.y - beamEndPoint.y) * beamDir.y;
  const columnCenterOffsetInwardMm =
    endSpec.side === 'start' ? columnCenterOffsetAlongBeamMm : -columnCenterOffsetAlongBeamMm;
  const bendFromBeamEndMm = Number.isFinite(availableMm)
    ? columnCenterOffsetInwardMm + columnDepthMm / 2 - availableMm
    : null;
  const tailFactor =
    REBAR_STANDARD_RULES.resolveHookTailFactor(90) ?? REBAR_ANCHORAGE_RULES.tailDiaFactor;
  const checks = buildChecks(bars, {
    fc,
    fcSource,
    columnDepthMm,
    availableMm,
    tailFactor,
    projectionResolved: projection.resolved,
    columnRebarSource: projection.source,
    unresolvedReasons: projection.unresolvedReasons,
  });
  const checkByGroup = new Map(
    checks.map((check) => [groupKey(check.role, check.diaMm, check.grade), check]),
  );

  return {
    side: endSpec.side,
    axialSign: endSpec.axialSign,
    nodeId,
    columnId: columnEl.getAttribute('id') || null,
    columnName: columnEl.getAttribute('name') || dims?.name || null,
    columnDepthMm,
    coverMm,
    availableMm,
    columnRebarSource: projection.source,
    projectionResolved: projection.resolved,
    unresolvedReasons: projection.unresolvedReasons,
    farBoundaryFromCenterMm: projection.farBoundaryFromCenterMm,
    columnBarsUsed: projection.barsUsed,
    concreteStrength: strength.value,
    fc,
    fcSource,
    columnCenterOffsetInwardMm,
    bendFromBeamEndMm,
    extensionMm: Number.isFinite(bendFromBeamEndMm) ? Math.max(0, -bendFromBeamEndMm) : null,
    bars: bars.map((bar) => {
      const check = checkByGroup.get(groupKey(bar.role, bar.dia, bar.grade));
      return {
        u: bar.u,
        v: bar.v,
        dia: bar.dia,
        diaName: bar.diaName || null,
        grade: bar.grade || null,
        role: bar.role,
        layer: bar.layer ?? null,
        identityKey: bar.identityKey || null,
        positionZone: bar.positionZone || segment?.positionZone || null,
        anchorageMode: check?.anchorageMode || ANCHORAGE_MODES.SPECIAL,
        tailLengthMm: check?.requiredTailMm ?? tailFactor * bar.dia,
        tailDir: bar.role === 'top' ? -1 : 1,
      };
    }),
    checks,
  };
}

function buildBeamAnchorage({ beamEl, layout, scanTag, columnLayouts, options, index = null }) {
  const beamGeometry = resolveBeamPlanGeometry(scanTag, beamEl, index);
  if (!beamGeometry) return null;

  const ends = BEAM_ENDS.map((endSpec) =>
    buildEndAnchorage({
      beamEl,
      endSpec,
      layout,
      scanTag,
      beamGeometry,
      columnLayouts,
      options,
      index,
    }),
  ).filter(Boolean);
  if (ends.length === 0) return null;

  return {
    elementId: beamEl.getAttribute('id') || null,
    elementName: beamEl.getAttribute('name') || null,
    sectionName: layout.sectionName || null,
    ends,
    pieces: ends.flatMap(buildEndPieces).filter(Boolean),
  };
}

export function applyAppendixA2CornerAnchorageGates(anchorage, gateMap, options = {}) {
  if (!anchorage?.elementId || !(gateMap instanceof Map) || gateMap.size === 0) return anchorage;

  const ends = (anchorage.ends || []).map((end) => {
    const gate = gateMap.get(`${anchorage.elementId}|${end.side}`) || null;
    if (!gate) return end;
    const pathBuild =
      gate.method === 'U_SHAPE_ANCHORAGE'
        ? resolveAppendixA2UShapePairingAssignment({
            memberId: anchorage.elementId,
            endpoint: end.side,
            projectDetailing: options.projectDetailing,
          })
        : buildAppendixA2CornerAnchoragePaths({ end, gate });
    return {
      ...end,
      appendixA2CornerAnchorageGate: gate,
      appendixA2CornerAnchoragePathBuild: pathBuild,
    };
  });
  const suppressedEnds = ends
    .filter((end) => end.appendixA2CornerAnchorageGate)
    .map((end) => ({
      side: end.side,
      nodeId: end.nodeId,
      gate: end.appendixA2CornerAnchorageGate,
      pathStatus: end.appendixA2CornerAnchoragePathBuild?.status || 'UNRESOLVED',
      generatedPathCount: end.appendixA2CornerAnchoragePathBuild?.paths?.length || 0,
    }));

  if (suppressedEnds.length === 0) return anchorage;

  const appendixA2CornerAnchoragePaths = ends.flatMap(
    (end) => end.appendixA2CornerAnchoragePathBuild?.paths || [],
  );

  return {
    ...anchorage,
    ends,
    pieces: ends.flatMap((end) => (end.appendixA2CornerAnchorageGate ? [] : buildEndPieces(end))),
    appendixA2CornerAnchoragePaths,
    appendixA2CornerAnchorageSuppression: {
      suppressedEnds,
      genericAnchorageSuppressed: true,
      generatedPathCount: appendixA2CornerAnchoragePaths.length,
      source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    },
  };
}

/**
 * 梁端の定着を、部材端を基準にした鉄筋片へ展開する。
 * @param {Object} end - buildEndAnchorage の結果
 * @returns {Array<Object>} 鉄筋片
 */
function buildEndPieces(end) {
  if (!Number.isFinite(end.bendFromBeamEndMm)) return [];
  const anchor = end.side;
  const bendFromBeamEndMm = end.bendFromBeamEndMm;
  return end.bars.flatMap((bar) => [
    axialPiece({
      anchor,
      from: 0,
      to: bendFromBeamEndMm,
      u: bar.u,
      v: bar.v,
      dia: bar.dia,
    }),
    tailPiece({
      anchor,
      at: bendFromBeamEndMm,
      u: bar.u,
      v: bar.v,
      dia: bar.dia,
      dir: 'v',
      sign: bar.tailDir,
      length: bar.tailLengthMm,
    }),
  ]);
}

function formatLengthCheck(check, end) {
  const l2 = Number.isFinite(check.l2RequiredMm)
    ? `L2=${check.l2Factor}d=${Math.round(check.l2RequiredMm)}mm`
    : 'L2=要特記';
  const l2h = Number.isFinite(check.l2hRequiredMm)
    ? `L2h=${check.l2hFactor}d=${Math.round(check.l2hRequiredMm)}mm`
    : 'L2h=要特記';
  const la = Number.isFinite(check.laRequiredMm)
    ? `La=max(${check.laFactor}d=${Math.round(check.laByTableMm)}mm, ` +
      `${check.projectionDepthRatio}D=${Math.round(check.minByColumnMm)}mm)` +
      `=${Math.round(check.laRequiredMm)}mm`
    : 'La=要特記';
  const fallback =
    check.anchorageMode === ANCHORAGE_MODES.L2_FALLBACK
      ? `、余長=${Math.round(check.requiredTailMm)}mmで全長L2確保`
      : '';
  const projection = check.projectionResolved
    ? `、柱配筋=${check.columnRebarSource || 'actual-column-rebar'}`
    : `、柱配筋=未解決(${(check.unresolvedReasons || []).join(',') || 'unknown'})`;
  return (
    `${l2}、${l2h}、${la}、採用=${check.anchorageMode}${fallback}${projection}` +
    `（柱せい ${Math.round(end.columnDepthMm)}mm）`
  );
}

function requiresGirderHangerDetailing(kind, check) {
  return (
    kind === '大梁' &&
    (check?.anchorageMode === ANCHORAGE_MODES.L2H ||
      check?.anchorageMode === ANCHORAGE_MODES.L2_FALLBACK)
  );
}

function girderHangerDetailingFields(kind, check) {
  if (!requiresGirderHangerDetailing(kind, check)) return {};
  return {
    generationStatus: 'UNRESOLVED',
    specialDetailingRequired: true,
    specialDetailingType: 'GIRDER_HANGER_REBAR',
    specialDetailingStatus: 'UNRESOLVED',
    specialDetailingSource: 'NIKKENREN-JSCA-2023-8-2-3',
  };
}

function formatGirderHangerDetailingNote(kind, check) {
  if (!requiresGirderHangerDetailing(kind, check)) return '';
  return '、吊上げ筋=未生成（折曲げ主筋すべてに必要。あばら筋とは別途設けるが、仕様は構造図による）';
}

/**
 * STB文書から梁要素ID → 柱内定着のマップを作る。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {{girder: Map<string, Object>, beam: Map<string, Object>}} beamLayoutMaps - 配筋マップ
 * @param {Object} [options] - 算定設定
 * @param {number} [options.columnCoverMm] - 柱かぶり厚さの上書き [mm]
 * @param {function(string): Element[]} [sharedScanTag] - 共有タグ走査関数
 * @param {Map<string, Object>} [sharedColumnLayouts] - 既算定のRC柱主筋配筋マップ
 * @returns {{girder: Map<string, Object>, beam: Map<string, Object>, checks: Array<Object>}}
 */
export function buildBeamAnchorageMaps(
  xmlDoc,
  beamLayoutMaps,
  options = {},
  sharedScanTag = null,
  sharedColumnLayouts = null,
) {
  const result = { girder: new Map(), beam: new Map(), checks: [] };
  if (!xmlDoc || !beamLayoutMaps) return result;

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex = buildRebarModelIndex(xmlDoc, { scanTag });
  const columnLayouts =
    sharedColumnLayouts ||
    buildColumnRebarLayoutMap(xmlDoc, {
      ...(Number.isFinite(Number(options.columnCoverMm))
        ? { coverMm: Number(options.columnCoverMm) }
        : {}),
    });
  const appendixA2JointChecks =
    options.appendixA2JointChecks ||
    collectRebarAppendixA2JointAssemblyChecks(xmlDoc, {
      choice: options.choice,
      beamLayoutMaps,
      columnLayoutMap: columnLayouts,
      geometryChecks: false,
      projectDetailing: options.projectDetailing,
    });
  const appendixA2CornerAnchorageGates =
    options.appendixA2CornerAnchorageGate === false
      ? new Map()
      : buildAppendixA2CornerAnchorageGateMap(appendixA2JointChecks);
  result.appendixA2CornerAnchorageGates = appendixA2CornerAnchorageGates;
  const targets = [
    { tagName: 'StbGirder', layouts: beamLayoutMaps.girder, map: result.girder, kind: '大梁' },
    { tagName: 'StbBeam', layouts: beamLayoutMaps.beam, map: result.beam, kind: '小梁' },
  ];

  for (const target of targets) {
    if (!target.layouts?.size) continue;

    for (const beamEl of scanTag(target.tagName)) {
      const layout = target.layouts.get(String(beamEl.getAttribute('id_section')));
      if (!layout) continue;

      const rawAnchorage = buildBeamAnchorage({
        beamEl,
        layout,
        scanTag,
        columnLayouts,
        options,
        index: modelIndex,
      });
      if (!rawAnchorage?.elementId) continue;

      const anchorage = applyAppendixA2CornerAnchorageGates(
        rawAnchorage,
        appendixA2CornerAnchorageGates,
        { projectDetailing: options.projectDetailing },
      );
      target.map.set(anchorage.elementId, anchorage);
      for (const end of anchorage.ends) {
        for (const check of end.checks) {
          const appendixA2Gate = end.appendixA2CornerAnchorageGate || null;
          const appendixA2PathBuild = end.appendixA2CornerAnchoragePathBuild || null;
          const appendixA2PathReady =
            appendixA2PathBuild?.status === 'CENTERLINE_READY' &&
            (appendixA2PathBuild.paths?.length || 0) > 0;
          const appendixA2PairingReady =
            appendixA2Gate?.method === 'U_SHAPE_ANCHORAGE' &&
            appendixA2PathBuild?.status === 'PAIRING_READY';
          result.checks.push({
            category: '梁定着',
            kind: target.kind,
            elementId: anchorage.elementId,
            elementName: anchorage.elementName,
            sectionName: anchorage.sectionName,
            side: end.side,
            position: `${SIDE_LABELS[end.side]}（柱 ${end.columnName || '-'}）`,
            columnName: end.columnName,
            columnDepthMm: end.columnDepthMm,
            note:
              formatLengthCheck(check, end) +
              formatGirderHangerDetailingNote(target.kind, check) +
              (appendixA2Gate
                ? `、A2隅柱定着=${appendixA2Gate.method || '未指定'}（generic 90°定着を抑制、actual path=${appendixA2PathBuild?.status || 'UNRESOLVED'}）`
                : ''),
            ...girderHangerDetailingFields(target.kind, check),
            ...check,
            ...(appendixA2Gate
              ? appendixA2PathReady
                ? {
                    generationStatus: 'CENTERLINE_READY',
                    specialDetailingRequired: false,
                    specialDetailingType: 'APPENDIX_A2_CORNER_ANCHORAGE',
                    specialDetailingStatus: 'RESOLVED',
                    productionPathCandidate: true,
                    productionConsumer: 'appendix-a2-corner-anchor-local-path',
                    appendixA2CornerAnchorageGate: appendixA2Gate,
                    appendixA2CornerAnchoragePathBuild: appendixA2PathBuild,
                  }
                : appendixA2PairingReady
                  ? {
                      generationStatus: 'PAIRING_READY',
                      specialDetailingRequired: true,
                      specialDetailingType: 'APPENDIX_A2_CORNER_U_SHAPE_PAIRING',
                      specialDetailingStatus: 'PAIRING_READY',
                      productionPathCandidate: false,
                      productionConsumer: 'appendix-a2-u-shape-pairing-pending-member-identity',
                      appendixA2CornerAnchorageGate: appendixA2Gate,
                      appendixA2CornerAnchoragePathBuild: appendixA2PathBuild,
                    }
                  : {
                      generationStatus: 'SPECIAL_REQUIRED',
                      specialDetailingRequired: true,
                      specialDetailingType: 'APPENDIX_A2_CORNER_ANCHORAGE',
                      specialDetailingStatus: 'UNRESOLVED',
                      appendixA2CornerAnchorageGate: appendixA2Gate,
                      appendixA2CornerAnchoragePathBuild: appendixA2PathBuild,
                    }
              : {}),
          });
        }
      }
    }
  }
  return result;
}
