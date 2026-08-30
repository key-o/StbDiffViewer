/**
 * @fileoverview 差分統計データの計算ロジック（UI非依存）
 *
 * 比較結果（正規化済み）から、要素タイプ別の差分件数集計に加え、
 * 位置・断面/タイプ・インスタンス属性の各次元での一致/相違内訳、
 * および非描画（STB定義等）要素のカテゴリ別内訳を算出します。
 * 公開APIは calculateDiffStatistics のみで、他はその内部処理専用のヘルパーです。
 */

import { getCategoryCounts, getDiffStatusCounts } from '../../../data/normalizeComparisonResult.js';
import { COMPARISON_CATEGORY } from '../../../constants/comparisonCategories.js';
import { classifyDefinitionGroup } from '../../../common-stb/comparison/stbDefinitionComparator.js';

/**
 * 比較結果から統計データを計算する
 * @param {Object} comparisonResults - 比較結果オブジェクト
 * @returns {Object} 統計データ
 */
export function calculateDiffStatistics(comparisonResults) {
  const stats = {
    totalElements: 0,
    totalRenderable: 0,
    totalNonRenderable: 0,
    totalModelA: 0,
    totalModelB: 0,
    totalCorresponding: 0,
    totalMatched: 0,
    totalExact: 0,
    totalWithinTolerance: 0,
    totalAttributeMismatch: 0,
    totalOnlyA: 0,
    totalOnlyB: 0,
    statusCounts: {},
    elementTypes: {},
    matchDimensions: createEmptyMatchDimensions(),
    sectionDefinitionDimensions: createEmptySectionDefinitionDimensions(),
  };

  // 要素タイプ別に統計を計算
  const entries =
    comparisonResults instanceof Map
      ? comparisonResults.entries()
      : Object.entries(comparisonResults);

  for (const [elementType, result] of entries) {
    if (!result || typeof result !== 'object') continue;

    const counts = getCategoryCounts(result);
    const matched = counts.exact + counts.withinTolerance;
    const attributeMismatch = counts.attributeMismatch;
    const corresponding = matched + attributeMismatch;
    const onlyA = counts.onlyA;
    const onlyB = counts.onlyB;
    const total = counts.total;
    const statusCounts = getDiffStatusCounts(result);

    if (total > 0) {
      const isRenderable = result.isRenderable !== false;
      const dimensions = isRenderable
        ? computeMatchDimensions(result)
        : createEmptyMatchDimensions();
      const sectionDefinitionDimensions = !isRenderable
        ? computeSectionDefinitionDimensions(result)
        : createEmptySectionDefinitionDimensions();
      stats.elementTypes[elementType] = {
        totalModelA: corresponding + onlyA,
        totalModelB: corresponding + onlyB,
        corresponding,
        matched,
        exact: counts.exact,
        withinTolerance: counts.withinTolerance,
        attributeMismatch,
        onlyA,
        onlyB,
        total,
        statusCounts,
        matchDimensions: dimensions,
        sectionDefinitionDimensions,
        // 3D描画されないタイプ（STB定義等）はクリック絞り込みの対象外にする
        isRenderable,
      };

      stats.totalElements += total;
      stats.totalModelA += corresponding + onlyA;
      stats.totalModelB += corresponding + onlyB;
      // 3D描画可否で総数を内訳（非描画=STB定義など）。色付けフィルタとの数の差の説明に使う。
      if (result.isRenderable === false) {
        stats.totalNonRenderable += total;
      } else {
        stats.totalRenderable += total;
      }
      stats.totalCorresponding += corresponding;
      stats.totalMatched += matched;
      stats.totalExact += counts.exact;
      stats.totalWithinTolerance += counts.withinTolerance;
      stats.totalAttributeMismatch += attributeMismatch;
      stats.totalOnlyA += onlyA;
      stats.totalOnlyB += onlyB;
      for (const [status, count] of Object.entries(statusCounts)) {
        stats.statusCounts[status] = (stats.statusCounts[status] || 0) + count;
      }
      accumulateMatchDimensions(stats.matchDimensions, dimensions);
      accumulateSectionDefinitionDimensions(
        stats.sectionDefinitionDimensions,
        sectionDefinitionDimensions,
      );
    }
  }

  return stats;
}

/** 断面・タイプ差とみなす attributeMismatchKind */
const SECTION_MISMATCH_KINDS = new Set(['type', 'both']);
/** インスタンス属性差とみなす attributeMismatchKind */
const INSTANCE_MISMATCH_KINDS = new Set(['instance', 'both']);

/**
 * 一致次元マトリクス用の空カウンタを生成する
 * @returns {Object}
 */
function createEmptyMatchDimensions() {
  return {
    pairsTotal: 0,
    positionExact: 0,
    positionTolerance: 0,
    fullMatch: 0,
    sectionMatch: 0,
    sectionMismatch: 0,
    sectionUnknown: 0,
    instanceMatch: 0,
    instanceMismatch: 0,
    instanceUnknown: 0,
  };
}

function createEmptySectionDefinitionDimensions() {
  return {
    sameNameMatch: 0,
    sameNameMismatch: 0,
    groups: createEmptyDefinitionGroups(),
  };
}

/**
 * 断面グループ内の定義要素を部材カテゴリ（柱・大梁・小梁・壁 …）に分類する。
 * 色付けモードの断面比較と同じく「同一とみなす断面設定」の粒度で集計する。
 *
 * 大梁/小梁は断面タグだけでは分けられない（StbSecBeam_* を共有する）ため、
 * 断面要素の kind_beam 属性で判定する。属性が無い場合はSTBの既定値GIRDERとして大梁に分類する。
 *
 * @param {string|undefined} tag - タグ名
 * @param {Element|null} [rawElement] - 元XML要素（kind_beam 参照用）
 * @returns {string} カテゴリラベル（判別不能時は 'その他'）
 */
function categorizeSectionDefinition(tag, rawElement = null) {
  if (!tag || typeof tag !== 'string') return 'その他';

  // StbSecXxx_YY / StbSecXxx から部材名 Xxx を取り出す
  const body = tag.replace(/^StbSec/, '').replace(/_(RC|S|SRC|CFT)$/, '');

  // 梁の大梁/小梁は kind_beam 属性で判定（無ければSTB既定値の大梁）
  if (tag.startsWith('StbSecGirder')) return '大梁';
  if (tag.startsWith('StbSecBeam')) {
    const kind = rawElement?.getAttribute?.('kind_beam');
    if (kind === 'GIRDER') return '大梁';
    if (kind === 'BEAM') return '小梁';
    return '大梁';
  }

  for (const [keyword, label] of SECTION_DEFINITION_CATEGORY_RULES) {
    if (body.includes(keyword)) return label;
  }
  return 'その他';
}

/**
 * 部材名キーワード → カテゴリラベルの割り当て。
 * より限定的なキーワード（FoundationColumn 等）を先に判定する。
 * 梁（Girder/Beam）は categorizeSectionDefinition 側で kind_beam を見て判定するため含めない。
 *
 * StbSecOpen_RC（開口寸法定義）は StbSec 接頭辞のため section グループに入る。
 * StbOpen/StbOpenArrangement（開口配置）の「開口」タブとは別物なので
 * 「開口寸法」ラベルで区別する。
 */
const SECTION_DEFINITION_CATEGORY_RULES = [
  ['FoundationColumn', '基礎柱'],
  ['StripFooting', '布基礎'],
  ['Footing', '基礎'],
  ['Foundation', '基礎'],
  ['Pile', '杭'],
  ['Post', '間柱'],
  ['Column', '柱'],
  ['Brace', 'ブレース'],
  ['Slab', 'スラブ'],
  ['Parapet', 'パラペット'],
  ['Wall', '壁'],
  ['Open', '開口寸法'],
  ['Undefined', '未定義'],
];

/**
 * 両モデルに存在するペア（exact + withinTolerance + attributeMismatch）を
 * 位置・断面/タイプ・インスタンス属性の各次元で一致/相違に分類する。
 *
 * exact/withinTolerance は属性一致なので断面・インスタンスとも「一致」。
 * attributeMismatch は attributeMismatchKind（instance/type/both）で分類し、
 * 分類情報が無いもの（多くの節点等）は「未分類」に計上する。
 *
 * @param {Object} result - 正規化された比較結果
 * @returns {Object} 次元別カウンタ
 */
function computeMatchDimensions(result) {
  const dims = createEmptyMatchDimensions();

  const exactCount = result[COMPARISON_CATEGORY.EXACT]?.length || 0;
  dims.pairsTotal += exactCount;
  dims.positionExact += exactCount;
  dims.fullMatch += exactCount;
  dims.sectionMatch += exactCount;
  dims.instanceMatch += exactCount;

  const withinToleranceCount = result[COMPARISON_CATEGORY.WITHIN_TOLERANCE]?.length || 0;
  dims.pairsTotal += withinToleranceCount;
  dims.positionTolerance += withinToleranceCount;
  dims.sectionMatch += withinToleranceCount;
  dims.instanceMatch += withinToleranceCount;

  for (const item of result[COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH] || []) {
    dims.pairsTotal++;
    if (item.positionState === 'withinTolerance') dims.positionTolerance++;
    else dims.positionExact++;

    const kind = item.attributeMismatchKind;
    if (kind == null) {
      dims.sectionUnknown++;
      dims.instanceUnknown++;
    } else {
      if (SECTION_MISMATCH_KINDS.has(kind)) dims.sectionMismatch++;
      else dims.sectionMatch++;
      if (INSTANCE_MISMATCH_KINDS.has(kind)) dims.instanceMismatch++;
      else dims.instanceMatch++;
    }
  }

  return dims;
}

/**
 * 次元カウンタを加算集計する
 * @param {Object} target - 集計先
 * @param {Object} source - 加算元
 */
function accumulateMatchDimensions(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] || 0;
  }
}

/** STB定義の大分類グループ（タブ順） */
const DEFINITION_GROUPS = ['section', 'joint', 'open', 'other'];

/**
 * 断面定義カテゴリ別カウンタの空オブジェクトを生成する。
 * ids は各区分に属する断面定義の id（= 配置要素の id_section）を集め、
 * 数値セルクリック時に「該当断面を参照する配置要素」を3D絞り込みするために使う。
 */
function createEmptySectionCategoryCounts() {
  return {
    corresponding: 0,
    sameNameMatch: 0,
    sameNameMismatch: 0,
    onlyA: 0,
    onlyB: 0,
    ids: { sameNameMatch: [], sameNameMismatch: [], onlyA: [], onlyB: [] },
  };
}

/** グループ×カテゴリ集計の空オブジェクトを生成する */
function createEmptyDefinitionGroups() {
  const groups = {};
  for (const group of DEFINITION_GROUPS) {
    groups[group] = { byCategory: {} };
  }
  return groups;
}

/**
 * 定義要素を grouped byCategory に振り分けて指定フィールドを加算する。
 * @param {Object} groups - グループ×カテゴリ集計
 * @param {Array} items - 比較アイテム配列
 * @param {string} field - 加算するフィールド（sameNameMatch 等）
 * @param {(item: Object) => {tag: string, rawElement: Element|null, ids: string[]}} pick
 *   - タグ・要素・断面定義id（配置要素の id_section 突合用）の取り出し
 */
function tallyIntoGroups(groups, items, field, pick) {
  for (const item of items || []) {
    const { tag, rawElement, ids } = pick(item);
    const group = classifyDefinitionGroup(tag);
    const category =
      group === 'section'
        ? categorizeSectionDefinition(tag, rawElement)
        : DEFINITION_GROUP_SINGLE_CATEGORY[group];
    const byCategory = groups[group].byCategory;
    const bucket = (byCategory[category] ||= createEmptySectionCategoryCounts());
    bucket[field]++;
    if (field === 'sameNameMatch' || field === 'sameNameMismatch') bucket.corresponding++;
    // 断面グループのみ、配置要素との突合に使う断面定義idを区分別に蓄積する
    if (group === 'section' && Array.isArray(ids)) {
      for (const id of ids) {
        if (id != null && id !== '') bucket.ids[field].push(String(id));
      }
    }
  }
}

/** 断面定義比較アイテムの片側データから断面定義id（rawElement@id）を取り出す */
function pickDefinitionId(src) {
  const el = src?.rawElement;
  if (el && typeof el.getAttribute === 'function') {
    return el.getAttribute('id');
  }
  return src?.id ?? null;
}

/** 断面以外のグループは単一カテゴリ行にまとめる（内訳を持たない） */
const DEFINITION_GROUP_SINGLE_CATEGORY = {
  joint: '継手',
  open: '開口',
  other: 'STB定義',
};

function computeSectionDefinitionDimensions(result) {
  // 対応ペアは dataA/dataB を持ち、片側のみは要素そのもの（rawElement を持つ）。
  // 対応ペアは両モデルの断面定義idを集める（配置要素の id_section は A/B で異なりうるため）。
  const pairPick = (item) => {
    const src = item.dataA ?? item.dataB ?? item;
    const ids = [pickDefinitionId(item.dataA), pickDefinitionId(item.dataB)].filter(
      (id) => id != null && id !== '',
    );
    return { tag: src.tag, rawElement: src.rawElement ?? null, ids };
  };
  const soloPick = (item) => {
    const id = pickDefinitionId(item);
    return { tag: item.tag, rawElement: item.rawElement ?? null, ids: id != null ? [id] : [] };
  };

  const groups = createEmptyDefinitionGroups();
  tallyIntoGroups(groups, result[COMPARISON_CATEGORY.EXACT], 'sameNameMatch', pairPick);
  tallyIntoGroups(
    groups,
    result[COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH],
    'sameNameMismatch',
    pairPick,
  );
  tallyIntoGroups(groups, result[COMPARISON_CATEGORY.ONLY_A], 'onlyA', soloPick);
  tallyIntoGroups(groups, result[COMPARISON_CATEGORY.ONLY_B], 'onlyB', soloPick);

  return {
    sameNameMatch: result[COMPARISON_CATEGORY.EXACT]?.length || 0,
    sameNameMismatch: result[COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH]?.length || 0,
    groups,
  };
}

function accumulateSectionDefinitionDimensions(target, source) {
  target.sameNameMatch += source.sameNameMatch || 0;
  target.sameNameMismatch += source.sameNameMismatch || 0;
  for (const group of DEFINITION_GROUPS) {
    const targetByCat = target.groups[group].byCategory;
    for (const [category, counts] of Object.entries(source.groups?.[group]?.byCategory || {})) {
      const bucket = (targetByCat[category] ||= createEmptySectionCategoryCounts());
      for (const key of Object.keys(bucket)) {
        if (key === 'ids') continue; // ids はオブジェクト。下で配列連結する
        bucket[key] += counts[key] || 0;
      }
      // 断面定義idの区分別配列を連結する
      for (const field of Object.keys(bucket.ids)) {
        const srcIds = counts.ids?.[field];
        if (Array.isArray(srcIds) && srcIds.length > 0) {
          bucket.ids[field].push(...srcIds);
        }
      }
    }
  }
}
