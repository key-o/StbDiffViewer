/**
 * @fileoverview 断面・鉄骨・開口レンダリング機能
 *
 * 鉄骨断面要素、開口要素の検索とレンダリング、
 * およびpos属性マッチングロジックを提供します。
 */

import { getAttributesMap } from './SectionHelpers.js';
import {
  comparableAttributeDiffers,
  buildAttributeValidationStatusMap,
  getValidationCellMeta,
  buildCellClassAttr,
} from './comparisonUtils.js';
import { escapeHtml, valueToSafeHtml } from '../../../utils/htmlUtils.js';

/**
 * XMLドキュメントのStbSecSteelからshape名で鉄骨断面要素を検索する
 * @param {Document|null} doc - XMLドキュメント
 * @param {string} shapeName - 断面形状名
 * @returns {{element: Element, tagName: string}|null} 見つかった要素とタグ名
 */
export function findSteelSectionElement(doc, shapeName) {
  if (!doc || !shapeName) return null;
  const steel = doc.querySelector('StbSecSteel');
  if (!steel) return null;

  const tags = [
    'StbSecRoll-H',
    'StbSecRoll-BOX',
    'StbSecRoll-L',
    'StbSecRoll-T',
    'StbSecRoll-C',
    'StbSecRoll-Pipe',
    'StbSecRoll-Bar',
    'StbSecRoll-FlatBar',
    'StbSecBuild-H',
    'StbSecBuild-BOX',
  ];
  for (const tag of tags) {
    const el = Array.from(steel.querySelectorAll(tag)).find(
      (candidate) => candidate.getAttribute('name') === shapeName,
    );
    if (el) return { element: el, tagName: tag };
  }
  return null;
}

/**
 * 鉄骨断面要素の折りたたみ可能なブロックを生成する
 * @param {string} shapeA - モデルAのshape名
 * @param {string} shapeB - モデルBのshape名
 * @param {boolean} showSingleColumn - 単一モデル表示かどうか
 * @param {string} elementIndentStyle - 要素行のインデントスタイル
 * @param {string} attrIndentStyle - 属性行のインデントスタイル
 * @param {string} parentRowId - 親行ID
 * @returns {string} HTML文字列
 */
export function renderSteelSectionBlock(
  shapeA,
  shapeB,
  showSingleColumn,
  elementIndentStyle,
  attrIndentStyle,
  parentRowId,
  docA = null,
  docB = null,
) {
  const resultA = shapeA ? findSteelSectionElement(docA, shapeA) : null;
  const resultB = shapeB ? findSteelSectionElement(docB, shapeB) : null;
  if (!resultA && !resultB) return '';

  const shape = shapeA || shapeB;
  const tagName = resultA?.tagName || resultB?.tagName;
  const blockRowId = `row_steel_${Math.random().toString(36).slice(2, 7)}`;

  // 要素行: StbSecRoll-H[@name="H-700x300x13x24x18"]
  let html = `<tr class="element-row" data-id="${blockRowId}" data-parent="${parentRowId}">`;
  html += `<td style="${elementIndentStyle} white-space: nowrap;">`;
  html += `<span class="toggle-btn" data-target-id="${blockRowId}" style="margin-right:5px;display:inline-block;width:1em;text-align:center;font-weight:var(--font-weight-bold);cursor:pointer;color:#666;">-</span>`;
  html += `<span class="tag-name">${escapeHtml(tagName)}[@name="${escapeHtml(shape)}"]</span>`;
  html += '</td>';
  if (showSingleColumn) {
    html += '<td></td>';
  } else {
    html += '<td></td><td></td>';
  }
  html += '</tr>';

  // 属性行: バリデーション状態付きで列挙（name以外）
  const attrsA = resultA ? getAttributesMap(resultA.element) : new Map();
  const attrsB = resultB ? getAttributesMap(resultB.element) : new Map();
  const allAttrs = new Set([...attrsA.keys(), ...attrsB.keys()]);
  const validationMapA = buildAttributeValidationStatusMap(shapeA || '', {
    targetElementName: tagName,
  });
  const validationMapB = buildAttributeValidationStatusMap(shapeB || '', {
    targetElementName: tagName,
  });

  for (const attr of allAttrs) {
    if (attr === 'name') continue;
    const valA = attrsA.get(attr);
    const valB = attrsB.get(attr);

    if (showSingleColumn) {
      const val = valueToSafeHtml(valA ?? valB, '-');
      const activeMap = validationMapA.size > 0 ? validationMapA : validationMapB;
      const validationMeta = getValidationCellMeta(attr, activeMap);
      const cellClass = buildCellClassAttr(validationMeta.className);
      html += `<tr data-parent="${blockRowId}">`;
      html += `<td style="${attrIndentStyle}"><span class="attr-name">${escapeHtml(attr)}</span></td>`;
      html += `<td${cellClass}${validationMeta.titleAttr} style="color: #555;">${val}</td>`;
      html += '</tr>';
    } else {
      const displayA = valueToSafeHtml(valA);
      const displayB = valueToSafeHtml(valB);
      const differs = valA != null && valB != null && comparableAttributeDiffers(attr, valA, valB);
      const validationMetaA = getValidationCellMeta(attr, validationMapA);
      const validationMetaB = getValidationCellMeta(attr, validationMapB);
      const classAttrA = buildCellClassAttr(differs ? 'differs' : '', validationMetaA.className);
      const classAttrB = buildCellClassAttr(differs ? 'differs' : '', validationMetaB.className);
      html += `<tr data-parent="${blockRowId}">`;
      html += `<td style="${attrIndentStyle}"><span class="attr-name">${escapeHtml(attr)}</span></td>`;
      html += `<td${classAttrA}${validationMetaA.titleAttr} style="color: #555;">${displayA}</td>`;
      html += `<td${classAttrB}${validationMetaB.titleAttr} style="color: #555;">${displayB}</td>`;
      html += '</tr>';
    }
  }
  return html;
}

/**
 * XMLドキュメントからStbOpen要素（v2.0.2）またはStbOpenArrangement要素（v2.1.0）を検索する
 * @param {Document|null} doc - XMLドキュメント
 * @param {string} openingId - 開口ID
 * @returns {Element|null} 見つかった開口XML要素
 */
export function findOpeningXmlElement(doc, openingId) {
  if (!doc || !openingId) return null;
  const candidates = doc.querySelectorAll('StbOpen, StbOpenArrangement');
  return Array.from(candidates).find((el) => el.getAttribute('id') === openingId) || null;
}

/**
 * 開口のセクション情報（StbSecOpen_RC）から寸法を取得する
 * @param {Document|null} doc - XMLドキュメント
 * @param {string} idSection - セクションID
 * @returns {{length_X: string, length_Y: string}|null} 寸法情報
 */
export function findOpeningSectionDimensions(doc, idSection) {
  if (!doc || !idSection) return null;
  const secEl =
    Array.from(doc.querySelectorAll('StbSecOpen_RC')).find(
      (el) => el.getAttribute('id') === idSection,
    ) || null;
  if (!secEl) return null;
  const lx = secEl.getAttribute('length_X');
  const ly = secEl.getAttribute('length_Y');
  if (!lx && !ly) return null;
  return { length_X: lx, length_Y: ly };
}

/**
 * StbOpenId要素の後に開口プロパティ（位置・サイズ・回転）を折りたたみブロックで表示する
 * @param {string|undefined} openIdA - モデルAの開口ID
 * @param {string|undefined} openIdB - モデルBの開口ID
 * @param {boolean} showSingleColumn - 単一モデル表示かどうか
 * @param {string} elementIndentStyle - 要素行のインデントスタイル
 * @param {string} attrIndentStyle - 属性行のインデントスタイル
 * @param {string} parentRowId - 親行ID
 * @returns {string} HTML文字列
 */
export function renderOpeningPropertiesBlock(
  openIdA,
  openIdB,
  showSingleColumn,
  elementIndentStyle,
  attrIndentStyle,
  parentRowId,
  docA = null,
  docB = null,
) {
  const openElA = openIdA ? findOpeningXmlElement(docA, openIdA) : null;
  const openElB = openIdB ? findOpeningXmlElement(docB, openIdB) : null;
  if (!openElA && !openElB) return '';

  const openId = openIdA || openIdB;
  const tagName = openElA?.tagName || openElB?.tagName;
  const blockRowId = `row_open_${Math.random().toString(36).slice(2, 7)}`;

  // 要素行: StbOpen[@id="101"]
  let html = `<tr class="element-row" data-id="${blockRowId}" data-parent="${parentRowId}">`;
  html += `<td style="${elementIndentStyle} white-space: nowrap;">`;
  html += `<span class="toggle-btn" data-target-id="${blockRowId}" style="margin-right:5px;display:inline-block;width:1em;text-align:center;font-weight:var(--font-weight-bold);cursor:pointer;color:#666;">-</span>`;
  html += `<span class="tag-name">${escapeHtml(tagName)}[@id="${escapeHtml(openId)}"]</span>`;
  html += '</td>';
  if (showSingleColumn) {
    html += '<td></td>';
  } else {
    html += '<td></td><td></td>';
  }
  html += '</tr>';

  // 属性行: 開口プロパティを列挙（id以外）
  const attrsA = openElA ? getAttributesMap(openElA) : new Map();
  const attrsB = openElB ? getAttributesMap(openElB) : new Map();

  // v2.1.0の場合、StbSecOpen_RCからlength_X/length_Yを補完
  const idSectionA = attrsA.get('id_section');
  const idSectionB = attrsB.get('id_section');
  if (idSectionA && !attrsA.has('length_X')) {
    const dims = findOpeningSectionDimensions(docA, idSectionA);
    if (dims) {
      if (dims.length_X) attrsA.set('length_X', dims.length_X);
      if (dims.length_Y) attrsA.set('length_Y', dims.length_Y);
    }
  }
  if (idSectionB && !attrsB.has('length_X')) {
    const dims = findOpeningSectionDimensions(docB, idSectionB);
    if (dims) {
      if (dims.length_X) attrsB.set('length_X', dims.length_X);
      if (dims.length_Y) attrsB.set('length_Y', dims.length_Y);
    }
  }

  const allAttrs = new Set([...attrsA.keys(), ...attrsB.keys()]);

  // 表示順を制御：重要な属性を先に
  const priorityOrder = [
    'name',
    'position_X',
    'position_Y',
    'length_X',
    'length_Y',
    'rotate',
    'id_section',
    'kind_member',
    'id_member',
    'guid',
  ];
  const sortedAttrs = Array.from(allAttrs)
    .filter((a) => a !== 'id')
    .sort((a, b) => {
      const idxA = priorityOrder.indexOf(a);
      const idxB = priorityOrder.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

  for (const attr of sortedAttrs) {
    const valA = attrsA.get(attr);
    const valB = attrsB.get(attr);

    if (showSingleColumn) {
      const val = valueToSafeHtml(valA ?? valB, '-');
      html += `<tr data-parent="${blockRowId}">`;
      html += `<td style="${attrIndentStyle}"><span class="attr-name">${escapeHtml(attr)}</span></td>`;
      html += `<td style="color: #555;">${val}</td>`;
      html += '</tr>';
    } else {
      const displayA = valueToSafeHtml(valA);
      const displayB = valueToSafeHtml(valB);
      const differs = valA != null && valB != null && comparableAttributeDiffers(attr, valA, valB);
      const highlightClass = differs ? ' class="differs"' : '';
      html += `<tr data-parent="${blockRowId}">`;
      html += `<td style="${attrIndentStyle}"><span class="attr-name">${escapeHtml(attr)}</span></td>`;
      html += `<td${highlightClass} style="color: #555;">${displayA}</td>`;
      html += `<td${highlightClass} style="color: #555;">${displayB}</td>`;
      html += '</tr>';
    }
  }
  return html;
}

/**
 * pos属性でマッチングすべき要素タイプのリスト
 * これらの要素は子要素比較時にpos属性値で対応付けを行う
 */
const POS_MATCHING_ELEMENT_TYPES = new Set([
  // 柱配筋
  'StbSecBarColumnRectComplexMain',
  'StbSecBarColumnRectNotSameSimple',
  'StbSecBarColumnRectNotSameComplex',
  'StbSecBarColumnCircleNotSameSimple',
  'StbSecBarColumnCircleNotSameComplex',
  // 柱鉄骨
  'StbSecSteelColumn_S_NotSame',
  'StbSecSteelColumn_S_ThreeTypes',
  'StbSecSteelColumn_SRC_NotSame',
  'StbSecSteelColumn_SRC_ThreeTypes',
  'StbSecSteelColumn_CFT_NotSame',
  'StbSecSteelColumn_CFT_ThreeTypes',
  // 梁配筋
  'StbSecBarBeamSimpleMain',
  'StbSecBarBeamComplexMain',
  'StbSecBarBeam_RC_ThreeTypes',
  'StbSecBarBeam_RC_StartEnd',
  // 梁鉄骨
  'StbSecSteelBeamWidening',
  'StbSecSteelBeam_S_Taper',
  'StbSecSteelBeam_S_Joint',
  'StbSecSteelBeam_S_Haunch',
  'StbSecSteelBeam_S_FiveTypes',
  // ブレース鉄骨
  'StbSecSteelBrace_S_NotSame',
  'StbSecSteelBrace_S_ThreeTypes',
  // スラブ配筋
  'StbSecBarSlab_RC_ConventionalStandard',
  'StbSecBarSlab_RC_Conventional2Way',
  'StbSecBarSlab_RC_Conventional1Way1',
  'StbSecBarSlab_RC_Conventional1Way2',
  'StbSecBarSlab_RC_Open',
  'StbSecBarSlab_RC_Truss1Way',
  // 壁配筋
  'StbSecBarWall_RC_Single',
  'StbSecBarWall_RC_Zigzag',
  'StbSecBarWall_RC_DoubleNet',
  'StbSecBarWall_RC_InsideAndOutside',
  'StbSecBarWall_RC_Edge',
  'StbSecBarWall_RC_Open',
  // 基礎配筋
  'StbSecBarFoundation_RC_Rect',
  'StbSecBarFoundation_RC_Triangle',
  'StbSecBarFoundation_RC_ThreeWay',
  'StbSecBarFoundation_RC_Continuous',
  // 杭配筋
  'StbSecBarPile_RC_TopBottom',
  'StbSecBarPile_RC_TopCenterBottom',
  // パラペット配筋
  'StbSecBarParapet_RC_Single',
  'StbSecBarParapet_RC_Zigzag',
  'StbSecBarParapet_RC_DoubleNet',
  'StbSecBarParapet_RC_Tip',
  'StbSecBarParapet_RC_Edge',
  // 開口補強筋
  'StbSecBarOpen_RC_Slab',
  'StbSecBarOpen_RC_Wall',
  // 免震装置
  'StbSecIsolatingDeviceESB',
  'StbSecIsolatingDeviceRSB',
]);

/**
 * 子要素がpos属性でマッチングすべきかどうかを判定する
 * @param {Array<Element>} childrenA - モデルAの子要素
 * @param {Array<Element>} childrenB - モデルBの子要素
 * @returns {boolean} pos属性マッチングが必要かどうか
 */
export function shouldUsePosMatching(childrenA, childrenB) {
  const allChildren = [...childrenA, ...childrenB];
  if (allChildren.length === 0) return false;

  // 最初の子要素のタグ名を確認
  const firstChild = allChildren[0];
  const tagName = firstChild?.tagName;

  if (!tagName || !POS_MATCHING_ELEMENT_TYPES.has(tagName)) {
    return false;
  }

  // 実際にpos属性を持っているか確認
  return allChildren.some((child) => child.getAttribute?.('pos'));
}

/**
 * pos属性でマッチングした子要素ペアを生成する
 * @param {Array<Element>} childrenA - モデルAの子要素
 * @param {Array<Element>} childrenB - モデルBの子要素
 * @returns {Array<{childA: Element|null, childB: Element|null}>} マッチングされたペアの配列
 */
export function matchChildrenByPos(childrenA, childrenB) {
  const posMapA = new Map();
  const posMapB = new Map();

  for (const child of childrenA) {
    const pos = child.getAttribute?.('pos');
    if (pos) posMapA.set(pos, child);
  }
  for (const child of childrenB) {
    const pos = child.getAttribute?.('pos');
    if (pos) posMapB.set(pos, child);
  }

  // 全てのユニークなpos値を収集
  const allPosValues = new Set([...posMapA.keys(), ...posMapB.keys()]);

  // pos値でソートしてペアを生成（表示順の一貫性のため）
  const sortedPosValues = Array.from(allPosValues).sort();

  return sortedPosValues.map((pos) => ({
    childA: posMapA.get(pos) ?? null,
    childB: posMapB.get(pos) ?? null,
  }));
}
