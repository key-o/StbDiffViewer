/**
 * @fileoverview RC梁（大梁・小梁）主筋のカットオフ筋長さの算定（3D配筋用）
 *
 * 出典: 日本建設業連合会「鉄筋コンクリート造配筋標準図」(2013.03.27 改訂)
 * §8-1（大梁カットオフ筋長さおよび継手位置）／§9-1（小梁の定着・カットオフ筋長さ）。
 *
 * 梁主筋は断面の LEFT / CENTER / RIGHT で本数が変わるため、隣り合う区間で
 * 本数が違うところがカットオフ位置になる。断面配置（区間比率）は節点間の
 * 全長を基準にしているのに対し、標準図のカットオフ位置は内法スパン Lo と
 * 柱面を基準とするため、その差と余長（端部15d・中央20d）を鉄筋片として足す。
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
import { pickExtraBars } from './rebarSectionUtils.js';

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
 * 梁の平面方向と節点間距離を求める
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} beamEl - 梁要素
 * @returns {{dir:{x:number, y:number}, spanMm:number}|null} 平面方向とスパン
 */
function resolveBeamSpan(scanTag, beamEl) {
  const start = getNodeCoord(scanTag, beamEl.getAttribute('id_node_start'));
  const end = getNodeCoord(scanTag, beamEl.getAttribute('id_node_end'));
  if (!start || !end) return null;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const planLength = Math.hypot(dx, dy);
  if (!(planLength > 0)) return null;
  return { dir: { x: dx / planLength, y: dy / planLength }, spanMm: planLength };
}

/**
 * 梁端に取り付く柱のせい（梁軸方向）を求める
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} nodeId - 節点ID
 * @param {{x:number, y:number}} beamDir - 梁軸の平面単位ベクトル
 * @returns {number} 柱せい [mm]（柱が無い場合 0）
 */
function columnDepthAtNode(scanTag, nodeId, beamDir) {
  const columnEl = findColumnAtNode(scanTag, nodeId);
  if (!columnEl) return 0;
  const dims = extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'));
  return Math.max(0, projectColumnDepth(dims, beamDir));
}

/**
 * 区間の主筋を役割ごとに分ける
 * @param {Object} segment - 材軸方向の区間
 * @returns {Map<string, Array<Object>>} 役割 → 主筋
 */
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

/**
 * 梁端1か所分のカットオフ筋を組み立てる
 * @param {Object} params - 算定パラメータ
 * @returns {{pieces:Array, checks:Array}} 鉄筋片と判定行
 */
function buildEndCutoff({ endSpec, layout, clearSpanMm, faceOffsetMm, isSmallBeam }) {
  const pieces = [];
  const checks = [];
  const segments = layout.segments;
  const outer = endSpec.outerIndex === 0 ? segments[0] : segments[segments.length - 1];
  const inner = endSpec.outerIndex === 0 ? segments[1] : segments[segments.length - 2];
  if (!outer || !inner) return { pieces, checks };

  // 区間境界の、基準端からの距離（内向き正）
  const boundaryRatio = endSpec.outerIndex === 0 ? outer.endRatio : 1 - outer.startRatio;
  const boundaryMm = boundaryRatio * (layout.spanMm || 0);

  const outerByRole = barsByRole(outer);
  const innerByRole = barsByRole(inner);
  const roles = new Set([...outerByRole.keys(), ...innerByRole.keys()]);

  for (const role of roles) {
    const outerBars = outerByRole.get(role) || [];
    const innerBars = innerByRole.get(role) || [];
    // 端部にしか無い筋＝端部カットオフ筋、中央にしか無い筋＝中央カットオフ筋
    const atEnd = outerBars.length > innerBars.length;
    const [more, fewer] = atEnd ? [outerBars, innerBars] : [innerBars, outerBars];
    const extras = more.length === fewer.length ? [] : pickExtraBars(more, fewer);
    if (extras.length === 0) continue;

    for (const bar of extras) {
      const { spanMm, extensionMm } = beamCutoffLengthMm({
        clearSpanMm,
        barDiaMm: bar.dia,
        atEnd,
        isSmallBeam,
        role,
      });
      // 標準図のカットオフ位置は柱面基準。端部カットオフ筋は Lo/4 の内側へ余長を、
      // 中央カットオフ筋は Lo/4 の外側へ余長を伸ばす
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

    // 端部カットオフ筋は両側の合計が内法スパンを超えると中央で重なる（§8-1 注記）。
    // 中央カットオフ筋は重なりが起きないため参考表示のみ（ok = null）。
    const representative = extras[0];
    const { spanMm, extensionMm, totalMm } = beamCutoffLengthMm({
      clearSpanMm,
      barDiaMm: representative.dia,
      atEnd,
      isSmallBeam,
      role,
    });
    checks.push({
      category: '梁カットオフ',
      position: `${SIDE_LABELS[endSpec.side]} ${atEnd ? '端部カットオフ筋' : '中央カットオフ筋'}`,
      role: role === 'top' ? '上端筋' : '下端筋',
      diaMm: representative.dia,
      grade: null,
      count: extras.length,
      fc: null,
      requiredMm: atEnd ? 2 * totalMm : totalMm,
      availableMm: atEnd ? clearSpanMm : null,
      exact: true,
      ok: atEnd ? clearSpanMm >= 2 * totalMm : null,
      note:
        `柱面から ${Math.round(spanMm)}mm＋余長 ${Math.round(extensionMm)}mm ＝ ${Math.round(totalMm)}mm` +
        `（Lo=${Math.round(clearSpanMm)}mm）。` +
        (atEnd
          ? '両側の合計が内法スパンを超えると中央で重なるため通し筋とする'
          : '中央側からの伸ばし'),
    });
  }
  return { pieces, checks };
}

/**
 * 梁1本分のカットオフ筋を組み立てる
 * @param {Object} params - 算定パラメータ
 * @returns {{pieces:Array, checks:Array}|null} 結果
 */
function buildBeamCutoff({ beamEl, layout, scanTag, isSmallBeam }) {
  // 区間が2つ以下の断面（SAME・テーパー）はカットオフ位置が定まらない
  if (!layout.segments || layout.segments.length < 3) return null;

  const span = resolveBeamSpan(scanTag, beamEl);
  if (!span) return null;

  const depthStart = columnDepthAtNode(scanTag, beamEl.getAttribute('id_node_start'), span.dir);
  const depthEnd = columnDepthAtNode(scanTag, beamEl.getAttribute('id_node_end'), span.dir);
  const clearSpanMm = span.spanMm - (depthStart + depthEnd) / 2;
  if (!(clearSpanMm > 0)) return null;

  const pieces = [];
  const checks = [];
  for (const endSpec of BEAM_ENDS) {
    const built = buildEndCutoff({
      endSpec,
      layout: { ...layout, spanMm: span.spanMm },
      clearSpanMm,
      faceOffsetMm: (endSpec.side === 'start' ? depthStart : depthEnd) / 2,
      isSmallBeam,
    });
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }

  const filtered = pieces.filter(Boolean);
  if (filtered.length === 0 && checks.length === 0) return null;
  return { pieces: filtered, checks, clearSpanMm };
}

/**
 * STB文書から梁要素ID → カットオフ筋のマップを作る
 *
 * 大梁（StbGirder）と小梁（StbBeam）は断面IDの採番空間が独立しているため、
 * 主筋配置マップと同じくマップを分けて返す。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {{girder: Map<string, Object>, beam: Map<string, Object>}} beamLayoutMaps -
 *   buildBeamRebarLayoutMaps の結果
 * @param {function(string): Element[]} [sharedScanTag] - 呼び出し元と共有するタグ走査関数（省略時は新規作成）
 * @returns {{girder: Map<string, Object>, beam: Map<string, Object>, checks: Array<Object>}}
 *   要素ID → 鉄筋片と、全梁端の判定行
 */
export function buildBeamCutoffMaps(xmlDoc, beamLayoutMaps, sharedScanTag = null) {
  const result = { girder: new Map(), beam: new Map(), checks: [] };
  if (!xmlDoc || !beamLayoutMaps) return result;

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
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

      const built = buildBeamCutoff({
        beamEl,
        layout,
        scanTag,
        isSmallBeam: target.isSmallBeam,
      });
      if (!built) continue;

      if (built.pieces.length > 0) {
        target.map.set(elementId, { elementId, pieces: built.pieces });
      }
      const elementName = beamEl.getAttribute('name') || null;
      for (const check of built.checks) {
        result.checks.push({
          kind: target.kind,
          elementId,
          elementName,
          sectionName: layout.sectionName || null,
          ...check,
        });
      }
    }
  }
  return result;
}
