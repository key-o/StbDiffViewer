/**
 * @fileoverview 比較レンダリング機能
 *
 * モデルA/B間の要素比較テーブルをレンダリングする機能を提供します。
 * 属性、子要素、テキストコンテンツの再帰的比較表示を担当します。
 *
 * ヘルパー関数は以下のサブモジュールに分割されています:
 * - comparisonUtils.js: 属性比較、バリデーション状態マップなどのユーティリティ
 * - comparisonNodeRenderer.js: ノード座標レンダリング
 * - comparisonSectionRenderer.js: 鉄骨断面、開口、pos属性マッチング
 * - comparisonTableStyles.js: 比較テーブルのCSSスタイル生成
 */

import {
  isSchemaLoaded,
  getAllAttributeNames,
  getAttributeInfo,
} from '../../../common-stb/import/parser/jsonSchemaLoader.js';
import { getImportanceCircleHtml, getImportanceCircleHtmlByPath } from './ImportanceColors.js';
import {
  findSectionNode,
  extractSectionData,
  generateEquivalenceSection,
  generateGeometryEquivalenceSection,
  getGeometrySectionData,
  getAttributesMap,
} from './SectionHelpers.js';
import { evaluateSectionEquivalence } from './ElementInfoProviders.js';
import comparisonKeyManager from '../../../app/comparisonKeyManager.js';
import { SECTION_MATCH_CRITERION_LABELS } from '../../../config/comparisonKeyConfig.js';
import {
  buildGeometryShapeSignature,
  describeGeometryShape,
} from '../../../common-stb/comparison/geometryShapeSignature.js';
import { isEditMode, getCurrentEditingElement } from './editMode/index.js';
import { buildElementEditPath } from './editPath.js';
import { escapeHtml, valueToSafeHtml } from '../../../utils/htmlUtils.js';
import { getState } from '../../../data/state/globalState.js';

// サブモジュールからのインポート
import {
  comparableAttributeDiffers,
  buildXPathFromXmlElement,
  buildAttributeValidationStatusMap,
  getValidationCellMeta,
  buildCellClassAttr,
} from './comparisonUtils.js';
import {
  renderNodeCoordinateRows,
  renderNodeIdListCoordinateRows,
} from './comparisonNodeRenderer.js';
import {
  renderSteelSectionBlock,
  renderOpeningPropertiesBlock,
  findOpeningSectionDimensions,
  shouldUsePosMatching,
  matchChildrenByPos,
} from './comparisonSectionRenderer.js';

export { generateTableStyles } from './comparisonTableStyles.js';

/**
 * 壁要素に関連する開口情報セクションを生成する（v2.1.0: StbOpenArrangement経由）
 * @param {Element|null} nodeA - モデルAの壁要素ノード
 * @param {Element|null} nodeB - モデルBの壁要素ノード
 * @param {boolean} showSingleColumn - 単一モデル表示かどうか
 * @returns {string} 開口情報セクションのHTML
 */
export function renderOpeningInfo(nodeA, nodeB, showSingleColumn) {
  const wallIdA = nodeA?.getAttribute('id');
  const wallIdB = nodeB?.getAttribute('id');

  // v2.0.2の場合はStbOpenIdListが子要素として既に表示されているのでスキップ
  const hasOpenIdListA = nodeA?.querySelector('StbOpenIdList');
  const hasOpenIdListB = nodeB?.querySelector('StbOpenIdList');
  if (hasOpenIdListA || hasOpenIdListB) return '';

  // v2.1.0: StbOpenArrangement[@id_member="wallId"][@kind_member="WALL"] を検索
  const docA = getState('models.documentA');
  const docB = getState('models.documentB');
  const openingsA = wallIdA
    ? Array.from(
        docA?.querySelectorAll(`StbOpenArrangement[id_member="${wallIdA}"][kind_member="WALL"]`) ||
          [],
      )
    : [];
  const openingsB = wallIdB
    ? Array.from(
        docB?.querySelectorAll(`StbOpenArrangement[id_member="${wallIdB}"][kind_member="WALL"]`) ||
          [],
      )
    : [];

  if (openingsA.length === 0 && openingsB.length === 0) return '';

  // 開口IDでマッチング
  const openMapA = new Map();
  const openMapB = new Map();
  for (const el of openingsA) openMapA.set(el.getAttribute('id'), el);
  for (const el of openingsB) openMapB.set(el.getAttribute('id'), el);
  const allOpenIds = new Set([...openMapA.keys(), ...openMapB.keys()]);

  // セクションヘッダー
  let content = '';
  if (showSingleColumn) {
    content += `<tr class="section-header-row"><td colspan="2">▼ 開口情報 (${allOpenIds.size}個)</td></tr>`;
  } else {
    content += `<tr class="section-header-row"><td colspan="3">▼ 開口情報 (A: ${openingsA.length}個, B: ${openingsB.length}個)</td></tr>`;
  }

  // 各開口を比較表示
  for (const openId of allOpenIds) {
    const elA = openMapA.get(openId) || null;
    const elB = openMapB.get(openId) || null;
    content += renderComparisonRecursive(elA, elB, 0, 'opening', showSingleColumn, null, null);

    // StbSecOpen_RCの寸法補完行を追加
    const idSectionA = elA?.getAttribute('id_section');
    const idSectionB = elB?.getAttribute('id_section');
    const dimsA = findOpeningSectionDimensions(docA, idSectionA);
    const dimsB = findOpeningSectionDimensions(docB, idSectionB);
    if (dimsA || dimsB) {
      const secRowId = `row_sec_open_${Math.random().toString(36).slice(2, 7)}`;
      const indentStyle = 'padding-left: 1.5em;';
      const attrIndentStyle = 'padding-left: 3em;';

      content += `<tr class="element-row" data-id="${secRowId}" data-parent="opening">`;
      content += `<td style="${indentStyle} white-space: nowrap;">`;
      content += `<span class="toggle-btn" data-target-id="${secRowId}" style="margin-right:5px;display:inline-block;width:1em;text-align:center;font-weight:var(--font-weight-bold);cursor:pointer;color:#666;">-</span>`;
      content += '<span class="tag-name">StbSecOpen_RC (寸法)</span>';
      content += '</td>';
      if (showSingleColumn) {
        content += '<td></td>';
      } else {
        content += '<td></td><td></td>';
      }
      content += '</tr>';

      for (const dimAttr of ['length_X', 'length_Y']) {
        const valA = dimsA?.[dimAttr];
        const valB = dimsB?.[dimAttr];
        if (showSingleColumn) {
          const val = valueToSafeHtml(valA ?? valB, '-');
          content += `<tr data-parent="${secRowId}">`;
          content += `<td style="${attrIndentStyle}"><span class="attr-name">${escapeHtml(dimAttr)}</span></td>`;
          content += `<td style="color: #555;">${val}</td>`;
          content += '</tr>';
        } else {
          const displayA = valueToSafeHtml(valA);
          const displayB = valueToSafeHtml(valB);
          const differs =
            valA != null && valB != null && comparableAttributeDiffers(dimAttr, valA, valB);
          const highlightClass = differs ? ' class="differs"' : '';
          content += `<tr data-parent="${secRowId}">`;
          content += `<td style="${attrIndentStyle}"><span class="attr-name">${escapeHtml(dimAttr)}</span></td>`;
          content += `<td${highlightClass} style="color: #555;">${displayA}</td>`;
          content += `<td${highlightClass} style="color: #555;">${displayB}</td>`;
          content += '</tr>';
        }
      }
    }
  }

  return content;
}

/**
 * 断面情報セクションのHTMLを生成
 * @param {Element|null} nodeA - モデルAの要素ノード
 * @param {Element|null} nodeB - モデルBの要素ノード
 * @param {boolean} showSingleColumn - 単一モデル表示かどうか
 * @param {string|null} modelSource - モデルソース
 * @param {string|null} elementType - 要素タイプ
 * @returns {string} セクション情報のHTML
 */
export function renderSectionInfo(nodeA, nodeB, showSingleColumn, modelSource, elementType) {
  const sectionIdA = nodeA?.getAttribute('id_section');
  const sectionIdB = nodeB?.getAttribute('id_section');
  const hasSectionInfo = sectionIdA || sectionIdB;

  if (!hasSectionInfo) {
    return '';
  }

  let content = '';

  const docA = getState('models.documentA');
  const docB = getState('models.documentB');
  const sectionNodeA = sectionIdA ? findSectionNode(docA, sectionIdA, elementType) : null;
  const sectionNodeB = sectionIdB ? findSectionNode(docB, sectionIdB, elementType) : null;

  // 断面等価性評価の実行（比較モードの場合のみ）。
  // 形状（GSS）と属性評価は対応付け基準から独立した別々の結果として扱う。
  let equivalenceResult = null;
  let geometryEquivalence = null;
  if (!showSingleColumn && sectionNodeA && sectionNodeB && modelSource === 'matched') {
    const geomSectionA = getGeometrySectionData(docA, sectionIdA, elementType);
    const geomSectionB = getGeometrySectionData(docB, sectionIdB, elementType);
    const gssA = geomSectionA ? buildGeometryShapeSignature(geomSectionA, elementType) : null;
    const gssB = geomSectionB ? buildGeometryShapeSignature(geomSectionB, elementType) : null;

    if (gssA != null || gssB != null) {
      geometryEquivalence = {
        equivalent: gssA != null && gssA === gssB,
        descA: geomSectionA ? describeGeometryShape(geomSectionA, elementType) : null,
        descB: geomSectionB ? describeGeometryShape(geomSectionB, elementType) : null,
      };
    }

    const sectionDataA = extractSectionData(sectionNodeA);
    const sectionDataB = extractSectionData(sectionNodeB);
    if (sectionDataA && sectionDataB) {
      equivalenceResult = evaluateSectionEquivalence(sectionDataA, sectionDataB, elementType);
    }
  }

  // 断面情報セクションのヘッダー行を追加
  if (showSingleColumn) {
    const sectionId = sectionIdA || sectionIdB;
    content += `<tr class="section-header-row"><td colspan="2">▼ 断面情報 (ID: ${escapeHtml(sectionId)})</td></tr>`;
  } else {
    content += `<tr class="section-header-row"><td colspan="3">▼ 断面情報 (A: ${
      sectionIdA ? escapeHtml(sectionIdA) : 'なし'
    }, B: ${sectionIdB ? escapeHtml(sectionIdB) : 'なし'})</td></tr>`;
  }

  // 断面等価性評価結果を表示（比較モードの場合）。
  // 選択中の断面対応付け基準（部材レベル）を、対応後の等価判定結果とは分けて併記する。
  const criterionLabel =
    SECTION_MATCH_CRITERION_LABELS[comparisonKeyManager.getSectionMatchCriterion()] || null;
  if (geometryEquivalence && !showSingleColumn) {
    content += generateGeometryEquivalenceSection(geometryEquivalence, criterionLabel);
  }
  if (equivalenceResult && !showSingleColumn) {
    content += generateEquivalenceSection(equivalenceResult, criterionLabel);
  }

  // 断面要素の比較表示 (ルート要素と同じレベルで表示)
  content += renderComparisonRecursive(
    sectionNodeA,
    sectionNodeB,
    0,
    'section',
    showSingleColumn,
    modelSource,
    elementType,
  );

  return content;
}

/**
 * ノードのテキストコンテンツが「意味のある内容」かを判定する
 *
 * 子要素を持たず、かつ全属性値の連結と一致しないテキストのみを内容とみなす
 * （属性値がそのまま textContent として現れるDOM実装での誤検出を避ける）。
 *
 * @param {Element|null} node - 判定対象のノード
 * @param {string|undefined} text - trim 済みの textContent
 * @returns {boolean} 内容として表示すべきなら true
 */
function hasMeaningfulNodeText(node, text) {
  if (!node || node.children.length !== 0 || !text) return false;

  let attrsText = '';
  for (let i = 0; i < node.attributes.length; i++) {
    attrsText += node.attributes[i].value;
  }
  return text !== attrsText.trim();
}

/**
 * 編集ボタンHTMLを生成する（編集対象はモデルAのみ）。
 * id属性を持たない断面子要素はパスアドレッシングで特定する。
 * クリック処理は editMode（editModeToggle.js）のイベントデリゲーションが担当する。
 * @param {Element|null} nodeA - モデルAのXML要素（B側要素は編集不可）
 * @param {string} editType - 要素タイプ（タグ名から 'Stb' を除いたもの）
 * @param {string} attrName - 属性名
 * @param {string|undefined} currentValue - 現在の値
 * @returns {string} ボタンHTML（編集不可の場合は空文字列）
 */
function buildEditButtonHtml(nodeA, editType, attrName, currentValue) {
  if (!nodeA) return '';

  const id = typeof nodeA.getAttribute === 'function' ? nodeA.getAttribute('id') : null;
  let addressAttr = '';
  if (id) {
    addressAttr = ` data-edit-id="${escapeHtml(id)}"`;
  } else {
    const path = buildElementEditPath(nodeA);
    if (!path) return '';
    addressAttr = ` data-edit-path="${escapeHtml(path)}"`;
  }

  return (
    ` <button class="edit-btn" style="font-size: var(--font-size-xs); padding: 1px 2px; background: none; border: none; opacity: 0.5; cursor: pointer;"` +
    ` data-edit-type="${escapeHtml(editType)}" data-edit-attr="${escapeHtml(attrName)}"` +
    ` data-edit-value="${escapeHtml(currentValue ?? '')}"${addressAttr} title="編集">✏️</button>`
  );
}

/**
 * XML要素とその子孫を再帰的に比較処理し、3列比較テーブルまたは2列単一モデルテーブルの行HTMLを生成する。
 * @param {Element | null} nodeA - モデルAの要素。
 * @param {Element | null} nodeB - モデルBの要素。
 * @param {number} level - 現在の階層レベル (インデント用)。
 * @param {string} parentId - 親要素のID (折りたたみ制御用)。
 * @param {boolean} showSingleColumn - 単一モデル表示かどうか。
 * @param {string | null} modelSource - 要素のモデルソース ('A', 'B', 'matched', またはnull)
 * @param {string | null} elementType - 要素タイプ (色付け用)
 * @param {{idA: string, idB: string}} [validationContext] - 子要素に継承する検証アンカーID
 * @returns {string} テーブル行(<tr>...</tr>)のHTML文字列。子孫要素の行も含む。
 */
export function renderComparisonRecursive(
  nodeA,
  nodeB,
  level,
  parentId,
  showSingleColumn = false,
  modelSource = null,
  elementType = null,
  validationContext = { idA: '', idB: '' },
) {
  if (!nodeA && !nodeB) return ''; // 両方なければ何も表示しない

  let rowsHtml = '';
  const indentStyle = `padding-left: ${level * 1.5}em;`;
  const attrIndentStyle = `padding-left: ${(level + 1.5) * 1.5}em;`;

  // --- 一意なID生成 ---
  const tagNameA = nodeA?.tagName;
  const tagNameB = nodeB?.tagName;
  const displayTagName = tagNameA ?? tagNameB;
  const idA = nodeA?.getAttribute?.('id') ?? '';
  const idB = nodeB?.getAttribute?.('id') ?? '';
  const effectiveValidationIdA = idA || validationContext.idA || '';
  const effectiveValidationIdB = idB || validationContext.idB || '';
  const attrValidationMapA = buildAttributeValidationStatusMap(effectiveValidationIdA, {
    targetElementName: displayTagName,
  });
  const attrValidationMapB = buildAttributeValidationStatusMap(effectiveValidationIdB, {
    targetElementName: displayTagName,
  });
  const rowId = `row_${level}_${Math.random().toString(36).slice(2, 7)}`;

  // --- 要素タイプの判定 ---
  // パラメータから渡されたelementTypeを優先し、なければタグ名から推定
  let currentElementType = elementType;
  if (!currentElementType && displayTagName) {
    // STBタグ名から要素タイプを抽出 (例: StbColumn -> Column, StbNode -> Node)
    if (displayTagName.startsWith('Stb')) {
      currentElementType = displayTagName.slice(3); // "Stb"を除去
      if (currentElementType === 'Node') {
        currentElementType = 'Node'; // 特別な場合
      }
    }
  }

  // --- 要素名行 ---
  rowsHtml += `<tr class="element-row" data-id="${rowId}"${
    parentId ? ` data-parent="${parentId}"` : ''
  }>`;
  let elementCell = `<td style="${indentStyle}">`;
  elementCell += `<span class="toggle-btn" data-target-id="${rowId}" style="margin-right:5px;display:inline-block;width:1em;text-align:center;font-weight:var(--font-weight-bold);cursor:pointer;color:#666;">-</span>`;
  elementCell += `<span class="tag-name">${escapeHtml(displayTagName)}</span>`;
  if (tagNameA && tagNameB && tagNameA !== tagNameB) {
    elementCell += ` <span style="color: red; font-size: var(--font-size-sm);">(A: ${escapeHtml(tagNameA)}, B: ${escapeHtml(tagNameB)})</span>`;
  }
  elementCell += '</td>';
  rowsHtml += elementCell;

  if (showSingleColumn) {
    rowsHtml += '<td></td>';
  } else {
    rowsHtml += '<td></td><td></td>';
  }
  rowsHtml += '</tr>';

  // --- 属性行（XSDスキーマ対応版） ---
  const attrsA = nodeA ? getAttributesMap(nodeA) : new Map();
  const attrsB = nodeB ? getAttributesMap(nodeB) : new Map();

  // XSDスキーマから完全な属性リストを取得
  const allAttrNames = new Set([...attrsA.keys(), ...attrsB.keys()]);

  // XSDスキーマが利用可能な場合、スキーマ定義の属性も追加
  if (isSchemaLoaded() && displayTagName) {
    const schemaAttributes = getAllAttributeNames(displayTagName);
    schemaAttributes.forEach((attr) => allAttrNames.add(attr));
  }

  const attrRowDisplay = '';
  const editMode = isEditMode();
  const currentEditingElement = getCurrentEditingElement();

  if (allAttrNames.size > 0) {
    const sortedAttrNames = Array.from(allAttrNames).sort((a, b) => {
      const prioritized = ['id', 'guid', 'name'];
      const idxA = prioritized.indexOf(a);
      const idxB = prioritized.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

    for (const attrName of sortedAttrNames) {
      const valueA = attrsA.get(attrName);
      const valueB = attrsB.get(attrName);

      // XSDスキーマから属性情報を取得
      const attrInfo = isSchemaLoaded() ? getAttributeInfo(displayTagName, attrName) : null;
      const isRequired = attrInfo?.required || false;
      const hasDefault = attrInfo?.default || attrInfo?.fixed;
      const documentation = attrInfo?.documentation;

      // 重要度インジケータ（属性名セルに丸で表示）
      // XML要素の階層構造から正確なパスを構築して重要度を参照する
      const xmlNode = nodeA || nodeB;
      const elementXPath = buildXPathFromXmlElement(xmlNode);
      const importanceCircle = elementXPath
        ? getImportanceCircleHtmlByPath(elementXPath + '/@' + attrName)
        : getImportanceCircleHtml(currentElementType, attrName);

      // 属性ラベルの構築（XSD丸 + S2丸 + S4丸 + 属性名 + デフォルト値）
      const xsdIndicator = `<span style="display:inline-block;width:1em;text-align:center;color:#D32F2F;font-size:var(--font-size-sm);line-height:1;opacity:${isRequired ? '1' : '0.65'};" title="${isRequired ? 'XSD: 必須' : 'XSD: 任意'}">${isRequired ? '&#9679;' : '&#9675;'}</span>`;
      let attrLabel = `${xsdIndicator}${importanceCircle} ${escapeHtml(attrName)}`;
      if (attrInfo && hasDefault)
        attrLabel += ` <span style="color:blue;font-size:var(--font-size-sm);" title="デフォルト値: ${escapeHtml(hasDefault)}">(${escapeHtml(hasDefault)})</span>`;

      const titleAttr = documentation ? ` title="${escapeHtml(documentation)}"` : '';
      const validationMetaA = getValidationCellMeta(attrName, attrValidationMapA);
      const validationMetaB = getValidationCellMeta(attrName, attrValidationMapB);

      if (showSingleColumn) {
        // 単一モデル表示の場合
        const singleValue = valueA ?? valueB;
        let displayValue = valueToSafeHtml(singleValue);
        const singleValidationMeta =
          valueA !== undefined || (nodeA && !nodeB) ? validationMetaA : validationMetaB;

        // 編集モードの場合、編集ボタンを追加（編集はモデルAの要素のみ）
        if (editMode && currentEditingElement) {
          // displayTagNameから実際の要素タイプを導出（断面ノードの場合はStbSecColumn_RC→SecColumn_RC）
          const currentEditType = displayTagName?.startsWith('Stb')
            ? displayTagName.slice(3)
            : currentEditingElement.elementType;
          displayValue += buildEditButtonHtml(nodeA, currentEditType, attrName, singleValue);
        }

        rowsHtml += `<tr data-parent="${rowId}"${attrRowDisplay}>`;
        rowsHtml += `<td style="${attrIndentStyle}"${titleAttr}><span class="attr-name">${attrLabel}</span></td>`;
        rowsHtml += `<td${buildCellClassAttr(singleValidationMeta.className)}${singleValidationMeta.titleAttr}>${displayValue}</td>`;
        rowsHtml += '</tr>';
      } else {
        // 比較表示の場合
        let displayValueA = valueToSafeHtml(valueA);
        const displayValueB = valueToSafeHtml(valueB);

        // 編集モードの場合、編集ボタンを追加（編集はモデルAの要素のみ。
        // B側に出すと documentA に誤適用されるため表示しない）
        if (editMode && currentEditingElement) {
          // displayTagNameから実際の要素タイプを導出（断面ノードの場合はStbSecColumn_RC→SecColumn_RC）
          const currentEditType = displayTagName?.startsWith('Stb')
            ? displayTagName.slice(3)
            : currentEditingElement.elementType;
          displayValueA += buildEditButtonHtml(nodeA, currentEditType, attrName, valueA);
        }

        // 比較結果: 値が異なる場合のみ黄色ハイライト
        const differs =
          nodeA &&
          nodeB &&
          valueA !== undefined &&
          valueB !== undefined &&
          comparableAttributeDiffers(attrName, valueA, valueB);
        const classAttrA = buildCellClassAttr(differs ? 'differs' : '', validationMetaA.className);
        const classAttrB = buildCellClassAttr(differs ? 'differs' : '', validationMetaB.className);

        rowsHtml += `<tr data-parent="${rowId}"${attrRowDisplay}>`;
        rowsHtml += `<td style="${attrIndentStyle}"${titleAttr}><span class="attr-name">${attrLabel}</span></td>`;
        rowsHtml += `<td${classAttrA}${validationMetaA.titleAttr}>${displayValueA}</td>`;
        rowsHtml += `<td${classAttrB}${validationMetaB.titleAttr}>${displayValueB}</td>`;
        rowsHtml += '</tr>';
      }

      // id_node属性の後にノード座標行を追加
      rowsHtml += renderNodeCoordinateRows(
        attrName,
        valueA,
        valueB,
        showSingleColumn,
        attrIndentStyle,
        rowId,
      );

      // shape属性の後に鉄骨断面ブロックを追加
      if (attrName === 'shape') {
        const childAttrIndent = attrIndentStyle.replace(
          /padding-left:\s*([\d.]+)em/,
          (_, val) => `padding-left: ${parseFloat(val) + 1.5}em`,
        );
        rowsHtml += renderSteelSectionBlock(
          valueA,
          valueB,
          showSingleColumn,
          attrIndentStyle,
          childAttrIndent,
          rowId,
        );
      }
    }
  }

  // --- StbOpenId要素の場合: 参照先の開口プロパティを表示 ---
  if (displayTagName === 'StbOpenId') {
    const openIdA = attrsA.get('id');
    const openIdB = attrsB.get('id');
    if (openIdA || openIdB) {
      const childAttrIndent = attrIndentStyle.replace(
        /padding-left:\s*([\d.]+)em/,
        (_, val) => `padding-left: ${parseFloat(val) + 1.5}em`,
      );
      rowsHtml += renderOpeningPropertiesBlock(
        openIdA,
        openIdB,
        showSingleColumn,
        attrIndentStyle,
        childAttrIndent,
        rowId,
      );
    }
  }

  // --- テキストコンテンツを表示する行 ---
  const textA = nodeA?.textContent?.trim();
  const textB = nodeB?.textContent?.trim();
  const hasMeaningfulTextA = hasMeaningfulNodeText(nodeA, textA);
  const hasMeaningfulTextB = hasMeaningfulNodeText(nodeB, textB);
  const textRowDisplay = '';
  if (hasMeaningfulTextA || hasMeaningfulTextB) {
    if (showSingleColumn) {
      // 単一モデル表示の場合
      const singleText = hasMeaningfulTextA ? textA : hasMeaningfulTextB ? textB : '';
      const displayText = singleText ? escapeHtml(singleText) : '<span class="no-value">-</span>';

      rowsHtml += `<tr data-parent="${rowId}"${textRowDisplay}>`;
      rowsHtml += `<td style="${attrIndentStyle}"><span class="text-label">(内容)</span></td>`;
      rowsHtml += `<td><span class="text-content">${displayText}</span></td>`;
      rowsHtml += '</tr>';
    } else {
      // 比較表示の場合（従来通り）
      const displayTextA = hasMeaningfulTextA
        ? escapeHtml(textA)
        : '<span class="no-value">-</span>';
      const displayTextB = hasMeaningfulTextB
        ? escapeHtml(textB)
        : '<span class="no-value">-</span>';
      const differs = nodeA && nodeB && hasMeaningfulTextA && hasMeaningfulTextB && textA !== textB;
      const highlightClass = differs ? ' class="differs"' : '';

      rowsHtml += `<tr data-parent="${rowId}"${textRowDisplay}>`;
      rowsHtml += `<td style="${attrIndentStyle}"><span class="text-label">(内容)</span></td>`;
      rowsHtml += `<td${highlightClass}><span class="text-content">${displayTextA}</span></td>`;
      rowsHtml += `<td${highlightClass}><span class="text-content">${displayTextB}</span></td>`;
      rowsHtml += '</tr>';
    }

    // ノードIDリストの座標展開（単一表示・比較表示で共通）
    rowsHtml += renderNodeIdListCoordinateRows(
      displayTagName,
      hasMeaningfulTextA ? textA : null,
      hasMeaningfulTextB ? textB : null,
      showSingleColumn,
      attrIndentStyle,
      rowId,
    );
  }

  // --- 子要素の行を再帰的に生成して追加 ---
  const childrenA = nodeA?.children ? Array.from(nodeA.children) : [];
  const childrenB = nodeB?.children ? Array.from(nodeB.children) : [];
  const childValidationContext = {
    idA: effectiveValidationIdA,
    idB: effectiveValidationIdB,
  };

  // 子要素の再帰描画（第3引数以降は全呼び出しで共通。null は自動判定させるため）
  const renderChild = (childA, childB) =>
    renderComparisonRecursive(
      childA,
      childB,
      level + 1,
      rowId,
      showSingleColumn,
      modelSource,
      null,
      childValidationContext,
    );

  // タグ名が異なる場合は別々に表示（通常は発生しないはず）
  const renderChildPair = (childA, childB) =>
    childA && childB && childA.tagName !== childB.tagName
      ? renderChild(childA, null) + renderChild(null, childB)
      : renderChild(childA, childB);

  // pos属性によるマッチングが必要かどうかを判定
  if (shouldUsePosMatching(childrenA, childrenB)) {
    // pos属性でマッチングして比較
    const matchedPairs = matchChildrenByPos(childrenA, childrenB);

    for (const { childA, childB } of matchedPairs) {
      rowsHtml += renderChildPair(childA, childB);
    }
  } else {
    // 従来のインデックスベースの比較
    const maxLen = Math.max(childrenA.length, childrenB.length);

    for (let i = 0; i < maxLen; i++) {
      rowsHtml += renderChildPair(childrenA[i] ?? null, childrenB[i] ?? null);
    }
  }

  return rowsHtml;
}

/**
 * 折りたたみイベントハンドラを設定
 * @param {HTMLElement} tbody - テーブルボディ要素
 */
export function setupCollapseHandlers(tbody) {
  if (!tbody) return;

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    const targetId = btn.dataset.targetId;
    if (!targetId) return;
    const rows = tbody.querySelectorAll(`tr[data-parent='${targetId}']`);
    const expanded = btn.textContent === '-';
    btn.textContent = expanded ? '+' : '-';
    rows.forEach((row) => {
      row.style.display = expanded ? 'none' : '';
      // 折りたたむときは子孫も再帰的に閉じる
      if (expanded) {
        const childBtn = row.querySelector('.toggle-btn');
        if (childBtn && childBtn.textContent === '-') {
          childBtn.textContent = '+';
          const childId = childBtn.dataset.targetId;
          const childRows = tbody.querySelectorAll(`tr[data-parent='${childId}']`);
          childRows.forEach((r) => (r.style.display = 'none'));
        }
      }
    });
  });
}
