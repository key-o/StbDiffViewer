/**
 * @fileoverview 新規断面要素の追加
 *
 * スキーマ駆動ビルダーで組み立てた断面要素を StbSections 直下へ追加する。
 * id 採番は `domHelpers.generateNextSectionId`、挿入位置は現在のXSDにおける
 * StbSections の xs:sequence に従う。
 */

import { getElementChildren } from '../../../../common-stb/import/parser/jsonSchemaLoader.js';
import { createAddElementCommand } from '../../../../app/editing/addElementCommand.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { getState } from '../../../../data/state/globalState.js';
import { showSuccess } from '../../../common/toast.js';
import { ensureContainer, generateNextSectionId, emitStructuralChange } from './domHelpers.js';
import { updateEditingSummary } from './editHistory.js';
import { getModifications } from './editState.js';

// JSON Schema bootstrap前のテスト/低レベルAPI呼び出しでもSTB 2.xの基本順を崩さないためのフォールバック。
// 通常UIでは active schema の x-children が常に優先される。
const FALLBACK_SECTION_ORDER = [
  'StbSecColumn_RC',
  'StbSecColumn_S',
  'StbSecColumn_SRC',
  'StbSecColumn_CFT',
  'StbSecBeam_RC',
  'StbSecBeam_S',
  'StbSecBeam_SRC',
  'StbSecBrace_S',
  'StbSecSlab_RC',
  'StbSecSlabDeck',
  'StbSecSlabPrecast',
  'StbSecSlabLoad',
  'StbSecWall_RC',
  'StbSecWallLoad',
  'StbSecFoundation_RC',
  'StbSecPile_RC',
  'StbSecPile_S',
  'StbSecPileProduct',
  'StbSecOpen_RC',
  'StbSecParapet_RC',
  'StbSecSteel',
  'StbSecUndefined',
];

function getSectionSchemaOrder() {
  const loadedOrder = (getElementChildren('StbSections') || []).map((child) => child.name);
  return loadedOrder.length > 0 ? loadedOrder : FALLBACK_SECTION_ORDER;
}

function insertInSchemaOrder(container, element) {
  const schemaOrder = getSectionSchemaOrder();
  const index = schemaOrder.indexOf(element.tagName);
  if (index < 0) return false;

  const before = Array.from(container.children || []).find((child) => {
    const childIndex = schemaOrder.indexOf(child.tagName);
    return childIndex >= 0 && childIndex > index;
  });
  if (before) container.insertBefore(element, before);
  else container.appendChild(element);
  return true;
}

function nextSectionIdFromDocument(document) {
  const sections = document?.querySelector?.('StbSections') || null;
  return sections ? generateNextSectionId(sections) : '1';
}

function addNewSectionToWorkingDocument(builtElement) {
  const workingDocument = editingSession.getWorkingDocument();
  if (!workingDocument) {
    return { success: false, id: null, error: 'Working Document がありません' };
  }
  if (!builtElement || !builtElement.tagName) {
    return { success: false, id: null, error: '断面要素がありません' };
  }

  const tagName = builtElement.tagName;
  const schemaOrder = getSectionSchemaOrder();
  if (!schemaOrder.includes(tagName)) {
    return {
      success: false,
      id: null,
      error: `${tagName} は現在のXSDの StbSections 直下要素ではありません`,
    };
  }

  try {
    const element = builtElement.cloneNode(true);
    const id = nextSectionIdFromDocument(workingDocument);
    element.setAttribute('id', id);
    const elementType = tagName.startsWith('Stb') ? tagName.slice(3) : tagName;
    const command = createAddElementCommand(workingDocument, element, {
      parentPath: ['StbSections'],
      elementType,
      siblingOrder: schemaOrder,
      affectedElements: [],
      label: `${tagName} #${id} を追加`,
    });
    editingSession.executeCommand(command, { reason: 'addSection' });
    showSuccess(`${tagName} #${id} を追加しました`);
    return { success: true, id, tagName };
  } catch (error) {
    return {
      success: false,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * スキーマ駆動ビルダーで組み立てた断面要素（子・孫を含む）を追加する。
 * Working Session 中は Working Document + AddElementCommand を正本とし、source documentA は変更しない。
 * Working Session 未開始時は既存の legacy mutation / ATTRIBUTE_CHANGED / legacy history 契約を維持する。
 *
 * @param {Element} builtElement - sectionXmlBuilder.buildSectionElement の戻り値（id 未設定）
 * @returns {{success: boolean, id: string|null, tagName?: string, error?: string}}
 */
export function addNewSectionElement(builtElement) {
  if (editingSession.getState()?.active === true) {
    return addNewSectionToWorkingDocument(builtElement);
  }

  const doc = getState('models.documentA');
  if (!doc) {
    return { success: false, id: null, error: 'モデルAが読み込まれていません' };
  }
  if (!builtElement || !builtElement.tagName) {
    return { success: false, id: null, error: '断面要素がありません' };
  }

  const container = ensureContainer(doc, ['StbSections']);
  if (!container) {
    return { success: false, id: null, error: 'StbModel が見つかりません' };
  }

  const tagName = builtElement.tagName;
  const id = generateNextSectionId(container);
  builtElement.setAttribute('id', id);
  if (!insertInSchemaOrder(container, builtElement)) {
    builtElement.removeAttribute('id');
    return {
      success: false,
      id: null,
      error: `${tagName} は現在のXSDの StbSections 直下要素ではありません`,
    };
  }

  const elementType = tagName.startsWith('Stb') ? tagName.slice(3) : tagName;
  getModifications().push({ op: 'add', elementType, id, tagName });
  emitStructuralChange(elementType, id);

  updateEditingSummary();
  showSuccess(`${tagName} #${id} を追加しました`);
  return { success: true, id, tagName };
}
