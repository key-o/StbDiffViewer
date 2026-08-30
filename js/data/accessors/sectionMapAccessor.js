/**
 * @fileoverview 異なる型の断面IDを許容するMapアクセサ
 */

/**
 * 断面IDを、元値、文字列、数値、整数の順に照合して断面データを取得する。
 *
 * @param {Map} sectionMap - 断面IDをキーに持つMap
 * @param {*} sectionId - 検索する断面ID
 * @returns {*|null} 見つかった断面データ。見つからない場合はnull
 */
export function getSectionDataFromMap(sectionMap, sectionId) {
  if (!(sectionMap instanceof Map) || !sectionId) return null;

  const candidates = new Set([sectionId, String(sectionId)]);
  const numericId = Number(sectionId);
  if (!Number.isNaN(numericId)) {
    candidates.add(numericId);
    candidates.add(String(numericId));
  }

  const parsedInteger = Number.parseInt(sectionId, 10);
  if (!Number.isNaN(parsedInteger)) {
    candidates.add(parsedInteger);
    candidates.add(String(parsedInteger));
  }

  for (const candidate of candidates) {
    if (sectionMap.has(candidate)) {
      return sectionMap.get(candidate);
    }
  }

  return null;
}
