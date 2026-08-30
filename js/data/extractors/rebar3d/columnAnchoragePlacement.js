/**
 * @fileoverview RC柱主筋の定着とカットオフ筋長さの算定（3D配筋用）
 *
 * 出典: 日本建設業連合会「鉄筋コンクリート造配筋標準図」(2013.03.27 改訂)
 * §7-1（柱の定着・カットオフ筋長さ）／§7-3（最上階・最下階の柱の定着）。
 *
 * - 最上階の柱頭: 四隅の主筋は180°フック（L2h）、四隅以外は直線定着（L2）
 * - 最下階の柱脚: 基礎へ90°折曲げ定着（L2h＋余長8dかつ150以上）
 * - 中間階の柱: 主筋は通し筋のため定着は作らない
 * - 柱頭／柱脚カットオフ筋: 基準となる梁面から Ho/2＋15d、
 *   反対側は節点（梁天端・梁下端）を15d越えるところまで伸ばす
 *
 * ST-Bridgeには定着形状・基礎の情報が含まれないため、標準図の一般値に
 * 固定した想定配置であり、判定も設計指針に基づく目安である。
 *
 * @module data/extractors/rebar3d/columnAnchoragePlacement
 */

import {
  COLUMN_ANCHORAGE_RULES,
  DEFAULT_BAR_GRADE,
  DEFAULT_CONCRETE_FC,
  REBAR_ANCHORAGE_RULES,
  computeDevelopmentLength,
  normalizeBarGrade,
  parseConcreteFc,
} from '../../../constants/rebarAnchorageRules.js';
import { columnCutoffLengthMm } from '../../../constants/rebarCutoffRules.js';
import {
  collectBeamLevelsAtNode,
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnsAtNode,
  getNodeCoord,
} from '../columnSupportUtils.js';
import { axialPiece, inwardDirection, tailPiece } from './rebarPieces.js';

/** 柱として走査するタグ */
const COLUMN_TAGS = ['StbColumn', 'StbPost'];

/**
 * 柱1本分の材軸レベルと梁レベルをまとめる
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} columnEl - 柱要素
 * @returns {Object|null} レベル情報
 */
function resolveColumnLevels(scanTag, columnEl) {
  const bottomNodeId = columnEl.getAttribute('id_node_bottom');
  const topNodeId = columnEl.getAttribute('id_node_top');
  const bottom = getNodeCoord(scanTag, bottomNodeId);
  const top = getNodeCoord(scanTag, topNodeId);
  if (!bottom || !top || !(top.z > bottom.z)) return null;

  const topBeams = collectBeamLevelsAtNode(scanTag, topNodeId);
  const bottomBeams = collectBeamLevelsAtNode(scanTag, bottomNodeId);
  const neighbours = {
    aboveTop: findColumnsAtNode(scanTag, topNodeId).above,
    belowBottom: findColumnsAtNode(scanTag, bottomNodeId).below,
  };

  // 最大内法高さ Ho: 上端は最も浅い梁の下端（＝最も高い梁下端）、下端は梁天端
  const clearTopZ = topBeams ? topBeams.highestBottomZ : top.z;
  const clearBottomZ = bottomBeams ? bottomBeams.highestTopZ : bottom.z;

  return {
    topZ: top.z,
    bottomZ: bottom.z,
    topBeams,
    bottomBeams,
    clearHeightMm: Math.max(0, clearTopZ - clearBottomZ),
    isTopStory: !neighbours.aboveTop,
    isBottomStory: !neighbours.belowBottom,
  };
}

/**
 * 主筋を「呼び径・種別・四隅かどうか」でまとめる
 * @param {Array<Object>} bars - 主筋
 * @returns {Array<{diaMm:number, grade:string, corner:boolean, count:number}>} 集計
 */
function groupBars(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const grade = normalizeBarGrade(bar.grade) || DEFAULT_BAR_GRADE;
    const key = `${bar.dia}|${grade}|${bar.corner ? 1 : 0}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
    } else {
      groups.set(key, { diaMm: bar.dia, grade, corner: Boolean(bar.corner), count: 1 });
    }
  }
  return [...groups.values()];
}

/**
 * 判定行を1つ作る
 * @param {Object} params - 行の内容
 * @returns {Object} 判定行
 */
function createCheckRow({
  category,
  position,
  role,
  group,
  fc,
  requiredMm,
  availableMm,
  exact,
  note,
}) {
  return {
    category,
    position,
    role,
    diaMm: group.diaMm,
    grade: group.grade,
    count: group.count,
    fc,
    requiredMm,
    availableMm,
    exact,
    note,
    ok: availableMm === null ? null : availableMm >= requiredMm,
  };
}

/**
 * 最上階の柱頭定着（180°フック／直線定着）を組み立てる
 * @param {Object} context - 算定コンテキスト
 * @returns {{pieces:Array, checks:Array}} 定着形状と判定
 */
function buildTopStoryAnchorage(context) {
  const { levels, bars, coverMm, fc } = context;
  const pieces = [];
  const checks = [];

  // 柱頭主筋の先端は柱天端からかぶりぶん下がった位置とみなす
  const barTopZ = levels.topZ - coverMm;
  const datumZ = levels.topBeams ? levels.topBeams.highestBottomZ : levels.topZ;
  const availableMm = levels.topBeams ? Math.max(0, barTopZ - datumZ) : null;

  for (const group of groupBars(bars)) {
    const required = computeDevelopmentLength({
      barDiaMm: group.diaMm,
      hooked: group.corner,
      fc,
      grade: group.grade,
    });
    checks.push(
      createCheckRow({
        category: '柱定着',
        position: '最上階 柱頭',
        role: group.corner ? '四隅（180°フック）' : '四隅以外（直線定着）',
        group,
        fc,
        requiredMm: required.requiredMm,
        availableMm,
        exact: required.exact,
        note: `${group.corner ? 'L2h' : 'L2'}=${required.factor}d。最も高い梁下端からの長さ`,
      }),
    );
  }

  // 180°フックは四隅のみ。折り返しは柱の内側へ寄せて材軸方向に描く
  const rules = COLUMN_ANCHORAGE_RULES;
  for (const bar of bars) {
    if (!bar.corner) continue;
    const tailLength = Math.max(rules.hookTailDiaFactor * bar.dia, rules.hookTailMinMm);
    const { dir, sign } = inwardDirection(bar.u, bar.v);
    const offset = rules.hookReturnOffsetDiaFactor * bar.dia * sign;
    pieces.push(
      tailPiece({
        anchor: 'end',
        at: coverMm,
        u: bar.u,
        v: bar.v,
        dia: bar.dia,
        dir: 'axial',
        sign: 1,
        length: tailLength,
        offsetU: dir === 'u' ? offset : 0,
        offsetV: dir === 'v' ? offset : 0,
      }),
    );
  }
  return { pieces, checks };
}

/**
 * 最下階の柱脚定着（基礎への90°折曲げ定着）を組み立てる
 * @param {Object} context - 算定コンテキスト
 * @returns {{pieces:Array, checks:Array}} 定着形状と判定
 */
function buildBottomStoryAnchorage(context) {
  const { levels, bars, coverMm, fc } = context;
  const pieces = [];
  const checks = [];
  const rules = COLUMN_ANCHORAGE_RULES;

  // 基礎梁が取り付く場合はそのせいからかぶりを引いた分を定着可能長さとする
  const availableMm = levels.bottomBeams
    ? Math.max(0, levels.bottomBeams.maxDepthMm - coverMm)
    : null;

  const requiredByDia = new Map();
  for (const group of groupBars(bars)) {
    const required = computeDevelopmentLength({
      barDiaMm: group.diaMm,
      hooked: true,
      fc,
      grade: group.grade,
    });
    requiredByDia.set(`${group.diaMm}|${group.grade}`, required.requiredMm);
    checks.push(
      createCheckRow({
        category: '柱定着',
        position: '最下階 柱脚',
        role: '90°折曲げ定着',
        group,
        fc,
        requiredMm: required.requiredMm,
        availableMm,
        exact: required.exact,
        note:
          `L2h=${required.factor}d、余長 max(8d, 150mm)。` +
          (levels.bottomBeams ? '基礎梁せい−かぶりを確保長さとしています' : '基礎梁が無く判定不能'),
      }),
    );
  }

  for (const bar of bars) {
    const grade = normalizeBarGrade(bar.grade) || DEFAULT_BAR_GRADE;
    const depthMm = requiredByDia.get(`${bar.dia}|${grade}`) || 0;
    if (!(depthMm > 0)) continue;

    // 柱脚（節点）から下へ L2h 伸ばし、その先を柱の内側へ折り曲げる
    pieces.push(
      axialPiece({ anchor: 'start', from: -depthMm, to: 0, u: bar.u, v: bar.v, dia: bar.dia }),
    );
    const { dir, sign } = inwardDirection(bar.u, bar.v);
    pieces.push(
      tailPiece({
        anchor: 'start',
        at: -depthMm,
        u: bar.u,
        v: bar.v,
        dia: bar.dia,
        dir,
        sign,
        length: Math.max(rules.baseTailDiaFactor * bar.dia, rules.baseTailMinMm),
      }),
    );
  }
  return { pieces, checks };
}

/**
 * 柱頭／柱脚カットオフ筋を組み立てる（§7-1 4.）
 * @param {Object} context - 算定コンテキスト
 * @param {{zone:string, bars:Array}} cutoff - 断面から切り出したカットオフ筋
 * @returns {{pieces:Array, checks:Array}} 形状と判定
 */
function buildCutoffBars(context, cutoff) {
  const { levels, fc } = context;
  const pieces = [];
  const checks = [];
  const isTopZone = cutoff.zone === 'top';

  // カットオフ筋長さの基準面: 柱頭は「最も低い梁下端」、柱脚は「最も高い梁天端」
  const datumZ = isTopZone
    ? (levels.topBeams?.lowestBottomZ ?? levels.topZ)
    : (levels.bottomBeams?.highestTopZ ?? levels.bottomZ);
  const anchor = isTopZone ? 'end' : 'start';
  const anchorZ = isTopZone ? levels.topZ : levels.bottomZ;
  const datumDistanceMm = Math.abs(anchorZ - datumZ);

  /**
   * 節点を越えて仕口へ伸ばす定着長さを求める（§7-1 3.）
   *
   * 柱頭主筋は「最も高い梁下端から L2 以上」かつ「最も高い梁天端から 15d 以上」、
   * 柱脚主筋は「最も低い梁天端から L2 以上」かつ「最も低い梁下端から 15d 以上」。
   * @param {number} barDiaMm - 呼び径 [mm]
   * @param {string} grade - 鉄筋種別
   * @returns {{beyondMm:number, l2Mm:number, factor:number, exact:boolean}} 定着長さ
   */
  const resolveJointEmbedment = (barDiaMm, grade) => {
    const required = computeDevelopmentLength({ barDiaMm, hooked: false, fc, grade });
    const beyondFaceMm = COLUMN_ANCHORAGE_RULES.beyondBeamFaceDiaFactor * barDiaMm;
    // 節点（梁天端）から L2 の基準面までの距離。柱頭は梁下端が節点より下にある
    const l2DatumOffsetMm = isTopZone
      ? Math.max(0, levels.topZ - (levels.topBeams?.highestBottomZ ?? levels.topZ))
      : 0;
    // 15d の基準面（柱頭は梁天端＝節点、柱脚は最も低い梁下端）までの距離
    const faceOffsetMm = isTopZone
      ? 0
      : Math.max(0, levels.bottomZ - (levels.bottomBeams?.lowestBottomZ ?? levels.bottomZ));
    return {
      beyondMm: Math.max(required.requiredMm - l2DatumOffsetMm, faceOffsetMm + beyondFaceMm),
      l2Mm: required.requiredMm,
      factor: required.factor,
      exact: required.exact,
    };
  };

  for (const bar of cutoff.bars) {
    const grade = normalizeBarGrade(bar.grade) || DEFAULT_BAR_GRADE;
    const { beyondMm } = resolveJointEmbedment(bar.dia, grade);
    pieces.push(
      axialPiece({
        anchor,
        from: -beyondMm,
        to: datumDistanceMm + columnCutoffLengthMm(levels.clearHeightMm, bar.dia),
        u: bar.u,
        v: bar.v,
        dia: bar.dia,
      }),
    );
  }

  const positionLabel = isTopZone ? '柱頭カットオフ筋' : '柱脚カットオフ筋';
  for (const group of groupBars(cutoff.bars)) {
    const cutoffLengthMm = columnCutoffLengthMm(levels.clearHeightMm, group.diaMm);
    const embedment = resolveJointEmbedment(group.diaMm, group.grade);
    // カットオフ筋長さが内法高さを超えるなら、区間を分けず通し筋とすべき
    checks.push(
      createCheckRow({
        category: '柱カットオフ',
        position: positionLabel,
        role: 'カットオフ筋長さ',
        group,
        fc,
        requiredMm: cutoffLengthMm,
        availableMm: levels.clearHeightMm,
        exact: embedment.exact,
        note:
          `Ho/2+15d = ${Math.round(cutoffLengthMm)}mm（Ho=${Math.round(levels.clearHeightMm)}mm）。` +
          `仕口への定着は${isTopZone ? '最も高い梁下端' : '最も低い梁天端'}から L2=${embedment.factor}d` +
          `＝${Math.round(embedment.l2Mm)}mm、節点を越える長さ ${Math.round(embedment.beyondMm)}mm。` +
          '内法高さを超えると通し筋とすべき',
      }),
    );
  }
  return { pieces, checks };
}

/**
 * 柱1本分の定着・カットオフを組み立てる
 * @param {Object} params - 算定パラメータ
 * @returns {{pieces:Array, checks:Array}|null} 結果
 */
function buildColumnAnchorage({ columnEl, layout, scanTag, options }) {
  const levels = resolveColumnLevels(scanTag, columnEl);
  if (!levels) return null;

  const dims = extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'));
  const fc = parseConcreteFc(dims?.strengthConcrete) ?? DEFAULT_CONCRETE_FC;
  const coverMm =
    options.columnCoverMm ?? layout.coverMm ?? REBAR_ANCHORAGE_RULES.defaultColumnCoverMm;
  const bars = layout.segments?.[0]?.bars || [];
  if (bars.length === 0) return null;

  const context = { levels, bars, coverMm, fc };
  const pieces = [];
  const checks = [];

  if (levels.isTopStory) {
    const built = buildTopStoryAnchorage(context);
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }
  if (levels.isBottomStory) {
    const built = buildBottomStoryAnchorage(context);
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }
  if (layout.cutoff?.bars?.length) {
    const built = buildCutoffBars(context, layout.cutoff);
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }

  const filtered = pieces.filter(Boolean);
  if (filtered.length === 0 && checks.length === 0) return null;
  return { pieces: filtered, checks };
}

/**
 * STB文書から柱要素ID → 定着・カットオフ筋のマップを作る
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {Map<string, Object>} columnLayoutMap - buildColumnRebarLayoutMap の結果
 * @param {Object} [options] - 算定設定
 * @param {number} [options.columnCoverMm] - 柱かぶり厚さの上書き [mm]
 * @param {function(string): Element[]} [sharedScanTag] - 呼び出し元と共有するタグ走査関数（省略時は新規作成）
 * @returns {{columns: Map<string, Object>, checks: Array<Object>}} 要素ID → 鉄筋片と判定行
 */
export function buildColumnAnchorageMaps(
  xmlDoc,
  columnLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  const result = { columns: new Map(), checks: [] };
  if (!xmlDoc || !columnLayoutMap?.size) return result;

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  for (const tagName of COLUMN_TAGS) {
    for (const columnEl of scanTag(tagName)) {
      const layout = columnLayoutMap.get(String(columnEl.getAttribute('id_section')));
      if (!layout) continue;

      const elementId = columnEl.getAttribute('id');
      if (!elementId) continue;

      const built = buildColumnAnchorage({ columnEl, layout, scanTag, options });
      if (!built) continue;

      if (built.pieces.length > 0) {
        result.columns.set(elementId, { elementId, pieces: built.pieces });
      }
      const elementName = columnEl.getAttribute('name') || null;
      for (const check of built.checks) {
        result.checks.push({
          kind: '柱',
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
