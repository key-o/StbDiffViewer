/**
 * @fileoverview STB断面要素のDOM走査ヘルパー
 *
 * ブラウザDOM / JSDOM / @xmldom/xmldom の実装差異を吸収し、
 * 断面抽出処理から共通利用される走査プリミティブを提供します。
 *
 * @module common-stb/import/extractor/utils/domTraversal
 */

/** STB 名前空間（querySelector がヒットしない場合のフォールバック用） */
export const STB_NS = 'https://www.building-smart.or.jp/dl';

/**
 * 要素ノードの子要素一覧を取得（Node環境互換）
 *
 * `element.children` ではなく `childNodes` + `nodeType === 1` フィルタを使用する
 * （@xmldom/xmldom など `children` 未実装のDOM実装でも動作する。MC方式）。
 * ブラウザ/JSDOM では `children` と同一の結果になる。
 *
 * @param {Element|null} node - 対象要素
 * @returns {Element[]} 子要素の配列
 */
export function getElementChildren(node) {
  if (!node) return [];
  const childNodes = node.childNodes || node.children || [];
  const result = [];
  for (let i = 0; i < childNodes.length; i++) {
    if (childNodes[i].nodeType === 1) result.push(childNodes[i]);
  }
  return result;
}

/**
 * 図形要素（StbSecFigure*）をタグ名で検索する
 *
 * DOM実装差異を吸収するため
 * querySelector → getElementsByTagNameNS → 直接子要素の走査 の順にフォールバックする。
 *
 * @param {Element} element - 検索起点の要素
 * @param {string|string[]} selectors - 図形要素のタグ名（配列指定時は最初にヒットしたものを返す）
 * @returns {Element|null} 見つかった図形要素、なければ null
 */
export function findFigureElement(element, selectors) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];

  for (const sel of selectorList) {
    let figureElement = null;
    try {
      figureElement = element.querySelector(sel);
    } catch (_) {
      figureElement = null;
    }
    if (!figureElement && typeof element.getElementsByTagNameNS === 'function') {
      const nsList = element.getElementsByTagNameNS(STB_NS, sel);
      figureElement = nsList && nsList[0];
    }
    if (!figureElement) {
      // タグ名で直接検索を試みる（querySelector が失敗する場合のフォールバック）
      const children = getElementChildren(element);
      for (let i = 0; i < children.length; i++) {
        if (children[i].tagName === sel || children[i].localName === sel) {
          figureElement = children[i];
          break;
        }
      }
    }
    if (figureElement) return figureElement;
  }
  return null;
}

/**
 * 子要素をタグ名の条件で収集する
 *
 * @param {Element} parent - 親要素
 * @param {(tagName: string) => boolean} matches - タグ名の判定関数
 * @returns {Element[]} 条件に一致した子要素の配列
 */
export function collectChildrenByTag(parent, matches) {
  const result = [];
  const children = getElementChildren(parent);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childTag = child.tagName || child.localName;
    if (matches(childTag)) result.push(child);
  }
  return result;
}

/**
 * 要素配列を id_order 属性の昇順で並べ替える（破壊的）
 *
 * @param {Element[]} elements - 並べ替え対象
 * @returns {Element[]} 引数と同じ配列（ソート済み）
 */
export function sortByIdOrder(elements) {
  return elements.sort((a, b) => {
    const orderA = parseInt(a.getAttribute('id_order') || '0', 10);
    const orderB = parseInt(b.getAttribute('id_order') || '0', 10);
    return orderA - orderB;
  });
}
