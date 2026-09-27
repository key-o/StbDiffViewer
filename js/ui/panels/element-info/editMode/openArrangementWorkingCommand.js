/**
 * @fileoverview 開口配置UIを Working Document Command へ接続する Phase 5 adapter。
 *
 * Working Session 未開始時は openAdd.js の legacy mutation を維持する。
 * 2.0.2 は StbOpen + StbOpenId を1 CompositeCommand、2.1.x は
 * StbOpenArrangement を Add / reassign / delete の Working Command として扱う。
 */

import { detectStbVersion } from '../../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { getViewerWallElementType } from '../../../../common-stb/walls/wallClassification.js';
import { createAddElementCommand } from '../../../../app/editing/addElementCommand.js';
import { createDeleteElementCommand } from '../../../../app/editing/deleteElementCommand.js';
import { createCompositeCommand } from '../../../../app/editing/editCommand.js';
import { createSetAttributeCommand } from '../../../../app/editing/setAttributeCommand.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { showSuccess } from '../../../common/toast.js';
import { generateNextId } from './domHelpers.js';
import { addOpenWithAssignment as addLegacyOpenWithAssignment } from './openAdd.js';

const PANEL_KIND_BY_TAG = Object.freeze({
  StbWall: 'WALL',
  StbSlab: 'SLAB',
});

const PANEL_TAG_BY_KIND = Object.freeze({
  WALL: 'StbWall',
  SLAB: 'StbSlab',
});

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
}

function is21(version) {
  return String(version || '').startsWith('2.1');
}

function is202(version) {
  return String(version || '') === '2.0.2';
}

function requiresOpenSection(version) {
  return is21(version) && String(version) !== '2.1.0';
}

function getWorkingDocument() {
  const document = editingSession.getWorkingDocument();
  if (!document) return { document: null, version: '', error: 'Working Document がありません' };
  return { document, version: detectStbVersion(document), error: null };
}

function requireWorking21(operationLabel) {
  if (editingSession.getState()?.active !== true) {
    return { document: null, error: `${operationLabel}は Working Session 中のみ実行できます。` };
  }
  const resolved = getWorkingDocument();
  if (!resolved.document) return { document: null, error: resolved.error };
  if (!is21(resolved.version)) {
    return {
      document: null,
      error: `${operationLabel}は ST-Bridge 2.1.x arrangement 経路のみ対応しています。`,
    };
  }
  return { document: resolved.document, error: null };
}

function createDetachedElement(document, tagName, attrs) {
  const model = document?.querySelector?.('StbModel');
  if (!model) throw new Error('StbModel が見つかりません');
  const namespaceURI = model.namespaceURI;
  const element = namespaceURI
    ? document.createElementNS(namespaceURI, tagName)
    : document.createElement(tagName);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    element.setAttribute(name, String(value));
  }
  return element;
}

function validateFiniteAttribute(attrs, name, { required = true } = {}) {
  const value = attrs?.[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    return required ? `必須項目が未入力です: ${name}` : null;
  }
  return Number.isFinite(Number(value)) ? null : `${name} は数値で入力してください`;
}

function resolvePanel(document, panelTag, panelId) {
  const kindMember = PANEL_KIND_BY_TAG[panelTag];
  if (!kindMember) {
    return { panel: null, kindMember: null, error: '開口の割当先は壁または床を指定してください' };
  }
  const panel = document.querySelector(selectorById(panelTag, panelId));
  if (!panel) {
    return {
      panel: null,
      kindMember,
      error: `${panelTag} #${panelId} が見つかりません`,
    };
  }
  return { panel, kindMember, error: null };
}

function panelAffectedElement(panelTag, panel) {
  if (!panel) return null;
  const elementId = panel.getAttribute('id');
  if (!elementId) return null;
  return {
    elementType: panelTag === 'StbWall' ? getViewerWallElementType(panel) : 'Slab',
    elementId: String(elementId),
  };
}

function dedupeAffectedElements(elements) {
  const unique = new Map();
  for (const element of elements || []) {
    if (!element?.elementType || element.elementId === undefined || element.elementId === null)
      continue;
    const normalized = {
      elementType: String(element.elementType),
      elementId: String(element.elementId),
    };
    unique.set(`${normalized.elementType}:${normalized.elementId}`, normalized);
  }
  return [...unique.values()];
}

function affectedForOpenArrangement(document, arrangement) {
  const panelTag = PANEL_TAG_BY_KIND[String(arrangement?.getAttribute?.('kind_member') || '')];
  const panelId = arrangement?.getAttribute?.('id_member');
  if (!panelTag || !panelId) return [];
  const panel = document.querySelector(selectorById(panelTag, panelId));
  return dedupeAffectedElements([panelAffectedElement(panelTag, panel)]);
}

function createAffectedAttributeCommand(
  document,
  elementId,
  attributeName,
  nextValue,
  affectedElements,
) {
  const command = createSetAttributeCommand(
    document,
    'OpenArrangement',
    elementId,
    attributeName,
    nextValue,
  );
  command.affectedElements = dedupeAffectedElements(affectedElements);
  return command;
}

function validateOpenSection(document, idSection, { required }) {
  const normalized = String(idSection ?? '').trim();
  if (!normalized) {
    return required
      ? { idSection: '', error: '開口補強断面 StbSecOpen_RC の指定が必要です' }
      : { idSection: '', error: null };
  }
  if (!document.querySelector(selectorById('StbSecOpen_RC', normalized))) {
    return {
      idSection: normalized,
      error: `開口補強断面 StbSecOpen_RC #${normalized} が見つかりません`,
    };
  }
  return { idSection: normalized, error: null };
}

function addWorkingOpen202(document, { panelTag, panelId, attrs = {} }) {
  const panelResult = resolvePanel(document, panelTag, panelId);
  if (panelResult.error) return { success: false, id: null, error: panelResult.error };

  const sectionResult = validateOpenSection(document, attrs.id_section, { required: false });
  if (sectionResult.error) return { success: false, id: null, error: sectionResult.error };

  for (const name of ['position_X', 'position_Y', 'length_X', 'length_Y', 'rotate']) {
    const error = validateFiniteAttribute(attrs, name);
    if (error) return { success: false, id: null, error };
  }
  if (Number(attrs.length_X) <= 0 || Number(attrs.length_Y) <= 0) {
    return {
      success: false,
      id: null,
      error: '開口寸法 length_X / length_Y は0より大きい値を指定してください',
    };
  }

  try {
    const id = generateNextId(document, 'StbOpen');
    const affectedElements = dedupeAffectedElements([
      panelAffectedElement(panelTag, panelResult.panel),
    ]);

    const open = createDetachedElement(document, 'StbOpen', {
      id,
      name: attrs.name,
      id_section: sectionResult.idSection,
      position_X: attrs.position_X,
      position_Y: attrs.position_Y,
      length_X: attrs.length_X,
      length_Y: attrs.length_Y,
      rotate: attrs.rotate,
    });
    const openCommand = createAddElementCommand(document, open, {
      parentPath: ['StbMembers', 'StbOpens'],
      elementType: 'Open',
      affectedElements,
      label: `StbOpen #${id} を追加`,
    });

    const openReference = createDetachedElement(document, 'StbOpenId', { id });
    const referenceCommand = createAddElementCommand(document, openReference, {
      parentPath: [
        'StbMembers',
        panelTag === 'StbWall' ? 'StbWalls' : 'StbSlabs',
        { tagName: panelTag, attributes: { id: String(panelId) } },
        'StbOpenIdList',
      ],
      elementType: 'OpenIdReference',
      affectedElements,
      label: `${panelTag} #${panelId} に StbOpenId #${id} を追加`,
    });

    const command = createCompositeCommand([openCommand, referenceCommand], {
      label: `StbOpen #${id} を${panelResult.kindMember === 'WALL' ? '壁' : '床'} #${panelId}へ追加`,
    });
    editingSession.executeCommand(command, { reason: 'addOpen202' });
    showSuccess(
      `StbOpen #${id} を${panelResult.kindMember === 'WALL' ? '壁' : '床'} #${panelId}へ割り当てました`,
    );
    return { success: true, id, tagName: 'StbOpen' };
  } catch (error) {
    return {
      success: false,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function addWorkingOpen21(document, version, { panelTag, panelId, attrs = {} }) {
  const panelResult = resolvePanel(document, panelTag, panelId);
  if (panelResult.error) return { success: false, id: null, error: panelResult.error };

  const sectionResult = validateOpenSection(document, attrs.id_section, {
    required: requiresOpenSection(version),
  });
  if (sectionResult.error) return { success: false, id: null, error: sectionResult.error };
  for (const name of ['position_X', 'position_Y', 'rotate']) {
    const error = validateFiniteAttribute(attrs, name);
    if (error) return { success: false, id: null, error };
  }

  try {
    const id = generateNextId(document, 'StbOpenArrangement');
    const arrangement = createDetachedElement(document, 'StbOpenArrangement', {
      id,
      name: attrs.name,
      id_section: sectionResult.idSection,
      kind_member: panelResult.kindMember,
      id_member: String(panelId),
      position_X: attrs.position_X,
      position_Y: attrs.position_Y,
      rotate: attrs.rotate,
    });
    const affectedElements = dedupeAffectedElements([
      panelAffectedElement(panelTag, panelResult.panel),
    ]);
    const command = createAddElementCommand(document, arrangement, {
      parentPath: ['StbMembers', 'StbOpenArrangements'],
      elementType: 'OpenArrangement',
      affectedElements,
      label: `StbOpenArrangement #${id} を追加`,
    });
    editingSession.executeCommand(command, { reason: 'addOpenArrangement' });
    showSuccess(
      `StbOpenArrangement #${id} を${panelResult.kindMember === 'WALL' ? '壁' : '床'} #${panelId}へ割り当てました`,
    );
    return { success: true, id, tagName: 'StbOpenArrangement' };
  } catch (error) {
    return {
      success: false,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function addWorkingOpenWithAssignment(input) {
  const resolved = getWorkingDocument();
  if (!resolved.document) return { success: false, id: null, error: resolved.error };
  if (is202(resolved.version)) return addWorkingOpen202(resolved.document, input);
  if (is21(resolved.version)) return addWorkingOpen21(resolved.document, resolved.version, input);
  return {
    success: false,
    id: null,
    error: `Working Session 中の開口追加は ST-Bridge 2.0.2 / 2.1.x のみ対応しています: ${resolved.version || '(unknown)'}`,
  };
}

function reassignWorkingOpenArrangement21({ arrangementId, panelTag, panelId }) {
  const resolved = requireWorking21('開口配置の再割当');
  if (!resolved.document) return { success: false, error: resolved.error };
  const document = resolved.document;
  const id = String(arrangementId ?? '').trim();
  const arrangement = id ? document.querySelector(selectorById('StbOpenArrangement', id)) : null;
  if (!arrangement) {
    return { success: false, error: `StbOpenArrangement #${id || '?'} が見つかりません` };
  }

  const target = resolvePanel(document, panelTag, panelId);
  if (target.error) return { success: false, error: target.error };

  const affectedElements = dedupeAffectedElements([
    ...affectedForOpenArrangement(document, arrangement),
    panelAffectedElement(panelTag, target.panel),
  ]);
  const commands = [
    createAffectedAttributeCommand(
      document,
      id,
      'kind_member',
      target.kindMember,
      affectedElements,
    ),
    createAffectedAttributeCommand(document, id, 'id_member', String(panelId), affectedElements),
  ].filter((command) => !command.isNoop);

  if (commands.length === 0) {
    return { success: false, error: '選択した壁・床には既に割り当て済みです' };
  }

  try {
    editingSession.runTransaction(commands, {
      reason: 'reassignOpenArrangement',
      label: `StbOpenArrangement #${id} を再割当`,
    });
    showSuccess(`StbOpenArrangement #${id} を ${panelTag} #${panelId} へ再割当しました`);
    return { success: true, id, affectedElements };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function deleteWorkingOpenArrangement21({ arrangementId }) {
  const resolved = requireWorking21('開口配置の削除');
  if (!resolved.document) return { success: false, error: resolved.error };
  const document = resolved.document;
  const id = String(arrangementId ?? '').trim();
  const arrangement = id ? document.querySelector(selectorById('StbOpenArrangement', id)) : null;
  if (!arrangement) {
    return { success: false, error: `StbOpenArrangement #${id || '?'} が見つかりません` };
  }

  const affectedElements = affectedForOpenArrangement(document, arrangement);
  try {
    const command = createDeleteElementCommand(document, 'OpenArrangement', id, {
      tagName: 'StbOpenArrangement',
      affectedElements,
      structuralChange: false,
      label: `StbOpenArrangement #${id} を削除`,
    });
    editingSession.executeCommand(command, { reason: 'deleteOpenArrangement' });
    showSuccess(`StbOpenArrangement #${id} を削除しました`);
    return { success: true, id, affectedElements };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Working Session 中だけ Working Command を使用する public adapter。 */
export function addOpenWithAssignment(input) {
  if (editingSession.getState()?.active !== true) return addLegacyOpenWithAssignment(input);
  return addWorkingOpenWithAssignment(input);
}

/** ST-Bridge 2.1.x の既存開口配置を別の壁・床へ atomic に再割当する。 */
export function reassignOpenArrangement(input) {
  return reassignWorkingOpenArrangement21(input || {});
}

/** ST-Bridge 2.1.x の既存開口配置を Working history へ載せて削除する。 */
export function deleteOpenArrangement(input) {
  return deleteWorkingOpenArrangement21(input || {});
}
