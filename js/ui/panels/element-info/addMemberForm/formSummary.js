/**
 * @fileoverview 新規部材追加フォームの入力値収集・検証コンテキスト構築・確認サマリ描画
 *
 * フォームから属性値を集め、addMemberValidation によるライブ検証を実行し、
 * 確認サマリ（説明文＋エラー/警告）を描画する。
 *
 * @module ui/panels/element-info/addMemberForm/formSummary
 */

import editDocumentProvider from '../../../../app/editing/editDocumentProvider.js';
import { validateNewMember, validateNodeLink } from '../addMemberValidation.js';
import { getNewMemberDefinitions } from '../editMode/index.js';
import { PANEL_MEMBER_TYPES, POINT_MEMBER_TYPES } from '../memberCategories.js';
import {
  isSchemaLoaded,
  getAttributeInfo,
  validateAttributeValue,
} from '../../../../common-stb/import/parser/jsonSchemaLoader.js';
import { NODELIST_TYPES, TYPE_LABELS, VALIDATION_TAG_OVERRIDES } from './fieldDefs.js';
import { formState } from './formState.js';

/**
 * 紐づけ先要素に既に登録済みの節点IDを取得する（重複追加の警告に使用）。
 * @param {string} elementType
 * @param {string} targetId
 * @returns {string[]}
 */
export function getLinkedNodeIds(elementType, targetId) {
  const tagName = VALIDATION_TAG_OVERRIDES[elementType] || `Stb${elementType}`;
  const doc = editDocumentProvider.getActiveEditDocument();
  if (!targetId || !doc) return [];
  const el = doc.querySelector(`${tagName}[id="${String(targetId).replace(/"/g, '\\"')}"]`);
  if (!el) return [];
  return Array.from(el.getElementsByTagName('StbNodeId'))
    .map((n) => n.getAttribute('id'))
    .filter(Boolean);
}

/**
 * フォームから属性値を収集する。面材は node_ids（節点列の配列）を併せて返す。
 * @param {HTMLElement} fieldsContainer
 * @param {string} elementType
 * @returns {Object<string, string|string[]>}
 */
export function collectAttrs(fieldsContainer, elementType) {
  const attrs = {};
  for (const control of fieldsContainer.querySelectorAll('[data-attr]')) {
    attrs[control.dataset.attr] = control.value;
  }
  if (PANEL_MEMBER_TYPES.has(elementType) || NODELIST_TYPES.has(elementType)) {
    attrs.node_ids = [...formState.panelNodeIds];
  }
  return attrs;
}

/**
 * 入力タイプに応じた検証コンテキストを構築する。
 * @param {string} elementType
 * @returns {Object} validateNewMember 用 ctx
 */
export function buildValidationContext(elementType) {
  const tagName = VALIDATION_TAG_OVERRIDES[elementType] || `Stb${elementType}`;
  const validateAttr = (attr, value) => {
    // スキーマ未読込・未定義属性は警告対象外（ノイズ回避）
    if (!isSchemaLoaded() || !getAttributeInfo(tagName, attr)) return { valid: true };
    return validateAttributeValue(tagName, attr, value);
  };
  return {
    definition: getNewMemberDefinitions()[elementType],
    nodeIds: formState.cachedNodeIds,
    sectionIds: formState.cachedSections.map((s) => s.id),
    validateAttr,
  };
}

/**
 * attrs から節点参照属性（id_node*）の値を入力順に取り出す。
 * @param {Object<string,string>} attrs
 * @returns {string[]}
 */
export function nodeRefValues(attrs) {
  return Object.entries(attrs)
    .filter(([k]) => k.startsWith('id_node'))
    .map(([, v]) => v);
}

/**
 * 確認サマリ用の説明文を組み立てる（タイプ非依存）。
 * @param {string} elementType
 * @param {Object<string,string>} attrs
 * @returns {string}
 */
function describeMember(elementType, attrs) {
  const label = TYPE_LABELS[elementType] || elementType;
  if (elementType === 'Node') {
    return `${label}: (${attrs.X ?? ''}, ${attrs.Y ?? ''}, ${attrs.Z ?? ''})`;
  }
  if (elementType === 'Story') {
    const ids = Array.isArray(attrs.node_ids) ? attrs.node_ids : [];
    const linked = ids.length > 0 ? ` / 紐づけ節点 ${ids.length}点` : '';
    return `${label}: ${attrs.name || '(名称なし)'} / 高さ ${attrs.height ?? '-'}mm / 種別 ${attrs.kind || 'GENERAL'}${linked}`;
  }
  if (elementType === 'Axis') {
    const ids = Array.isArray(attrs.node_ids) ? attrs.node_ids : [];
    const linked = ids.length > 0 ? ` / 紐づけ節点 ${ids.length}点` : '';
    return `${label}: ${attrs.group || 'X'}軸 ${attrs.name || '(名称なし)'} / 距離 ${attrs.distance ?? '-'}mm${linked}`;
  }
  if (elementType === 'ArcAxis') {
    const ids = Array.isArray(attrs.node_ids) ? attrs.node_ids : [];
    const linked = ids.length > 0 ? ` / 紐づけ節点 ${ids.length}点` : '';
    return `${label}: ${attrs.group || ''} ${attrs.name || '(名称なし)'} / 半径 ${attrs.radius ?? '-'}mm / 中心(${attrs.center_x ?? 0}, ${attrs.center_y ?? 0})${linked}`;
  }
  if (elementType === 'RadialAxis') {
    const ids = Array.isArray(attrs.node_ids) ? attrs.node_ids : [];
    const linked = ids.length > 0 ? ` / 紐づけ節点 ${ids.length}点` : '';
    return `${label}: ${attrs.group || ''} ${attrs.name || '(名称なし)'} / 角度 ${attrs.angle ?? '-'}° / 中心(${attrs.center_x ?? 0}, ${attrs.center_y ?? 0})${linked}`;
  }
  if (PANEL_MEMBER_TYPES.has(elementType)) {
    const ids = Array.isArray(attrs.node_ids) ? attrs.node_ids : [];
    const struct = attrs.kind_structure ? ` / 構造 ${attrs.kind_structure}` : '';
    return `${label}: 節点[${ids.join(', ')}] (${ids.length}点) / 断面#${attrs.id_section || '-'}${struct}`;
  }
  if (POINT_MEMBER_TYPES.has(elementType)) {
    const node = `節点#${attrs.id_node || '-'}`;
    if (elementType === 'FoundationColumn') {
      const wr = attrs.id_section_WR ? ` / 立上り断面#${attrs.id_section_WR}` : '';
      return `${label}: ${node} / 基礎断面#${attrs.id_section_FD || '-'}${wr} / 構造 ${attrs.kind_structure || 'RC'}`;
    }
    const struct = attrs.kind_structure ? ` / 構造 ${attrs.kind_structure}` : '';
    return `${label}: ${node} / 断面#${attrs.id_section || '-'}${struct}`;
  }
  // 線材: 上下端（柱・間柱）か始終端（大梁・小梁・ブレース）かを属性で判別
  const endpoints =
    'id_node_bottom' in attrs || 'id_node_top' in attrs
      ? `下端#${attrs.id_node_bottom || '-'} → 上端#${attrs.id_node_top || '-'}`
      : `始端#${attrs.id_node_start || '-'} → 終端#${attrs.id_node_end || '-'}`;
  const struct = attrs.kind_structure ? ` / 構造 ${attrs.kind_structure}` : '';
  const rot = attrs.rotate !== undefined ? ` / 回転 ${attrs.rotate || '0'}°` : '';
  return `${label}: ${endpoints} / 断面#${attrs.id_section || '-'}${struct}${rot}`;
}

/**
 * 確認サマリ＋検証結果を描画し、検証結果を返す。
 * @param {HTMLElement} summaryEl
 * @param {string} elementType
 * @param {Object<string,string>} attrs
 * @returns {{errors: string[], warnings: string[]}}
 */
export function renderSummary(summaryEl, elementType, attrs) {
  const validation = validateNewMember(elementType, attrs, buildValidationContext(elementType));
  paintSummary(summaryEl, describeMember(elementType, attrs), validation, '✅ 作成可能です');
  return validation;
}

/**
 * 既存への紐づけモードの確認サマリ＋検証を描画し、検証結果を返す。
 * @param {HTMLElement} summaryEl
 * @param {string} elementType
 * @param {string} targetId - 紐づけ先の要素ID
 * @returns {{errors: string[], warnings: string[]}}
 */
export function renderLinkSummary(summaryEl, elementType, targetId) {
  const validation = validateNodeLink(targetId, formState.panelNodeIds, {
    nodeIds: formState.cachedNodeIds,
    linkedNodeIds: getLinkedNodeIds(elementType, targetId),
  });
  const label = TYPE_LABELS[elementType] || elementType;
  const desc = `${label} #${targetId || '-'} に節点[${formState.panelNodeIds.join(', ')}] (${formState.panelNodeIds.length}点) を追加`;
  paintSummary(summaryEl, desc, validation, '✅ 紐づけ可能です');
  return validation;
}

/**
 * 確認サマリ（説明文＋エラー/警告 or OK）を描画する。
 * ユーザー入力値を含むため innerHTML は使わず textContent で組み立てる（XSS回避）。
 * @param {HTMLElement} summaryEl
 * @param {string} desc
 * @param {{errors: string[], warnings: string[]}} validation
 * @param {string} okText
 */
function paintSummary(summaryEl, desc, validation, okText) {
  summaryEl.replaceChildren();
  const descEl = document.createElement('div');
  descEl.className = 'add-member-summary-desc';
  descEl.textContent = desc;
  summaryEl.appendChild(descEl);

  if (validation.errors.length > 0 || validation.warnings.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'add-member-issues';
    for (const e of validation.errors) {
      const li = document.createElement('li');
      li.className = 'add-member-issue-error';
      li.textContent = `⛔ ${e}`;
      ul.appendChild(li);
    }
    for (const w of validation.warnings) {
      const li = document.createElement('li');
      li.className = 'add-member-issue-warning';
      li.textContent = `⚠️ ${w}`;
      ul.appendChild(li);
    }
    summaryEl.appendChild(ul);
  } else {
    const ok = document.createElement('div');
    ok.className = 'add-member-ok';
    ok.textContent = okText;
    summaryEl.appendChild(ok);
  }
}
