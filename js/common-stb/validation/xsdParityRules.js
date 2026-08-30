/**
 * @fileoverview XSD 1.0 と JSON Schema 検証の差分を埋める補助ルール。
 *
 * JSON Schema へ変換すると失われる XML 名前空間と simple content のうち、
 * ST-Bridge 2.0.2 で実際に使用される stb:monolist を検証する。
 *
 * SIMPLE_CONTENT_MONOLIST_202 は ST-Bridge202.xsd のトップレベル要素から
 * type="stb:monolist" または simpleContent/extension base="stb:monolist" を抽出したもの。
 */

export const STB_TARGET_NAMESPACE = 'https://www.building-smart.or.jp/dl';

const SIMPLE_CONTENT_MONOLIST_202 = new Set([
  'StbNodeIdOrder',
  'StbCalStoryDivided',
  'StbCalColumnFinish_RC_LoadList',
  'StbCalColumnFinish_RC_MemList',
  'StbCalColumnFinish_RC_CalMemList',
  'StbCalColumnFinish_S_LoadList',
  'StbCalColumnFinish_S_MemList',
  'StbCalColumnFinish_S_CalMemList',
  'StbCalColumnMemberLoadList',
  'StbCalColumnMemberLoadMemList',
  'StbCalColumnMemberLoadCalMemList',
  'StbCalGirderFinish_RC_LoadList',
  'StbCalGirderFinish_RC_MemList',
  'StbCalGirderFinish_RC_CalMemList',
  'StbCalGirderFinish_S_LoadList',
  'StbCalGirderFinish_S_MemList',
  'StbCalGirderFinish_S_CalMemList',
  'StbCalGirderMemberLoadList',
  'StbCalGirderMemberLoadMemList',
  'StbCalGirderMemberLoadCalMemList',
  'StbCalBeamFinish_RC_LoadList',
  'StbCalBeamFinish_RC_MemList',
  'StbCalBeamFinish_S_LoadList',
  'StbCalBeamFinish_S_MemList',
  'StbCalBeamMemberLoadList',
  'StbCalBeamMemberLoadMemList',
  'StbCalBraceFinish_S_LoadList',
  'StbCalBraceFinish_S_MemList',
  'StbCalSlabLiveLoadList',
  'StbCalSlabLiveLoadMemList',
  'StbCalSlabFinish_RC_LoadList',
  'StbCalSlabFinish_RC_MemList',
  'StbCalSlabAreaLoadList',
  'StbCalSlabAreaLoadMemList',
  'StbCalSlabPressureLoadList',
  'StbCalSlabPressureLoadMemList',
  'StbCalWallFinish_RC_LoadList',
  'StbCalWallFinish_RC_MemList',
  'StbCalWallAreaLoadList',
  'StbCalWallAreaLoadMemList',
  'StbCalWallPressureLoadList',
  'StbCalWallPressureLoadMemList',
  'StbCalNodeWeightLoadList',
  'StbCalNodeWeightNodeList',
  'StbCalNodePointLoadList',
  'StbCalNodePointLoadNodeList',
  'StbCalColumnConditionList',
  'StbCalColumnConditionMemList',
  'StbCalColumnConditionCalMemList',
  'StbCalColumnRigidzoneList',
  'StbCalColumnRigidzoneMemList',
  'StbCalColumnRigidzoneCalMemList',
  'StbCalColumnCriticalPositionList',
  'StbCalColumnCriticalPositionMemList',
  'StbCalColumnCriticalPositionCalMemList',
  'StbCalColumnStiffnessList',
  'StbCalColumnStiffnessMemList',
  'StbCalColumnStiffnessCalMemList',
  'StbCalGirderConditionList',
  'StbCalGirderConditionMemList',
  'StbCalGirderConditionCalMemList',
  'StbCalGirderRigidzoneList',
  'StbCalGirderRigidzoneMemList',
  'StbCalGirderRigidzoneCalMemList',
  'StbCalGirderCriticalPositionList',
  'StbCalGirderCriticalPositionMemList',
  'StbCalGirderCriticalPositionCalMemList',
  'StbCalGirderStiffnessList',
  'StbCalGirderStiffnessMemList',
  'StbCalGirderStiffnessCalMemList',
  'StbCalBraceStiffnessList',
  'StbCalBraceStiffnessMemList',
  'StbCalWallStiffnessList',
  'StbCalWallStiffnessMemList',
  'StbCalNodeRestrictionList',
  'StbCalNodeRestrictionNodeList',
  'StbCalNodePanelList',
  'StbCalNodePanelNodeList',
  'StbCalColumnSecPropertyList',
  'StbCalColumnSecProperty_RC_List',
  'StbCalColumnSecProperty_S_List',
  'StbCalColumnSecProperty_SRC_List',
  'StbCalColumnSecProperty_CFT_List',
  'StbCalGirderSecPropertyList',
  'StbCalGirderSecProperty_RC_List',
  'StbCalGirderSecProperty_S_List',
  'StbCalGirderSecProperty_SRC_List',
  'StbCalBraceSecPropertyList',
  'StbCalBraceSecProperty_S_List',
  'StbCalSlabSecPropertyList',
  'StbCalSlabSecProperty_RC_List',
  'StbCalSlabSecPropertyDeckList',
  'StbCalSlabSecPropertyPrecastList',
  'StbCalWallSecPropertyList',
  'StbCalWallSecProperty_RC_List',
  'StbAnaNodeRel',
  'StbAnaStoryRel',
  'StbAnaMemberRel',
  'StbAnaCalMemberRel',
  'StbAnaPropertyRel',
]);

/**
 * ST-Bridge XML のルート名前空間を検証する。
 * synthetic unit test との互換性のため version 属性がある実STBだけを対象とする。
 * @param {Element} root
 * @returns {{valid: boolean, actual: string, expected: string}|null}
 */
export function validateStbNamespace(root) {
  if (!root || !root.getAttribute || !root.getAttribute('version')) return null;

  const actual = root.namespaceURI || '';
  return {
    valid: actual === STB_TARGET_NAMESPACE,
    actual,
    expected: STB_TARGET_NAMESPACE,
  };
}

/**
 * ST-Bridge 2.0.2 の simple content (stb:monolist) を検証する。
 * monolist = positiveIntegerList に minLength=3 を課した XSD list 型。
 * @param {string} version
 * @param {string} elementName
 * @param {string} textContent
 * @returns {{valid: boolean, reason?: string, expected?: string}|null}
 */
export function validateSimpleContent(version, elementName, textContent) {
  if (!version?.startsWith('2.0')) return null;
  if (!SIMPLE_CONTENT_MONOLIST_202.has(elementName)) return null;

  const normalized = String(textContent ?? '').trim();
  const items = normalized === '' ? [] : normalized.split(/\s+/);

  if (items.length < 3) {
    return {
      valid: false,
      reason: `stb:monolist は3個以上の正の整数を必要とします（現在 ${items.length} 個）`,
      expected: '3個以上の xs:positiveInteger',
    };
  }

  const invalid = items.find((item) => !/^\+?\d+$/.test(item) || Number(item) <= 0);
  if (invalid !== undefined) {
    return {
      valid: false,
      reason: `stb:monolist に正の整数ではない値 '${invalid}' が含まれています`,
      expected: '空白区切りの xs:positiveInteger',
    };
  }

  return { valid: true };
}
