/**
 * @fileoverview 断面情報ヘルパー関数
 *
 * STB断面情報の検索、抽出、および等価性評価結果の表示を行うヘルパー関数群。
 * 断面ノードの検索、鉄骨断面寸法の取得、断面データの抽出などを担当します。
 */

import { getState } from '../../../data/state/globalState.js';
import { SECTION_CONFIG } from '../../../common-stb/import/config/sectionConfig.js';
import { extractAllSections } from '../../../common-stb/import/extractor/sectionExtractor.js';
import { escapeHtml } from '../../../utils/htmlUtils.js';

const SECTION_LOOKUP_ALIASES = {
  FrameDampingDevice: 'DampingDevice',
  ShearWall: 'Wall',
};

// 梁/大梁のみ GSS（形状等価）対象。elementType → extractAllSections の断面マップキー。
const GEOMETRY_SECTION_MAP_KEY = {
  Girder: 'girderSections',
  Beam: 'beamSections',
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
 * 梁/大梁の断面 id からカーネル抽出済みの断面データ（shapeStations 等を含む）を取得する。
 * GSS（形状等価）判定・記述に用いる。対象外要素や未取得なら null。
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
export function findSteelSectionInfo(shapeName) {
  const docA = getState('models.documentA');
  const docB = getState('models.documentB');
  if (!docA && !docB) return null;

  // どちらかのdocからStbSecSteelを取得
  const doc = docA || docB;
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
export function extractSectionData(sectionNode) {
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

  // 材質と強度情報を抽出
  data.material = data.strength_name || data.material;

  // shapeName属性からの断面寸法取得
  if (data.shape) {
    const steelInfo = findSteelSectionInfo(data.shape);
    if (steelInfo) {
      Object.assign(data, steelInfo);
    }
  }

  // セクション種別に応じた正規化
  // StbSecColumn-S, StbSecBeam-S, StbSecColumn-RC, StbSecBeam-RC などのタグ名に対応
  if (data.type) {
    // タグ名から断面タイプを抽出
    if (data.type.includes('-S')) {
      data.section_type = data.type; // 鋼材断面
    } else if (
      data.type.includes('-RC') ||
      data.type.includes('-SRC') ||
      data.type.includes('-CFT')
    ) {
      data.section_type = 'RECTANGLE'; // RC断面はデフォルトで矩形
    }
  }

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
            <span style="margin-left: 10px; color: #666; font-size: var(--font-size-sm);">${result.summary} (${result.passRate}%)</span>
          </div>
        </div>
        <div style="margin-top: 4px; color: #555; font-size: var(--font-size-sm);">概略属性の判定基準: <strong>断面種別・寸法・材質・強度</strong></div>
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
          ${check.category}
        </td>
        <td colspan="2" style="font-size: var(--font-size-sm); color: #555;">
          ${check.name}: ${check.details}
        </td>
      </tr>
    `;

    // サブチェックがある場合
    if (check.subChecks && check.subChecks.length > 0) {
      for (const subCheck of check.subChecks) {
        const subIcon = subCheck.passed ? '✓' : '✗';
        const subColor = subCheck.passed ? '#28a745' : '#dc3545';

        html += `
          <tr class="equivalence-subcheck-row">
            <td style="padding-left: 4em; font-size: var(--font-size-sm); color: #666;">
              <span style="color: ${subColor}; margin-right: 3px;">${subIcon}</span>
              ${subCheck.name}
            </td>
            <td colspan="2" style="font-size: var(--font-size-sm); color: #666;">
              ${subCheck.details}
            </td>
          </tr>
        `;
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
      data.sectionData = extractSectionData(sectionNode);
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
