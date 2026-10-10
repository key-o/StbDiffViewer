/**
 * @fileoverview 断面情報ヘルパー関数
 *
 * STB断面情報の検索、抽出、および等価性評価結果の表示を行うヘルパー関数群。
 * 断面ノードの検索、鉄骨断面寸法の取得、断面データの抽出などを担当します。
 */

import { getState } from '../../../data/state/globalState.js';
import editDocumentProvider from '../../../app/editing/editDocumentProvider.js';
import { SECTION_CONFIG } from '../../../common-stb/import/config/sectionConfig.js';
import { extractAllSections } from '../../../common-stb/import/extractor/sectionExtractor.js';
import { resolveMemberConcreteStrength } from '../../../data/extractors/concreteStrengthResolver.js';
import { buildBeamReinforcementEquivalenceData } from '../../../common-stb/comparison/beamReinforcementEquivalence.js';
import { escapeHtml } from '../../../utils/htmlUtils.js';

const SECTION_LOOKUP_ALIASES = {
  FrameDampingDevice: 'DampingDevice',
};

// elementType → extractAllSections の断面マップキー。
const GEOMETRY_SECTION_MAP_KEY = {
  Column: 'columnSections',
  Post: 'postSections',
  Girder: 'girderSections',
  Beam: 'beamSections',
  Brace: 'braceSections',
  Pile: 'pileSections',
  Footing: 'footingSections',
  FoundationColumn: 'foundationColumnSections',
  Slab: 'slabSections',
  Wall: 'wallSections',
  Parapet: 'parapetSections',
  Undefined: 'undefinedSections',
  IsolatingDevice: 'isolatingDeviceSections',
  DampingDevice: 'dampingDeviceSections',
};

// ドキュメント単位の断面抽出キャッシュ（選択の都度の全断面抽出を回避）。
const extractedSectionsCache = new WeakMap();

function getExtractedSections(doc) {
  if (!doc) return null;
  if (extractedSectionsCache.has(doc)) return extractedSectionsCache.get(doc);
  let maps = null;
  try {
    maps = extractAllSections(doc);
  } catch {
    maps = null;
  }
  extractedSectionsCache.set(doc, maps);
  return maps;
}

/**
 * 断面 id から統一カーネル抽出済みの断面データ（dimensions / shapeStations 等を含む）を取得する。
 * 梁・大梁のGSS判定に加え、概略属性比較の寸法正規化にも利用する。
 *
 * @param {XMLDocument|null} doc
 * @param {string|number} sectionId
 * @param {string} elementType
 * @returns {Object|null}
 */
export function getGeometrySectionData(doc, sectionId, elementType) {
  const mapKey = GEOMETRY_SECTION_MAP_KEY[elementType];
  if (!mapKey || sectionId == null) return null;
  const maps = getExtractedSections(doc);
  const map = maps?.[mapKey];
  if (!(map instanceof Map)) return null;
  const numeric = Number(sectionId);
  return (
    (Number.isFinite(numeric) ? map.get(numeric) : null) ??
    map.get(String(sectionId)) ??
    map.get(sectionId) ??
    null
  );
}

function getLookupElementType(elementType) {
  if (!elementType) {
    return null;
  }

  return SECTION_LOOKUP_ALIASES[elementType] || elementType;
}

function scanTagFromDocument(doc) {
  return (tagName) => {
    if (!doc || !tagName) return [];
    const nodes = doc.getElementsByTagName?.(tagName);
    return nodes ? Array.from(nodes) : [];
  };
}

function getOrderedNodeIds(memberNode) {
  const order = memberNode?.querySelector?.('StbNodeIdOrder')?.textContent?.trim();
  if (!order) return [];
  return order.split(/\s+/).filter(Boolean);
}

function getConcreteStoryNodeId(memberNode, elementType) {
  if (!memberNode) return null;

  switch (elementType) {
    case 'Column':
    case 'Post':
      return memberNode.getAttribute('id_node_top');
    case 'Girder':
    case 'Beam':
      return memberNode.getAttribute('id_node_start');
    case 'Slab': {
      const ids = getOrderedNodeIds(memberNode);
      return ids[0] || null;
    }
    case 'Wall': {
      const ids = getOrderedNodeIds(memberNode);
      return ids.at(-1) || null;
    }
    case 'Footing':
    case 'FoundationColumn':
      return memberNode.getAttribute('id_node') || memberNode.getAttribute('id_node_start');
    case 'Parapet':
      return memberNode.getAttribute('id_node_start');
    default:
      return null;
  }
}

function resolveConcreteStrengthForComparison(
  sectionNode,
  memberNode,
  elementType,
  sectionStrength,
) {
  if (!sectionNode?.ownerDocument || !memberNode) return sectionStrength || null;

  const result = resolveMemberConcreteStrength({
    scanTag: scanTagFromDocument(sectionNode.ownerDocument),
    memberEl: memberNode,
    sectionStrength: sectionStrength || null,
    storyNodeId: getConcreteStoryNodeId(memberNode, elementType),
  });
  return result.value || sectionStrength || null;
}

/**
 * 指定されたドキュメントの StbSections 内から、指定IDを持つ断面要素を検索する。
 * @param {XMLDocument | null} doc - 検索対象のXMLドキュメント。
 * @param {string} sectionId - 検索する断面ID。
 * @returns {Element | null} 見つかった断面要素、または null。
 */
export function findSectionNode(doc, sectionId, elementType = null) {
  if (!doc || !sectionId) {
    return null;
  }

  const sectionsRoot = doc.querySelector('StbSections');
  if (!sectionsRoot) {
    return null;
  }

  const sectionElements = Array.from(sectionsRoot.children || []);
  const lookupElementType = getLookupElementType(elementType);
  const selectors = lookupElementType ? SECTION_CONFIG[lookupElementType]?.selectors : null;

  if (selectors?.length) {
    const matchedSection = sectionElements.find(
      (element) => selectors.includes(element.tagName) && element.getAttribute('id') === sectionId,
    );
    if (matchedSection) {
      return matchedSection;
    }
  }

  return sectionElements.find((element) => element.getAttribute('id') === sectionId) || null;
}

/**
 * S造断面寸法をStbSecSteelから引き当てる関数
 * @param {string} shapeName - 断面形状名
 * @returns {Object | null} 断面寸法情報、または null
 */
export function findSteelSectionInfo(shapeName, document = null) {
  const docA = editDocumentProvider.getActiveEditDocument();
  const docB = getState('models.documentB');
  if (!document && !docA && !docB) return null;

  // 呼び出し元の断面ノードが属する document を優先し、A/B を混同しない。
  const doc = document || docA || docB;
  if (!doc) return null;
  const steel = doc.querySelector('StbSecSteel');
  if (!steel) return null;

  // H形鋼
  let el = steel.querySelector(`StbSecRoll-H[name="${shapeName}"]`);
  if (el) {
    return {
      type: 'H',
      A: el.getAttribute('A'),
      B: el.getAttribute('B'),
      t1: el.getAttribute('t1'),
      t2: el.getAttribute('t2'),
      r: el.getAttribute('r'),
    };
  }

  // 角形鋼管
  el = steel.querySelector(`StbSecRoll-BOX[name="${shapeName}"]`);
  if (el) {
    return {
      type: 'BOX',
      A: el.getAttribute('A'),
      B: el.getAttribute('B'),
      t: el.getAttribute('t'),
      r: el.getAttribute('r'),
    };
  }

  // L形鋼
  el = steel.querySelector(`StbSecRoll-L[name="${shapeName}"]`);
  if (el) {
    return {
      type: 'L',
      A: el.getAttribute('A'),
      B: el.getAttribute('B'),
      t1: el.getAttribute('t1'),
      t2: el.getAttribute('t2'),
      r1: el.getAttribute('r1'),
      r2: el.getAttribute('r2'),
    };
  }

  // その他必要に応じて追加
  return null;
}

/**
 * XMLノードから断面データを抽出
 * @param {Element} sectionNode - 断面XML要素
 * @returns {Object|null} 抽出された断面データ
 */
export function extractSectionData(sectionNode, elementType = null, memberNode = null) {
  if (!sectionNode) return null;

  const data = {
    type: sectionNode.tagName,
    material: null,
    strength_name: null,
  };

  // 全属性を取得
  Array.from(sectionNode.attributes).forEach((attr) => {
    data[attr.name] = attr.value;
  });

  // 統一断面抽出カーネルが既に保持している正規化寸法・断面タイプを再利用する。
  // RC梁の width/depth が子要素にあるケースもここで比較対象へ入る。
  const kernelSectionData = getGeometrySectionData(
    sectionNode.ownerDocument,
    sectionNode.getAttribute('id'),
    elementType,
  );
  if (kernelSectionData?.dimensions) {
    data.dimensions = { ...kernelSectionData.dimensions };
  }
  if (kernelSectionData?.section_type) {
    data.section_type = kernelSectionData.section_type;
  }

  const hasSteelComponent = /_(?:S|SRC|CFT)$/.test(sectionNode.tagName);

  // S/SRC/CFT 断面では shape / 鋼種が断面ルートではなく StbSecSteel* 子孫にある。
  // RC配筋の strength_main（SD345等）を鋼材強度と誤認しないよう、鉄骨系断面に限定する。
  if (hasSteelComponent) {
    const descendantAttributeNames = ['shape', 'strength_main', 'strength_web', 'strength'];
    for (const attrName of descendantAttributeNames) {
      if (data[attrName]) continue;
      const carrier = sectionNode.querySelector?.(`[${attrName}]`);
      const value = carrier?.getAttribute?.(attrName);
      if (value) data[attrName] = value;
    }

    // strength_web は ST-Bridge 仕様上、省略時は strength_main と同一として扱う。
    if (data.strength_main && !data.strength_web) {
      data.strength_web = data.strength_main;
    }
  }

  // RC系のコンクリート強度は、部材→断面→階→StbCommon の仕様上の優先順位で解決する。
  const isPureRcSection = /_RC$/.test(sectionNode.tagName);
  const isConcreteCompositeSection = /_(?:SRC|CFT)$/.test(sectionNode.tagName);
  if (isPureRcSection || isConcreteCompositeSection) {
    const effectiveConcreteStrength = resolveConcreteStrengthForComparison(
      sectionNode,
      memberNode,
      elementType,
      data.strength_concrete || kernelSectionData?.strength_concrete || null,
    );
    if (effectiveConcreteStrength) {
      data.strength_concrete = effectiveConcreteStrength;
    }
  }

  // shape 属性から StbSecSteel の定義を引き、寸法と実断面タイプを補完する。
  if (data.shape) {
    const steelInfo = findSteelSectionInfo(data.shape, sectionNode.ownerDocument);
    if (steelInfo) {
      const { type: steelType, ...steelDimensions } = steelInfo;
      Object.assign(data, steelDimensions);
      if (sectionNode.tagName.endsWith('_S')) {
        data.section_type = steelType;
      }
    }
  }

  // セクション種別に応じた正規化。
  // 実断面タイプが取得できない場合のみ、親要素タグからフォールバックする。
  if (!data.section_type && data.type) {
    if (data.type.endsWith('_S')) {
      data.section_type = data.type;
    } else if (data.type.endsWith('_SRC')) {
      data.section_type = 'SRC';
    } else if (data.type.endsWith('_CFT')) {
      data.section_type = 'CFT';
    } else if (data.type.endsWith('_RC')) {
      data.section_type = 'RECTANGLE';
    }
  }

  // 概略属性比較の代表トークン。
  // 純RCではコンクリート強度を用い、鉄骨系では鋼種を優先する。
  data.material = isPureRcSection
    ? data.strength_concrete || null
    : data.strength_name || data.strength_main || data.strength || data.strength_concrete || null;

  // RC梁配筋は Same / ThreeTypes / StartEnd / 2.1 Simple/Complex の記述差を
  // 既存抽出器で正規化してから比較する。
  data.reinforcement = buildBeamReinforcementEquivalenceData(sectionNode);

  return data;
}

/**
 * 選択中の断面対応付け基準を示す小行を生成する（F1: 表示を設定に追従）。
 * criterionLabel が無い場合は空文字（Phase 1 の後方互換）。
 * @param {string|null} criterionLabel - 断面一致基準の表示名
 * @returns {string} HTML（テーブルセル内の div 行）
 */
function renderSelectedCriterionLine(criterionLabel) {
  if (!criterionLabel) return '';
  return `<div style="margin-top: 2px; color: #777; font-size: var(--font-size-sm);">断面の対応付け基準（設定）: <strong>${escapeHtml(
    criterionLabel,
  )}</strong></div>`;
}

/**
 * 形状等価（GSS）判定のHTML生成（テーブル行形式）。
 * 差分一覧の分類根拠と一致する「作成されるジオメトリ立体形状」で等価かを表示する。
 * 材質・強度・鉄筋などの非形状属性は等価判定に含めない（断面情報の各行で確認できる）。
 *
 * @param {Object} geom - {equivalent, descA, descB, signatureA, signatureB}
 * @param {string|null} [criterionLabel] - 選択中の断面一致基準の表示名（F1: 表示を設定に追従）
 * @returns {string} テーブル行のHTML
 */
export function generateGeometryEquivalenceSection(geom, criterionLabel = null) {
  const statusColor = geom.equivalent ? '#28a745' : '#dc3545';
  const statusText = geom.equivalent ? '✓ 形状等価' : '✗ 形状非等価';
  const statusBg = geom.equivalent ? 'rgba(40, 167, 69, 0.1)' : 'rgba(220, 53, 69, 0.1)';
  const note = geom.equivalent
    ? '作成されるジオメトリ立体が同一（Straight/Haunch/Taper 等の記述差・材質・強度・鉄筋は除く）'
    : '断面形状が異なります';

  let html = `
    <tr class="equivalence-status-row">
      <td colspan="3" style="background-color: ${statusBg}; padding: 8px; border-left: 4px solid ${statusColor};">
        <div>
          <strong style="color: ${statusColor}; font-size: var(--font-size-lg);">${statusText}</strong>
          <span style="margin-left: 10px; color: #666; font-size: var(--font-size-sm);">${note}</span>
        </div>
        <div style="margin-top: 4px; color: #555; font-size: var(--font-size-sm);">断面判定基準: <strong>形状（GSS）</strong></div>
        ${renderSelectedCriterionLine(criterionLabel)}
      </td>
    </tr>
  `;

  const descA = geom.descA != null ? escapeHtml(geom.descA) : '—';
  const descB = geom.descB != null ? escapeHtml(geom.descB) : '—';
  html += `
    <tr class="equivalence-check-row">
      <td style="padding-left: 2em; font-weight: var(--font-weight-bold);">断面形状</td>
      <td style="font-size: var(--font-size-sm); color: #555;">${descA}</td>
      <td style="font-size: var(--font-size-sm); color: #555;">${descB}</td>
    </tr>
  `;

  return html;
}

/**
 * 等価性評価結果のHTML生成（テーブル行形式）
 * @param {Object} result - 評価結果オブジェクト
 * @param {string|null} [criterionLabel] - 選択中の断面一致基準の表示名（F1: 表示を設定に追従）
 * @returns {string} テーブル行のHTML
 */
function renderEquivalenceText(value) {
  return escapeHtml(value ?? '').replace(/\n/g, '<br>');
}

export function generateEquivalenceSection(result, criterionLabel = null) {
  const statusColor = result.isEquivalent ? '#28a745' : '#dc3545';
  const statusText = result.isEquivalent ? '✓ 概略属性等価' : '✗ 概略属性非等価';
  const statusBg = result.isEquivalent ? 'rgba(40, 167, 69, 0.1)' : 'rgba(220, 53, 69, 0.1)';

  let html = `
    <tr class="equivalence-status-row">
      <td colspan="3" style="background-color: ${statusBg}; padding: 8px; border-left: 4px solid ${statusColor};">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div>
            <strong style="color: ${statusColor}; font-size: var(--font-size-lg);">${statusText}</strong>
            <span style="margin-left: 10px; color: #666; font-size: var(--font-size-sm);">${renderEquivalenceText(result.summary)} (${renderEquivalenceText(result.passRate)}%)</span>
          </div>
        </div>
        <div style="margin-top: 4px; color: #555; font-size: var(--font-size-sm);">概略属性の判定基準: <strong>断面種別・寸法・材質・強度・配筋</strong></div>
        <div style="color: #777; font-size: var(--font-size-sm);">全構成属性の差分は下の比較表に表示します</div>
        ${renderSelectedCriterionLine(criterionLabel)}
      </td>
    </tr>
  `;

  // チェック結果の詳細
  for (const check of result.checks) {
    const icon = check.passed ? '✓' : '✗';
    const iconColor = check.passed ? '#28a745' : '#dc3545';
    const rowBg = check.passed ? 'rgba(40, 167, 69, 0.05)' : 'rgba(220, 53, 69, 0.05)';

    html += `
      <tr class="equivalence-check-row" style="background-color: ${rowBg};">
        <td style="padding-left: 2em; font-weight: var(--font-weight-bold);">
          <span style="color: ${iconColor}; margin-right: 5px;">${icon}</span>
          ${renderEquivalenceText(check.category)}
        </td>
        <td colspan="2" style="font-size: var(--font-size-sm); color: #555;">
          ${renderEquivalenceText(check.name)}: ${renderEquivalenceText(check.details)}
        </td>
      </tr>
    `;

    // サブチェックがある場合
    if (check.subChecks && check.subChecks.length > 0) {
      for (const subCheck of check.subChecks) {
        const subIcon = subCheck.passed ? '✓' : '✗';
        const subColor = subCheck.passed ? '#28a745' : '#dc3545';

        const hasSeparateValues =
          Object.prototype.hasOwnProperty.call(subCheck, 'valueA') ||
          Object.prototype.hasOwnProperty.call(subCheck, 'valueB');

        if (hasSeparateValues) {
          html += `
            <tr class="equivalence-subcheck-row">
              <td style="padding-left: 4em; font-size: var(--font-size-sm); color: #666; vertical-align: top;">
                <span style="color: ${subColor}; margin-right: 3px;">${subIcon}</span>
                ${renderEquivalenceText(subCheck.name)}
              </td>
              <td style="font-size: var(--font-size-sm); color: #666; vertical-align: top; line-height: 1.5;">
                ${renderEquivalenceText(subCheck.valueA ?? 'なし')}
              </td>
              <td style="font-size: var(--font-size-sm); color: #666; vertical-align: top; line-height: 1.5;">
                ${renderEquivalenceText(subCheck.valueB ?? 'なし')}
              </td>
            </tr>
          `;
        } else {
          html += `
            <tr class="equivalence-subcheck-row">
              <td style="padding-left: 4em; font-size: var(--font-size-sm); color: #666;">
                <span style="color: ${subColor}; margin-right: 3px;">${subIcon}</span>
                ${renderEquivalenceText(subCheck.name)}
              </td>
              <td colspan="2" style="font-size: var(--font-size-sm); color: #666;">
                ${renderEquivalenceText(subCheck.details)}
              </td>
            </tr>
          `;
        }
      }
    }
  }

  return html;
}

/**
 * 要素データからラベル表示用のデータを構築
 * @param {string} elementType - 要素タイプ
 * @param {Element} elementNode - XML要素ノード
 * @param {XMLDocument} doc - XMLドキュメント
 * @returns {Object|null} ラベル表示用のデータ
 */
export function buildElementDataForLabels(elementType, elementNode, doc) {
  if (!elementNode) {
    return null;
  }

  const data = {};
  Array.from(elementNode.attributes).forEach((attr) => {
    data[attr.name] = attr.value;
  });

  data.id = data.id || elementNode.getAttribute('id') || elementNode.getAttribute('name') || '';
  data.elementType = elementType;

  const sectionId = elementNode.getAttribute('id_section');
  if (doc && sectionId) {
    const sectionNode = findSectionNode(doc, sectionId, elementType);
    if (sectionNode) {
      data.sectionData = extractSectionData(sectionNode, elementType, elementNode);
    }
  }

  return data;
}

/**
 * 要素の属性をMap形式で取得するヘルパー関数
 * @param {Element} node - XML要素ノード
 * @returns {Map<string, string>} 属性名と値のマップ
 */
export function getAttributesMap(node) {
  const map = new Map();
  if (node && node.attributes) {
    for (let i = 0; i < node.attributes.length; i++) {
      map.set(node.attributes[i].name, node.attributes[i].value);
    }
  }
  return map;
}

/**
 * shape属性を持つ鉄骨断面情報をHTML形式でレンダリング
 * @param {string} shape - 断面形状名
 * @returns {string} HTML文字列
 */
export function renderShapeWithSteelInfo(shape) {
  if (!shape) return '';
  const steelInfo = findSteelSectionInfo(shape);
  if (!steelInfo) return `<span>${shape}</span>`;

  if (steelInfo.type === 'H') {
    return `<span>${shape} <span style="color:#888;font-size:var(--font-size-sm);">[A=${steelInfo.A}, B=${steelInfo.B}, t1=${steelInfo.t1}, t2=${steelInfo.t2}, r=${steelInfo.r}]</span></span>`;
  }
  if (steelInfo.type === 'BOX') {
    return `<span>${shape} <span style="color:#888;font-size:var(--font-size-sm);">[A=${steelInfo.A}, B=${steelInfo.B}, t=${steelInfo.t}, r=${steelInfo.r}]</span></span>`;
  }
  if (steelInfo.type === 'L') {
    return `<span>${shape} <span style="color:#888;font-size:var(--font-size-sm);">[A=${steelInfo.A}, B=${steelInfo.B}, t1=${steelInfo.t1}, t2=${steelInfo.t2}, r1=${steelInfo.r1}, r2=${steelInfo.r2}]</span></span>`;
  }
  return `<span>${shape}</span>`;
}
