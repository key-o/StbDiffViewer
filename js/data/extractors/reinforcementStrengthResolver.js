/**
 * @fileoverview ST-Bridge の径別鉄筋強度を解決する。
 *
 * 個別の鉄筋に強度が明示されている場合はその値を優先し、未指定の場合だけ
 * StbCommon/StbReinforcementStrengthList の同径定義を参照する。
 * 元の XML DOM は変更しない。
 */

const strengthCache = new WeakMap();

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeDiameter(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function getOwnerDocument(elementOrDocument) {
  if (!elementOrDocument) return null;
  if (elementOrDocument.nodeType === 9) return elementOrDocument;
  return elementOrDocument.ownerDocument || null;
}

function elementsByLocalName(root, localName) {
  if (!root || !localName) return [];

  const expectedName = String(localName).toLowerCase();

  if (typeof root.getElementsByTagNameNS === 'function') {
    const namespaced = Array.from(root.getElementsByTagNameNS('*', localName) || []);
    if (namespaced.length > 0) return namespaced;
  }

  if (typeof root.getElementsByTagName !== 'function') return [];
  const direct = Array.from(root.getElementsByTagName(localName) || []);
  if (direct.length > 0) return direct;

  return Array.from(root.getElementsByTagName('*') || []).filter((element) => {
    const local = String(element?.localName || '').toLowerCase();
    const tagName = String(element?.tagName || '').toLowerCase();
    const unprefixed = tagName.includes(':') ? tagName.split(':').pop() : tagName;
    return local === expectedName || unprefixed === expectedName;
  });
}

function commonStrengthEntries(xmlDoc) {
  const common = elementsByLocalName(xmlDoc, 'StbCommon')[0];
  if (!common) return [];
  return elementsByLocalName(common, 'StbReinforcementStrength');
}

function commonStrengthSignature(entries) {
  return entries
    .map(
      (entry) =>
        `${normalizeDiameter(entry.getAttribute?.('D')) || ''}:${normalizeText(entry.getAttribute?.('strength')) || ''}`,
    )
    .join('|');
}

/**
 * StbCommon の径別鉄筋強度を Map<D, strength> で返す。
 * 同一径が複数回定義されている場合は先頭を採用し、曖昧な上書きを行わない。
 * 名前空間が default / prefix のどちらで記述されていても localName で解決する。
 * @param {Document|Element|null} elementOrDocument
 * @returns {Map<string,string>}
 */
export function getCommonReinforcementStrengthMap(elementOrDocument) {
  const xmlDoc = getOwnerDocument(elementOrDocument);
  if (!xmlDoc) return new Map();

  const entries = commonStrengthEntries(xmlDoc);
  const signature = commonStrengthSignature(entries);
  const cached = strengthCache.get(xmlDoc);
  if (cached?.signature === signature) return cached.map;

  const map = new Map();
  entries.forEach((entry) => {
    const diameter = normalizeDiameter(entry.getAttribute?.('D'));
    const strength = normalizeText(entry.getAttribute?.('strength'));
    if (diameter && strength && !map.has(diameter)) map.set(diameter, strength);
  });
  strengthCache.set(xmlDoc, { signature, map });
  return map;
}

/**
 * 個別強度 > 共通径別強度 の順で鉄筋強度を解決する。
 * 対応する径が共通情報に無い場合は推定せず null を返す。
 * @param {Object} params
 * @param {Element|Document|null} params.element - 対象鉄筋要素（またはDocument）
 * @param {string|null} params.diameter - 鉄筋径（例 D22）
 * @param {string|null} [params.explicitStrength] - 個別に記載された強度
 * @returns {{value:string|null, source:'individual'|'common'|null, diameter:string|null}}
 */
export function resolveReinforcementStrength({ element, diameter, explicitStrength = null } = {}) {
  const normalizedDiameter = normalizeDiameter(diameter);
  const individual = normalizeText(explicitStrength);
  if (individual) {
    return { value: individual, source: 'individual', diameter: normalizedDiameter };
  }

  if (!normalizedDiameter) {
    return { value: null, source: null, diameter: null };
  }

  const common = getCommonReinforcementStrengthMap(element).get(normalizedDiameter) || null;
  return {
    value: common,
    source: common ? 'common' : null,
    diameter: normalizedDiameter,
  };
}
