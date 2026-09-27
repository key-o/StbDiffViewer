/**
 * @fileoverview STB XML DOM を名前空間の有無にかかわらず検索するヘルパー。
 */

/**
 * DOM実装ごとの差を吸収して、指定したlocal nameの要素を取得する。
 *
 * 標準STBファイルはdefault namespaceで記述されることが多いが、prefix付きの
 * namespaceもXMLとして有効である。getElementsByTagNameはprefix付き文書では
 * local nameに一致しないため、通常検索で見つからない場合だけnamespace検索へ
 * フォールバックする。
 *
 * @param {object|null|undefined} root 検索起点のDocumentまたはElement
 * @param {string} tagName namespaceを除いた要素名
 * @returns {Element[]}
 */
export function elementsByTagName(root, tagName) {
  if (!root || !tagName) return [];

  if (typeof root.getElementsByTagName === 'function') {
    const direct = Array.from(root.getElementsByTagName(tagName) || []);
    if (direct.length > 0) return direct;
  }

  if (typeof root.getElementsByTagNameNS === 'function') {
    return Array.from(root.getElementsByTagNameNS('*', tagName) || []);
  }

  return [];
}
