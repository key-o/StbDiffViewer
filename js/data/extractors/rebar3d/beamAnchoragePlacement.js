/**
 * @fileoverview RC梁主筋の柱内定着（90°折曲げ定着）の算定（3D配筋用）
 *
 * 梁端の節点に取り付く柱を探し、梁軸方向の柱せいから水平投影定着長さを求めて、
 * 梁主筋（上端筋・下端筋）を柱内へ伸ばす区間と90°折曲げ後の余長を組み立てる。
 * あわせて、必要定着長さ（表による L2h と柱せいの3/4の大きい方）に対する
 * 判定結果を返す。
 *
 * 梁のメッシュ・主筋は節点間（＝柱芯間）で描かれるため、ここで足すのは
 * 「節点を越えて柱の反対側へ伸びる分」と「その先の折曲げ余長」である。
 *
 * ST-Bridgeには定着形状の情報が無いため、90°折曲げ定着に固定した想定配置で、
 * 判定結果も設計指針に基づく目安である。
 *
 * @module data/extractors/rebar3d/beamAnchoragePlacement
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import {
  DEFAULT_BAR_GRADE,
  DEFAULT_CONCRETE_FC,
  REBAR_ANCHORAGE_RULES,
  computeRequiredHookProjection,
  normalizeBarGrade,
  parseConcreteFc,
} from '../../../constants/rebarAnchorageRules.js';
import {
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnAtNode,
  getNodeCoord,
  projectColumnDepth,
} from '../columnSupportUtils.js';
import { axialPiece, tailPiece } from './rebarPieces.js';

/** 梁端の位置と、そこで参照する区間・材軸方向の符号 */
const BEAM_ENDS = [
  { side: 'start', nodeAttr: 'id_node_start', segmentIndex: 'first', axialSign: -1 },
  { side: 'end', nodeAttr: 'id_node_end', segmentIndex: 'last', axialSign: 1 },
];

/** 梁端の表示名 */
const SIDE_LABELS = { start: '始端', end: '終端' };

/** 定着筋として扱う主筋の役割（腹筋は柱へ定着させない） */
const ANCHORED_ROLES = new Set(['top', 'bottom']);

/**
 * 柱内で梁主筋を折り曲げられる位置までの水平投影長さを求める
 *
 * 梁主筋は柱主筋の内側を通り、反対側の柱主筋の内側で折り曲げるものとして
 * 「柱せい − かぶり − 帯筋外径 − 柱主筋外径」を確保できる長さとする。
 * @param {number} columnDepthMm - 梁軸方向の柱せい [mm]
 * @param {number} coverMm - 柱のかぶり厚さ [mm]
 * @returns {number} 確保できる水平投影長さ [mm]（負にはならない）
 */
function availableProjection(columnDepthMm, coverMm) {
  const hoopOuter = barOuterDiameterMm(
    REBAR_ANCHORAGE_RULES.defaultColumnHoopDia,
    barDiameterMm(REBAR_ANCHORAGE_RULES.defaultColumnHoopDia),
  );
  const mainOuter = barOuterDiameterMm(
    REBAR_ANCHORAGE_RULES.defaultColumnMainDia,
    barDiameterMm(REBAR_ANCHORAGE_RULES.defaultColumnMainDia),
  );
  return Math.max(0, columnDepthMm - coverMm - hoopOuter - mainOuter);
}

/**
 * 梁の平面方向（単位ベクトル）を求める
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} beamEl - 梁要素
 * @returns {{x:number, y:number}|null} 平面単位ベクトル
 */
function resolveBeamDirection(scanTag, beamEl) {
  const start = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'));
  const end = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'));
  if (!start || !end) return null;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const planLength = Math.hypot(dx, dy);
  // 平面上で長さを持たない（鉛直な）梁は柱せいの投影ができない
  if (planLength <= 0) return null;
  return { x: dx / planLength, y: dy / planLength };
}

/**
 * 区間から定着対象の主筋を取り出し、呼び径・種別ごとにまとめる
 * @param {Object} segment - 材軸方向の区間
 * @returns {Array<{u:number, v:number, dia:number, role:string, grade:string|null}>} 定着対象
 */
function anchoredBarsOf(segment) {
  return (segment?.bars || []).filter((bar) => ANCHORED_ROLES.has(bar.role));
}

/**
 * 定着対象の主筋を「役割・呼び径・種別」でまとめて判定行を作る
 * @param {Array<Object>} bars - 定着対象の主筋
 * @param {Object} context - {fc, columnDepthMm, availableMm}
 * @returns {Array<Object>} 判定行
 */
function buildChecks(bars, context) {
  const groups = new Map();
  for (const bar of bars) {
    const grade = normalizeBarGrade(bar.grade) || DEFAULT_BAR_GRADE;
    const key = `${bar.role}|${bar.dia}|${grade}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
    } else {
      groups.set(key, { role: bar.role, diaMm: bar.dia, grade, count: 1 });
    }
  }

  return [...groups.values()].map((group) => {
    const required = computeRequiredHookProjection({
      barDiaMm: group.diaMm,
      columnDepthMm: context.columnDepthMm,
      fc: context.fc,
      grade: group.grade,
    });
    return {
      ...group,
      fc: context.fc,
      availableMm: context.availableMm,
      requiredMm: required.requiredMm,
      l2hMm: required.l2hMm,
      minByColumnMm: required.minByColumnMm,
      l2hFactor: required.factor,
      /** 表を丸めた（Fc範囲外・表に無い鉄筋種別）場合 false */
      exact: required.exact,
      ok: context.availableMm >= required.requiredMm,
    };
  });
}

/**
 * 梁端1か所分の定着を組み立てる
 * @param {Object} params - 算定パラメータ
 * @returns {Object|null} 定着データ（柱が無い等で算定できない場合 null）
 */
function buildEndAnchorage({ beamEl, endSpec, layout, scanTag, beamDir, options }) {
  const nodeId = beamEl.getAttribute(endSpec.nodeAttr);
  const columnEl = findColumnAtNode(scanTag, nodeId);
  if (!columnEl) return null;

  const dims = extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'));
  const columnDepthMm = projectColumnDepth(dims, beamDir);
  if (!(columnDepthMm > 0)) return null;

  const segments = layout.segments;
  const segment = endSpec.segmentIndex === 'first' ? segments[0] : segments[segments.length - 1];
  const bars = anchoredBarsOf(segment);
  if (bars.length === 0) return null;

  const coverMm = options.columnCoverMm ?? REBAR_ANCHORAGE_RULES.defaultColumnCoverMm;
  const availableMm = availableProjection(columnDepthMm, coverMm);
  const fc =
    parseConcreteFc(dims?.strengthConcrete) ??
    parseConcreteFc(layout.concreteStrength) ??
    DEFAULT_CONCRETE_FC;

  return {
    side: endSpec.side,
    axialSign: endSpec.axialSign,
    nodeId,
    columnId: columnEl.getAttribute('id') || null,
    columnName: columnEl.getAttribute('name') || dims?.name || null,
    columnDepthMm,
    availableMm,
    /**
     * 節点（柱芯）を越えて描く延長。主筋は既に柱芯まで描かれているため、
     * 水平投影長さから柱せいの半分を引いた分だけ足す。
     */
    extensionMm: Math.max(0, availableMm - columnDepthMm / 2),
    bars: bars.map((bar) => ({
      u: bar.u,
      v: bar.v,
      dia: bar.dia,
      role: bar.role,
      /** 90°折曲げ後の余長 8d。上端筋は下向き、下端筋は上向きへ曲げる */
      tailLengthMm: REBAR_ANCHORAGE_RULES.tailDiaFactor * bar.dia,
      tailDir: bar.role === 'top' ? -1 : 1,
    })),
    checks: buildChecks(bars, { fc, columnDepthMm, availableMm }),
  };
}

/**
 * 梁要素1本分の定着を組み立てる
 * @param {Object} params - 算定パラメータ
 * @returns {Object|null} 定着データ（両端とも算定できない場合 null）
 */
function buildBeamAnchorage({ beamEl, layout, scanTag, options }) {
  const beamDir = resolveBeamDirection(scanTag, beamEl);
  if (!beamDir) return null;

  const ends = BEAM_ENDS.map((endSpec) =>
    buildEndAnchorage({ beamEl, endSpec, layout, scanTag, beamDir, options }),
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

/**
 * 梁端の定着を、部材端を基準にした鉄筋片へ展開する
 *
 * 主筋は節点（柱芯）まで描かれているため、鉄筋片は節点より外側
 * （距離が負）へ伸びる水平部と、その先の折曲げ余長になる。
 * @param {Object} end - buildEndAnchorage の結果
 * @returns {Array<Object>} 鉄筋片
 */
function buildEndPieces(end) {
  const anchor = end.side;
  const extension = end.extensionMm || 0;
  return end.bars.flatMap((bar) => [
    axialPiece({ anchor, from: 0, to: -extension, u: bar.u, v: bar.v, dia: bar.dia }),
    tailPiece({
      anchor,
      at: -extension,
      u: bar.u,
      v: bar.v,
      dia: bar.dia,
      dir: 'v',
      sign: bar.tailDir,
      length: bar.tailLengthMm,
    }),
  ]);
}

/**
 * STB文書から梁要素ID → 柱内定着のマップを作る
 *
 * 大梁（StbGirder）と小梁（StbBeam）は断面IDの採番空間が独立しているため、
 * 主筋配置マップと同じくマップを分けて返す。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {{girder: Map<string, Object>, beam: Map<string, Object>}} beamLayoutMaps -
 *   buildBeamRebarLayoutMaps の結果
 * @param {Object} [options] - 算定設定
 * @param {number} [options.columnCoverMm] - 柱かぶり厚さの上書き [mm]
 * @param {function(string): Element[]} [sharedScanTag] - 呼び出し元と共有するタグ走査関数（省略時は新規作成）
 * @returns {{girder: Map<string, Object>, beam: Map<string, Object>, checks: Array<Object>}}
 *   要素ID → 定着データと、全梁端の判定行
 */
export function buildBeamAnchorageMaps(xmlDoc, beamLayoutMaps, options = {}, sharedScanTag = null) {
  const result = { girder: new Map(), beam: new Map(), checks: [] };
  if (!xmlDoc || !beamLayoutMaps) return result;

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const targets = [
    { tagName: 'StbGirder', layouts: beamLayoutMaps.girder, map: result.girder, kind: '大梁' },
    { tagName: 'StbBeam', layouts: beamLayoutMaps.beam, map: result.beam, kind: '小梁' },
  ];

  for (const target of targets) {
    if (!target.layouts?.size) continue;

    for (const beamEl of scanTag(target.tagName)) {
      const layout = target.layouts.get(String(beamEl.getAttribute('id_section')));
      if (!layout) continue;

      const anchorage = buildBeamAnchorage({ beamEl, layout, scanTag, options });
      if (!anchorage?.elementId) continue;

      target.map.set(anchorage.elementId, anchorage);
      for (const end of anchorage.ends) {
        for (const check of end.checks) {
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
              `L2h=${check.l2hFactor}d=${Math.round(check.l2hMm)}mm、` +
              `柱せいの3/4=${Math.round(check.minByColumnMm)}mm（柱せい ${Math.round(end.columnDepthMm)}mm）`,
            ...check,
          });
        }
      }
    }
  }
  return result;
}
