/**
 * @fileoverview トップレベル断面の対応表構築（B1）
 *
 * StbSections 直下のトップレベル断面（StbSecColumn_RC / StbSecBeam_S 等）を
 * 「断面ファミリ｜正規化名称｜正準化階（A4方式）」キーで 1:1 対応付けし、
 * 形状トークン（寸法・形状属性の集約）の一致/差を分類する。
 *
 * 異ソフト間比較モード（断面定義の対応＝名称＋階正準化）向けの断面対応表の実体で、
 * 対応付け（同一断面の同定）と実設計差の検出（形状トークン差）を両立する。
 *
 * 決定的・純関数（DOM 2つ → 対応表オブジェクト）。設定・UI・状態には依存しない。
 * 検証プロト scripts/verify/proto-section-correspondence.mjs からの本番移植。
 * 検証根拠: docs/reports/cross-software-match-benchmark.md
 * （Stage B2/A4: RC 14.1%→79.8%、S 35.7%→92.9%、鋼種66vs77の実差検出）
 */

import { createFloorCanonicalizer } from './storyFloorCanonicalizer.js';
import { normalizeSectionName } from './sectionNameNormalizer.js';

/** 構造種別サフィックス（ファミリ集約用）。StbSecColumn_RC → StbSecColumn */
const FAMILY_SUFFIX_PATTERN = /_(RC|S|SRC|CFT)$/;

/**
 * 形状トークンに集約する寸法・形状属性。
 * 子孫要素（StbSecFigure* / StbSecSteel* 等）を走査して集める。
 */
const SHAPE_ATTRS = new Set([
  'width_X',
  'width_Y',
  'width',
  'depth',
  'height',
  'thickness',
  'D',
  'A',
  'B',
  't',
  't1',
  't2',
  'radius',
  'diameter',
  'shape',
]);

function isElementNode(node) {
  return node?.nodeType === 1;
}

/**
 * 数値属性値を0.1精度へ丸める（ソフト間の末桁丸め差を吸収）。
 * @param {string} value - 属性値
 * @returns {string} 丸めた文字列（非数値はそのまま）
 */
function roundShapeValue(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? String(Math.round(num * 10) / 10) : value;
}

/**
 * 断面要素の形状トークン列を抽出する。
 * 子孫の SHAPE_ATTRS 属性を `属性名=丸め値` の形式で集約しソートして返す。
 * @param {Element} element - トップレベル断面要素
 * @returns {string[]} ソート済み形状トークン配列
 */
export function extractShapeTokens(element) {
  const tokens = [];
  const walk = (node) => {
    for (const attr of Array.from(node.attributes || [])) {
      if (SHAPE_ATTRS.has(attr.name) && attr.value !== '') {
        tokens.push(`${attr.name}=${roundShapeValue(attr.value)}`);
      }
    }
    for (const child of Array.from(node.childNodes || [])) {
      if (isElementNode(child)) walk(child);
    }
  };
  walk(element);
  return tokens.sort();
}

/**
 * StbSections 直下のトップレベル断面を収集する。
 * @param {Document} doc - STBドキュメント
 * @returns {Array<{tag: string, family: string, name: string, floor: string, shapeTokens: string[]}>}
 */
function collectTopLevelSections(doc) {
  const sectionsRoot = doc?.getElementsByTagName?.('StbSections')?.[0];
  if (!sectionsRoot) return [];
  return Array.from(sectionsRoot.childNodes)
    .filter(isElementNode)
    .map((el) => ({
      tag: el.tagName,
      family: el.tagName.replace(FAMILY_SUFFIX_PATTERN, ''),
      name: el.getAttribute('name') || '',
      floor: el.getAttribute('floor') || '',
      shapeTokens: extractShapeTokens(el),
    }));
}

/**
 * ソート済みトークン列同士の差分を計算する（多重集合差）。
 * @param {string[]} tokensA - ソート済みトークン列A
 * @param {string[]} tokensB - ソート済みトークン列B
 * @returns {{onlyA: string[], onlyB: string[]}} 片側にのみ存在するトークン
 */
function diffTokens(tokensA, tokensB) {
  const onlyA = [];
  const onlyB = [];
  let i = 0;
  let j = 0;
  while (i < tokensA.length || j < tokensB.length) {
    if (i >= tokensA.length) {
      onlyB.push(tokensB[j++]);
    } else if (j >= tokensB.length) {
      onlyA.push(tokensA[i++]);
    } else {
      const cmp = tokensA[i].localeCompare(tokensB[j]);
      if (cmp === 0) {
        i++;
        j++;
      } else if (cmp < 0) {
        onlyA.push(tokensA[i++]);
      } else {
        onlyB.push(tokensB[j++]);
      }
    }
  }
  return { onlyA, onlyB };
}

/**
 * ファミリ別集計の空エントリを生成する。
 * @param {string} family - 断面ファミリ名
 * @returns {Object}
 */
function createFamilyEntry(family) {
  return {
    family,
    countA: 0,
    countB: 0,
    matchedCount: 0,
    shapeEqualCount: 0,
    shapeDiffCount: 0,
    pairs: [],
    onlyA: [],
    onlyB: [],
  };
}

/**
 * トップレベル断面の対応表を構築する（B1）。
 *
 * 対応キーは「ファミリ｜正規化名称｜正準化階」。階の正準化は各モデル自身の
 * StbStory による A4 方式（標高順の序数）で行うため、同一モデル比較では
 * 常に全断面が対応し形状も一致する（自己比較100%維持）。
 * 名称なし断面（StbSecSteel コンテナ等）も family+階 でキー化し、
 * 同キー複数は出現順に1:1で消費する（検証プロトと同一挙動）。
 *
 * @param {Document} documentA - モデルAのSTBドキュメント
 * @param {Document} documentB - モデルBのSTBドキュメント
 * @returns {{
 *   families: Array<{
 *     family: string, countA: number, countB: number,
 *     matchedCount: number, shapeEqualCount: number, shapeDiffCount: number,
 *     pairs: Array<{name: string, floorA: string, floorB: string, tagA: string, tagB: string,
 *       shapeEqual: boolean, shapeTokensOnlyA: string[], shapeTokensOnlyB: string[]}>,
 *     onlyA: Array<{name: string, floor: string, tag: string}>,
 *     onlyB: Array<{name: string, floor: string, tag: string}>,
 *   }>,
 *   totals: {countA: number, countB: number, matchedCount: number,
 *     shapeEqualCount: number, shapeDiffCount: number, matchRate: number|null},
 * }} 対応表（families はファミリ名昇順・pairs/onlyA/onlyB は名称昇順）
 */
export function buildSectionCorrespondence(documentA, documentB) {
  const sectionsA = collectTopLevelSections(documentA);
  const sectionsB = collectTopLevelSections(documentB);
  const canonicalizeA = createFloorCanonicalizer(documentA);
  const canonicalizeB = createFloorCanonicalizer(documentB);

  const keyOf = (section, canonicalize) =>
    `${section.family}|${normalizeSectionName(section.name)}|${canonicalize(section.floor)}`;

  const familyMap = new Map();
  const familyOf = (family) => {
    if (!familyMap.has(family)) familyMap.set(family, createFamilyEntry(family));
    return familyMap.get(family);
  };

  // B側を対応キーでインデックス化（同キー複数は出現順のキューで1:1消費）。
  // 名称なし断面（StbSecSteel コンテナ・一部の開口等）も family+階 でキー化する
  // （検証プロトと同一挙動。自己比較100%の維持に必要）。
  const indexB = new Map();
  for (const section of sectionsB) {
    familyOf(section.family).countB++;
    const key = keyOf(section, canonicalizeB);
    if (!indexB.has(key)) indexB.set(key, []);
    indexB.get(key).push(section);
  }

  const toOnlyItem = (section) => ({
    name: section.name,
    floor: section.floor,
    tag: section.tag,
  });

  for (const section of sectionsA) {
    const entry = familyOf(section.family);
    entry.countA++;

    const candidates = indexB.get(keyOf(section, canonicalizeA));
    if (!candidates || candidates.length === 0) {
      entry.onlyA.push(toOnlyItem(section));
      continue;
    }

    const matchedB = candidates.shift();
    entry.matchedCount++;
    const shapeEqual = section.shapeTokens.join(',') === matchedB.shapeTokens.join(',');
    if (shapeEqual) {
      entry.shapeEqualCount++;
    } else {
      entry.shapeDiffCount++;
    }
    const tokenDiff = shapeEqual
      ? { onlyA: [], onlyB: [] }
      : diffTokens(section.shapeTokens, matchedB.shapeTokens);
    entry.pairs.push({
      name: section.name,
      floorA: section.floor,
      floorB: matchedB.floor,
      tagA: section.tag,
      tagB: matchedB.tag,
      shapeEqual,
      shapeTokensOnlyA: tokenDiff.onlyA,
      shapeTokensOnlyB: tokenDiff.onlyB,
    });
  }

  // 未消費のB側断面を onlyB に分類
  // （マッチ時に shift() で消費されるため、queue に残っているものが未対応）
  const unmatchedB = new Set();
  for (const queue of indexB.values()) {
    for (const section of queue) unmatchedB.add(section);
  }
  for (const section of sectionsB) {
    if (unmatchedB.has(section)) {
      familyOf(section.family).onlyB.push(toOnlyItem(section));
    }
  }

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ja');
  const families = [...familyMap.values()].sort((a, b) => a.family.localeCompare(b.family));
  const totals = {
    countA: 0,
    countB: 0,
    matchedCount: 0,
    shapeEqualCount: 0,
    shapeDiffCount: 0,
    matchRate: null,
  };
  for (const entry of families) {
    entry.pairs.sort(byName);
    entry.onlyA.sort(byName);
    entry.onlyB.sort(byName);
    totals.countA += entry.countA;
    totals.countB += entry.countB;
    totals.matchedCount += entry.matchedCount;
    totals.shapeEqualCount += entry.shapeEqualCount;
    totals.shapeDiffCount += entry.shapeDiffCount;
  }
  const denominator = Math.min(totals.countA, totals.countB);
  totals.matchRate = denominator > 0 ? totals.matchedCount / denominator : null;

  return { families, totals };
}
