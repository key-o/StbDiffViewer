/**
 * @fileoverview RC柱主筋の定着とカットオフ筋長さの算定（3D配筋用）
 *
 * P0-E1 では日建連・JSCA 2023 の L2/L2h を共通ルールカーネルから解決し、
 * 柱カットオフの基準となる Ho は P0-C の実梁面から求めた最大内法高さを使う。
 * 表外Fc・鋼種は近似せず specialRequired とする。
 *
 * @module data/extractors/rebar3d/columnAnchoragePlacement
 */

import {
  COLUMN_ANCHORAGE_RULES,
  DEFAULT_BAR_GRADE,
  DEFAULT_CONCRETE_FC,
  parseConcreteFc,
} from '../../../constants/rebarAnchorageRules.js';
import { columnCutoffLengthMm } from '../../../constants/rebarCutoffRules.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import {
  collectBeamLevelsAtNode,
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnsAtNode,
  getNodeCoord,
} from '../columnSupportUtils.js';
import { resolveColumnClearHeightFromScanner } from './rebarClearGeometry.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { axialPiece, inwardDirection, tailPiece } from './rebarPieces.js';

/** 柱として走査するタグ */
const COLUMN_TAGS = ['StbColumn', 'StbPost'];

/**
 * 柱1本分の材軸レベルと梁レベルをまとめる。
 * Ho は上下節点間ではなく、P0-C の実梁面から求める。
 * @param {Document} xmlDoc - STB XML
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} columnEl - 柱要素
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {Object|null} レベル情報
 */
function resolveColumnLevels(xmlDoc, scanTag, columnEl, index = null) {
  const bottomNodeId = columnEl.getAttribute('id_node_bottom');
  const topNodeId = columnEl.getAttribute('id_node_top');
  const bottom = getNodeCoord(scanTag, bottomNodeId, index);
  const top = getNodeCoord(scanTag, topNodeId, index);
  if (!bottom || !top || !(top.z > bottom.z)) return null;

  const topBeams = collectBeamLevelsAtNode(scanTag, topNodeId, index);
  const bottomBeams = collectBeamLevelsAtNode(scanTag, bottomNodeId, index);
  const neighbours = {
    aboveTop: findColumnsAtNode(scanTag, topNodeId, index).above,
    belowBottom: findColumnsAtNode(scanTag, bottomNodeId, index).below,
  };
  const clearHeight = resolveColumnClearHeightFromScanner(scanTag, columnEl, index);

  return {
    topZ: top.z,
    bottomZ: bottom.z,
    topBeams,
    bottomBeams,
    clearHeightMm: clearHeight?.hoMm ?? null,
    clearUpperFaceZ: clearHeight?.upperFaceZ ?? null,
    clearLowerFaceZ: clearHeight?.lowerFaceZ ?? null,
    clearHeightSource: clearHeight ? 'exact-beam-face' : 'unresolved',
    isTopStory: !neighbours.aboveTop,
    isBottomStory: !neighbours.belowBottom,
  };
}

/**
 * 主筋を「呼び径・種別・四隅かどうか」でまとめる。
 * @param {Array<Object>} bars - 主筋
 * @returns {Array<{diaMm:number,grade:string,corner:boolean,count:number}>} 集計
 */
function groupBars(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const grade = REBAR_STANDARD_RULES.normalizeGrade(bar.grade) || DEFAULT_BAR_GRADE;
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
 * 日建連2023の L2 / L2h を解決する。
 * @param {Object} params - 定着条件
 * @returns {Object} 解決結果
 */
function resolveDevelopmentRequirement({ barDiaMm, fc, grade, hooked }) {
  const kind = hooked ? 'l2h' : 'l2';
  const resolved = REBAR_STANDARD_RULES.resolveLengthFactor({ kind, fc, grade });
  return {
    kind,
    factor: resolved.factor,
    requiredMm: resolved.ok ? resolved.factor * barDiaMm : null,
    specialRequired: !resolved.ok,
    exact: resolved.ok,
  };
}

/**
 * 判定行を1つ作る。
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
  exact = true,
  specialRequired = false,
  note,
  standardId = REBAR_STANDARD_RULES.standardId,
}) {
  const unresolved = specialRequired || !Number.isFinite(requiredMm);
  return {
    category,
    position,
    role,
    diaMm: group.diaMm,
    grade: group.grade,
    count: group.count,
    fc,
    requiredMm: unresolved ? null : requiredMm,
    availableMm,
    exact: exact && !unresolved,
    specialRequired: unresolved,
    standardId,
    note,
    ok: unresolved || availableMm === null ? null : availableMm >= requiredMm,
  };
}

function formatDevelopmentRequirement(requirement) {
  return requirement.specialRequired
    ? `${requirement.kind.toUpperCase()}=要特記`
    : `${requirement.kind.toUpperCase()}=${requirement.factor}d`;
}

/**
 * 最上階の柱頭定着（180°フック／直線定着）を組み立てる。
 * @param {Object} context - 算定コンテキスト
 * @returns {{pieces:Array,checks:Array}} 定着形状と判定
 */
function buildTopStoryAnchorage(context) {
  const { levels, bars, coverMm, fc } = context;
  const pieces = [];
  const checks = [];

  const barTopZ = levels.topZ - coverMm;
  const datumZ = levels.topBeams ? levels.topBeams.highestBottomZ : levels.topZ;
  const availableMm = levels.topBeams ? Math.max(0, barTopZ - datumZ) : null;

  for (const group of groupBars(bars)) {
    const required = resolveDevelopmentRequirement({
      barDiaMm: group.diaMm,
      fc,
      grade: group.grade,
      hooked: group.corner,
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
        specialRequired: required.specialRequired,
        note: `${formatDevelopmentRequirement(required)}。最も高い梁下端からの長さ`,
      }),
    );
  }

  const rules = COLUMN_ANCHORAGE_RULES;
  const hookTailFactor = REBAR_STANDARD_RULES.resolveHookTailFactor(180) ?? rules.hookTailDiaFactor;
  for (const bar of bars) {
    if (!bar.corner) continue;
    const tailLength = hookTailFactor * bar.dia;
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
 * 最下階の柱脚定着（基礎への90°折曲げ定着）を組み立てる。
 * @param {Object} context - 算定コンテキスト
 * @returns {{pieces:Array,checks:Array}} 定着形状と判定
 */
function buildBottomStoryAnchorage(context) {
  const { levels, bars, coverMm, fc } = context;
  const pieces = [];
  const checks = [];
  const rules = COLUMN_ANCHORAGE_RULES;

  const availableMm = levels.bottomBeams
    ? Math.max(0, levels.bottomBeams.maxDepthMm - coverMm)
    : null;

  const requiredByBar = new Map();
  for (const group of groupBars(bars)) {
    const required = resolveDevelopmentRequirement({
      barDiaMm: group.diaMm,
      fc,
      grade: group.grade,
      hooked: true,
    });
    requiredByBar.set(`${group.diaMm}|${group.grade}`, required);
    const tailFactor = REBAR_STANDARD_RULES.resolveHookTailFactor(90) ?? rules.baseTailDiaFactor;
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
        specialRequired: required.specialRequired,
        note:
          `${formatDevelopmentRequirement(required)}、余長 max(${tailFactor}d, ${rules.baseTailMinMm}mm)。` +
          (levels.bottomBeams ? '基礎梁せい−かぶりを確保長さとしています' : '基礎梁が無く判定不能'),
      }),
    );
  }

  const tailFactor = REBAR_STANDARD_RULES.resolveHookTailFactor(90) ?? rules.baseTailDiaFactor;
  for (const bar of bars) {
    const grade = REBAR_STANDARD_RULES.normalizeGrade(bar.grade) || DEFAULT_BAR_GRADE;
    const required = requiredByBar.get(`${bar.dia}|${grade}`);
    const depthMm = required?.requiredMm;
    if (!Number.isFinite(depthMm) || !(depthMm > 0)) continue;

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
        length: Math.max(tailFactor * bar.dia, rules.baseTailMinMm),
      }),
    );
  }
  return { pieces, checks };
}

/**
 * 柱頭／柱脚カットオフ筋を組み立てる（§7-1 4.）。
 * @param {Object} context - 算定コンテキスト
 * @param {{zone:string,bars:Array}} cutoff - 断面から切り出したカットオフ筋
 * @returns {{pieces:Array,checks:Array}} 形状と判定
 */
function buildCutoffBars(context, cutoff) {
  const { levels, fc } = context;
  const pieces = [];
  const checks = [];
  const isTopZone = cutoff.zone === 'top';
  const hasHo = Number.isFinite(levels.clearHeightMm) && levels.clearHeightMm >= 0;

  const datumZ = isTopZone
    ? (levels.topBeams?.lowestBottomZ ?? levels.topZ)
    : (levels.bottomBeams?.highestTopZ ?? levels.bottomZ);
  const anchor = isTopZone ? 'end' : 'start';
  const anchorZ = isTopZone ? levels.topZ : levels.bottomZ;
  const datumDistanceMm = Math.abs(anchorZ - datumZ);

  const resolveJointEmbedment = (barDiaMm, grade) => {
    const required = resolveDevelopmentRequirement({
      barDiaMm,
      fc,
      grade,
      hooked: false,
    });
    if (required.specialRequired) {
      return { ...required, beyondMm: null };
    }

    const beyondFaceMm = COLUMN_ANCHORAGE_RULES.beyondBeamFaceDiaFactor * barDiaMm;
    const l2DatumOffsetMm = isTopZone
      ? Math.max(0, levels.topZ - (levels.topBeams?.highestBottomZ ?? levels.topZ))
      : 0;
    const faceOffsetMm = isTopZone
      ? 0
      : Math.max(0, levels.bottomZ - (levels.bottomBeams?.lowestBottomZ ?? levels.bottomZ));
    return {
      ...required,
      beyondMm: Math.max(required.requiredMm - l2DatumOffsetMm, faceOffsetMm + beyondFaceMm),
    };
  };

  if (hasHo) {
    for (const bar of cutoff.bars) {
      const grade = REBAR_STANDARD_RULES.normalizeGrade(bar.grade) || DEFAULT_BAR_GRADE;
      const embedment = resolveJointEmbedment(bar.dia, grade);
      if (!Number.isFinite(embedment.beyondMm)) continue;
      pieces.push(
        axialPiece({
          anchor,
          from: -embedment.beyondMm,
          to: datumDistanceMm + columnCutoffLengthMm(levels.clearHeightMm, bar.dia),
          u: bar.u,
          v: bar.v,
          dia: bar.dia,
        }),
      );
    }
  }

  const positionLabel = isTopZone ? '柱頭カットオフ筋' : '柱脚カットオフ筋';
  for (const group of groupBars(cutoff.bars)) {
    const embedment = resolveJointEmbedment(group.diaMm, group.grade);
    const cutoffLengthMm = hasHo ? columnCutoffLengthMm(levels.clearHeightMm, group.diaMm) : null;
    const specialRequired = !hasHo || embedment.specialRequired;
    const embedmentText = embedment.specialRequired
      ? '仕口定着L2=要特記'
      : `仕口への定着は${isTopZone ? '最も高い梁下端' : '最も低い梁天端'}から ` +
        `L2=${embedment.factor}d＝${Math.round(embedment.requiredMm)}mm、` +
        `節点を越える長さ ${Math.round(embedment.beyondMm)}mm`;
    const hoText = hasHo
      ? `Ho/2+15d = ${Math.round(cutoffLengthMm)}mm（Ho=${Math.round(levels.clearHeightMm)}mm、実梁面）`
      : 'Ho=未解決';

    checks.push(
      createCheckRow({
        category: '柱カットオフ',
        position: positionLabel,
        role: 'カットオフ筋長さ',
        group,
        fc,
        requiredMm: cutoffLengthMm,
        availableMm: hasHo ? levels.clearHeightMm : null,
        exact: !specialRequired,
        specialRequired,
        note: `${hoText}。${embedmentText}。内法高さを超えると通し筋とすべき`,
      }),
    );
  }
  return { pieces, checks };
}

/**
 * 柱1本分の定着・カットオフを組み立てる。
 * TOP/BOTTOM NotSame は通し筋だけでなく各端部の実配筋 facts を定着判定へ渡す。
 * @param {Object} params - 算定パラメータ
 * @returns {{pieces:Array,checks:Array}|null} 結果
 */
function buildColumnAnchorage({ xmlDoc, columnEl, layout, scanTag, options, index = null }) {
  const levels = resolveColumnLevels(xmlDoc, scanTag, columnEl, index);
  if (!levels) return null;

  const dims = extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'), index);
  const fc = parseConcreteFc(dims?.strengthConcrete) ?? DEFAULT_CONCRETE_FC;
  const standardCoverMm = REBAR_STANDARD_RULES.resolveColumnBeamCover().designMm;
  const coverMm = options.columnCoverMm ?? layout.coverMm ?? standardCoverMm;
  const throughBars = layout.segments?.[0]?.bars || [];
  const topBars = layout.endpointFacts?.top?.bars?.length
    ? layout.endpointFacts.top.bars
    : throughBars;
  const bottomBars = layout.endpointFacts?.bottom?.bars?.length
    ? layout.endpointFacts.bottom.bars
    : throughBars;
  const cutoffs = Array.isArray(layout.cutoffs)
    ? layout.cutoffs.filter((cutoff) => cutoff?.bars?.length)
    : layout.cutoff?.bars?.length
      ? [layout.cutoff]
      : [];
  if (
    throughBars.length === 0 &&
    topBars.length === 0 &&
    bottomBars.length === 0 &&
    cutoffs.length === 0
  ) {
    return null;
  }

  const baseContext = { levels, coverMm, fc };
  const pieces = [];
  const checks = [];

  if (levels.isTopStory && topBars.length > 0) {
    const built = buildTopStoryAnchorage({ ...baseContext, bars: topBars });
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }
  if (levels.isBottomStory && bottomBars.length > 0) {
    const built = buildBottomStoryAnchorage({ ...baseContext, bars: bottomBars });
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }
  for (const cutoff of cutoffs) {
    const built = buildCutoffBars(baseContext, cutoff);
    pieces.push(...built.pieces);
    checks.push(...built.checks);
  }

  const filtered = pieces.filter(Boolean);
  if (filtered.length === 0 && checks.length === 0) return null;
  return { pieces: filtered, checks, levels };
}

/**
 * STB文書から柱要素ID → 定着・カットオフ筋のマップを作る。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {Map<string,Object>} columnLayoutMap - buildColumnRebarLayoutMap の結果
 * @param {Object} [options] - 算定設定
 * @param {number} [options.columnCoverMm] - 柱かぶり厚さの上書き [mm]
 * @param {function(string): Element[]} [sharedScanTag] - 共有タグ走査関数
 * @returns {{columns:Map<string,Object>,checks:Array<Object>}} 要素ID → 鉄筋片と判定行
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
  const modelIndex = buildRebarModelIndex(xmlDoc, { scanTag });
  for (const tagName of COLUMN_TAGS) {
    for (const columnEl of scanTag(tagName)) {
      const layout = columnLayoutMap.get(String(columnEl.getAttribute('id_section')));
      if (!layout) continue;

      const elementId = columnEl.getAttribute('id');
      if (!elementId) continue;

      const built = buildColumnAnchorage({
        xmlDoc,
        columnEl,
        layout,
        scanTag,
        options,
        index: modelIndex,
      });
      if (!built) continue;

      if (built.pieces.length > 0) {
        result.columns.set(elementId, {
          elementId,
          pieces: built.pieces,
          clearHeightMm: built.levels.clearHeightMm,
          clearHeightSource: built.levels.clearHeightSource,
        });
      }
      const elementName = columnEl.getAttribute('name') || null;
      for (const check of built.checks) {
        result.checks.push({
          kind: '柱',
          elementId,
          elementName,
          sectionName: layout.sectionName || null,
          clearHeightMm: built.levels.clearHeightMm,
          clearHeightSource: built.levels.clearHeightSource,
          ...check,
        });
      }
    }
  }
  return result;
}
