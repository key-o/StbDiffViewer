/**
 * @fileoverview 編集後の3D再描画コントローラー
 *
 * 既存経路では EditEvents.RECOMPARISON_COMPLETED を購読し、変更タイプを型単位で再描画する。
 * Working Document 経路では、比較を介さず element-ID 単位の renderable 差し替えを行う。
 * 旧経路は移行ゲート完了まで維持し、自動停止しない。
 *
 * @module app/controllers/editGeometrySyncController
 */

import { createLogger } from '../../utils/logger.js';
import { eventBus, EditEvents } from '../../data/events/index.js';
import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { getState } from '../../data/state/globalState.js';
import { STB_TAG_NAMES } from '../../constants/elementTypes.js';
import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import {
  redrawElementByType,
  redrawNodesForViewMode,
  redrawJointsForViewMode,
  redrawUndefinedElementsForViewMode,
} from '../viewModes/elementRedrawer.js';
import { registerElementsToRegistry } from '../../modelLoader/renderingOrchestrator.js';
import editingSession from '../editing/editingSession.js';
import {
  insertWorkingSolidElement,
  replaceWorkingSolidElement,
} from '../editing/workingSolidGenerator.js';
import {
  displayModeManager,
  elementGroups,
  geometryGeneratorFactory,
  parseStbFile,
  insertElementRenderablesInGroup,
  removeElementRenderablesInGroup,
  replaceElementRenderablesInGroup,
  updateNodeRenderablesInGroup,
  updateLineRenderablesInGroup,
} from '../../viewer/index.js';

const log = createLogger('editGeometrySyncController');

/** 初期化済みフラグ */
let isInitialized = false;
let removeRecomparisonListener = null;
let removeWorkingDocumentListener = null;

const DEFAULT_WORKING_GEOMETRY_DEPENDENCIES = {
  getState,
  scheduleRender,
  editingSession,
  insertWorkingSolidElement,
  replaceWorkingSolidElement,
  displayModeManager,
  elementGroups,
  geometryGeneratorFactory,
  parseStbFile,
  insertElementRenderablesInGroup,
  removeElementRenderablesInGroup,
  replaceElementRenderablesInGroup,
  updateNodeRenderablesInGroup,
  updateLineRenderablesInGroup,
};

let workingGeometryDependencies = { ...DEFAULT_WORKING_GEOMETRY_DEPENDENCIES };

/**
 * Working geometry経路の依存をテスト用に差し替える。
 * @param {Object} overrides
 */
export function setWorkingGeometrySyncDependencies(overrides = {}) {
  workingGeometryDependencies = { ...workingGeometryDependencies, ...overrides };
}

/** Working geometry依存をproduction既定値へ戻す。 */
export function resetWorkingGeometrySyncDependencies() {
  workingGeometryDependencies = { ...DEFAULT_WORKING_GEOMETRY_DEPENDENCIES };
}

/**
 * 比較タイプ → 再描画タイプの展開。
 * 比較結果では ShearWall は Wall に正規化されるが、
 * ビューアは Wall / ShearWall を別グループで描画するため両方を再描画する。
 */
const REDRAW_TYPE_EXPANSIONS = { Wall: ['Wall', 'ShearWall'] };

/** 再描画パイプラインを持たないタイプ（編集再描画の対象外） */
const NON_REDRAWABLE_TYPES = new Set(['Story', 'Axis']);

const ELEMENT_TAG_NAMES = {
  Column: STB_TAG_NAMES.COLUMN,
  Post: STB_TAG_NAMES.POST,
  Girder: STB_TAG_NAMES.GIRDER,
  Beam: STB_TAG_NAMES.BEAM,
  Brace: STB_TAG_NAMES.BRACE,
  Slab: STB_TAG_NAMES.SLAB,
  Wall: STB_TAG_NAMES.WALL,
  ShearWall: STB_TAG_NAMES.WALL,
  Parapet: STB_TAG_NAMES.PARAPET,
  Joint: STB_TAG_NAMES.JOINT,
  Pile: STB_TAG_NAMES.PILE,
  Footing: STB_TAG_NAMES.FOOTING,
  StripFooting: STB_TAG_NAMES.STRIP_FOOTING,
  FoundationColumn: STB_TAG_NAMES.FOUNDATION_COLUMN,
  IsolatingDevice: STB_TAG_NAMES.ISOLATING_DEVICE,
  DampingDevice: STB_TAG_NAMES.DAMPING_DEVICE,
  FrameDampingDevice: STB_TAG_NAMES.FRAME_DAMPING_DEVICE,
};

const START_NODE_ATTRIBUTES = ['id_node_start', 'id_node_bottom', 'id_node'];
const END_NODE_ATTRIBUTES = ['id_node_end', 'id_node_top'];

function isPolygonElementType(elementType) {
  return elementType === 'Slab' || elementType === 'Wall' || elementType === 'ShearWall';
}

function findElementById(document, elementType, elementId) {
  const tagName = ELEMENT_TAG_NAMES[elementType];
  if (!document || !tagName) return null;

  const element = [...document.getElementsByTagName(tagName)].find(
    (candidate) => String(candidate.getAttribute('id')) === String(elementId),
  );
  if (!element) return null;
  if (
    (elementType === 'Wall' || elementType === 'ShearWall') &&
    getViewerWallElementType(element) !== elementType
  ) {
    return null;
  }
  return element;
}

function normalizePosition(position) {
  if (!position || typeof position !== 'object') return null;
  const normalized = {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
  return Object.values(normalized).every(Number.isFinite) ? normalized : null;
}

function getNodeMapEntry(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  if (nodeMap.has(targetId)) return nodeMap.get(targetId);
  for (const [key, value] of nodeMap.entries()) {
    if (String(key) === targetId) return value;
  }
  return null;
}

function getNodePosition(document, nodeMap, nodeId) {
  const fromMap = normalizePosition(getNodeMapEntry(nodeMap, nodeId));
  if (fromMap) return fromMap;

  const node = document
    ? [...document.getElementsByTagName(STB_TAG_NAMES.NODE)].find(
        (candidate) => String(candidate.getAttribute('id')) === String(nodeId),
      )
    : null;
  if (!node) return null;
  return normalizePosition({
    x: node.getAttribute('X'),
    y: node.getAttribute('Y'),
    z: node.getAttribute('Z'),
  });
}

function getLineEndpointFlags(document, elementType, elementId, nodeId) {
  const element = findElementById(document, elementType, elementId);
  if (!element) return { moveStart: false, moveEnd: false };

  if (element.getElementsByTagName('StbNodeIdOrder').length > 0) {
    return { moveStart: false, moveEnd: false };
  }

  const targetId = String(nodeId);
  const hasNode = (attributeName) => String(element.getAttribute(attributeName)) === targetId;
  return {
    moveStart: START_NODE_ATTRIBUTES.some(hasNode),
    moveEnd: END_NODE_ATTRIBUTES.some(hasNode),
  };
}

function getLineEndpoints(document, nodeMap, elementType, elementId) {
  const element = findElementById(document, elementType, elementId);
  if (!element) return null;
  if (element.getElementsByTagName('StbNodeIdOrder').length > 0) return null;

  const startAttribute = START_NODE_ATTRIBUTES.find((name) => element.hasAttribute(name));
  const endAttribute = END_NODE_ATTRIBUTES.find((name) => element.hasAttribute(name));
  if (!startAttribute || !endAttribute) return null;

  const start = getNodePosition(document, nodeMap, element.getAttribute(startAttribute));
  const end = getNodePosition(document, nodeMap, element.getAttribute(endAttribute));
  return start && end ? { start, end } : null;
}

function findPolygonOffset(element, elementType, nodeId) {
  const offsetTag = elementType === 'Slab' ? 'StbSlabOffset' : 'StbWallOffset';
  return [...element.getElementsByTagName(offsetTag)].find(
    (candidate) => String(candidate.getAttribute('id_node')) === String(nodeId),
  );
}

function getPolygonDescriptor(document, nodeMap, elementType, elementId) {
  if (!isPolygonElementType(elementType)) return null;
  const element = findElementById(document, elementType, elementId);
  if (!element) return null;
  const order = element.getElementsByTagName('StbNodeIdOrder')[0];
  const nodeIds = String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (nodeIds.length < 3) return null;

  const points = [];
  for (const nodeId of nodeIds) {
    const position = getNodePosition(document, nodeMap, nodeId);
    if (!position) return null;
    const offset = findPolygonOffset(element, elementType, nodeId);
    points.push({
      x: position.x + Number(offset?.getAttribute('offset_X') || 0),
      y: position.y + Number(offset?.getAttribute('offset_Y') || 0),
      z: position.z + Number(offset?.getAttribute('offset_Z') || 0),
    });
  }
  return { kind: 'working-polygon', points };
}

function getNodeChanges(payload) {
  if (Array.isArray(payload?.nodeChanges)) {
    return payload.nodeChanges
      .map((change) => ({
        nodeId: change?.nodeId === undefined ? null : String(change.nodeId),
        previousPosition: normalizePosition(change?.previousPosition),
        position: normalizePosition(change?.position),
      }))
      .filter((change) => change.nodeId !== null && change.position);
  }

  if (payload?.nodeId === undefined) return [];
  return [
    {
      nodeId: String(payload.nodeId),
      previousPosition: normalizePosition(payload.previousPosition),
      position: normalizePosition(payload.position),
    },
  ].filter((change) => change.position);
}

function emitReplacementLifecycle(elementType, elementId, result) {
  const replacementPairs = result?.replacement?.replacementPairs || result?.replacementPairs || [];
  if (result?.replaced && Array.isArray(replacementPairs) && replacementPairs.length > 0) {
    eventBus.emit(RenderableLifecycleEvents.RENDERABLES_REPLACED, {
      elementType,
      elementId: String(elementId),
      replacementPairs,
    });
  }
}

function replaceSolidElementInScene(deps, elementType, elementId, document, nodeMap) {
  if (deps.displayModeManager?.getDisplayMode?.(elementType) !== 'solid') {
    return { supported: false, replaced: false, reason: 'non-solid-display-mode' };
  }

  const group = deps.elementGroups?.[elementType];
  if (!group) {
    return { supported: false, replaced: false, reason: 'element-group-missing' };
  }
  if (!document) {
    return { supported: false, replaced: false, reason: 'working-document-missing' };
  }

  const parsedData = deps.parseStbFile(document, { modelKey: null });
  const generatorInfo = deps.geometryGeneratorFactory?.getGeneratorInfo?.(elementType) || null;
  const result = deps.replaceWorkingSolidElement({
    group,
    elementType,
    elementId,
    parsedData,
    workingNodeMap: nodeMap,
    generatorInfo,
    replace: deps.replaceElementRenderablesInGroup,
  });
  emitReplacementLifecycle(elementType, elementId, result);
  return result;
}

function replacePolygonElementInScene(deps, elementType, elementId, document, nodeMap) {
  if (deps.displayModeManager?.getDisplayMode?.(elementType) !== 'line') {
    return { supported: false, replaced: false, reason: 'non-line-display-mode' };
  }
  const group = deps.elementGroups?.[elementType];
  if (!group?.traverse) {
    return { supported: false, replaced: false, reason: 'element-group-missing' };
  }
  const descriptor = getPolygonDescriptor(document, nodeMap, elementType, elementId);
  if (!descriptor) {
    return { supported: false, replaced: false, reason: 'polygon-descriptor-missing' };
  }
  const replacement = deps.replaceElementRenderablesInGroup?.(
    group,
    elementType,
    elementId,
    descriptor,
  );
  const result = { supported: true, replaced: replacement?.replaced === true, replacement };
  emitReplacementLifecycle(elementType, elementId, result);
  return result;
}

function getStructuralChanges(payload) {
  return Array.isArray(payload?.structuralChanges)
    ? payload.structuralChanges
        .map((change) => ({
          operation: change?.operation,
          elementType: change?.elementType,
          elementId: change?.elementId === undefined ? null : String(change.elementId),
        }))
        .filter(
          (change) =>
            ['add', 'delete'].includes(change.operation) &&
            change.elementType &&
            change.elementId !== null,
        )
    : [];
}

function insertSolidElementInScene(deps, elementType, elementId, document, nodeMap) {
  if (deps.displayModeManager?.getDisplayMode?.(elementType) !== 'solid') {
    return { supported: false, inserted: false, reason: 'non-solid-display-mode' };
  }
  const group = deps.elementGroups?.[elementType];
  if (!group) return { supported: false, inserted: false, reason: 'element-group-missing' };
  if (!document) {
    return { supported: false, inserted: false, reason: 'working-document-missing' };
  }

  const parsedData = deps.parseStbFile(document, { modelKey: null });
  const generatorInfo = deps.geometryGeneratorFactory?.getGeneratorInfo?.(elementType) || null;
  return deps.insertWorkingSolidElement({
    group,
    elementType,
    elementId,
    parsedData,
    workingNodeMap: nodeMap,
    generatorInfo,
    insert: deps.insertElementRenderablesInGroup,
  });
}

function removeSolidElementFromScene(deps, elementType, elementId) {
  if (deps.displayModeManager?.getDisplayMode?.(elementType) !== 'solid') {
    return { supported: false, removed: false, reason: 'non-solid-display-mode' };
  }
  const group = deps.elementGroups?.[elementType];
  if (!group) return { supported: false, removed: false, reason: 'element-group-missing' };
  const removal = deps.removeElementRenderablesInGroup?.(group, elementType, elementId);
  return { supported: true, removed: removal?.removed === true, removal };
}

/**
 * Working Document / workingNodeMap を使って、現在solid表示中の1要素だけsceneで差し替える。
 * 選択中objectは semantic identity を維持したまま replacement object へ参照移送する。
 *
 * @param {string} elementType
 * @param {string|number} elementId
 * @returns {Object} replaceWorkingSolidElement の結果または reason付き未実行結果
 */
export function replaceWorkingSolidElementInScene(elementType, elementId) {
  const deps = workingGeometryDependencies;
  const sessionState = deps.editingSession.getState();
  if (!sessionState?.active) {
    return { supported: false, replaced: false, reason: 'edit-session-inactive' };
  }

  const workingDocument = deps.editingSession.getWorkingDocument?.();
  const result = replaceSolidElementInScene(
    deps,
    elementType,
    elementId,
    workingDocument,
    deps.editingSession.getWorkingNodeMap(),
  );

  if (result?.replaced) deps.scheduleRender?.();
  return result;
}

/**
 * Working Document の変更を現在の表示へ反映する。
 *
 * 比較結果や自動再比較には触れず、Node marker・2節点 line・polygon panel・solid の
 * 対象要素だけを更新する。破棄時は source snapshot を対象にして Working 側表示を戻す。
 *
 * @param {Object} payload - EditEvents.WORKING_DOCUMENT_CHANGED の payload
 * @param {Object} [deps=workingGeometryDependencies] - テスト用依存
 * @returns {{supported:boolean, nodeUpdates:number, lineUpdates:number, solidUpdates:number}}
 */
export function syncWorkingDocumentGeometry(payload = {}, deps = workingGeometryDependencies) {
  const targetDocument = payload.targetDocument || payload.workingDocument || null;
  const targetNodeMap = payload.targetNodeMap || payload.workingNodeMap || null;
  const nodeChanges = getNodeChanges(payload);
  const structuralChanges = getStructuralChanges(payload);
  const affectedElements = Array.isArray(payload.affectedElements)
    ? payload.affectedElements.filter(
        (element) => element?.elementType && element.elementId !== undefined,
      )
    : [];

  if (
    !targetDocument ||
    (nodeChanges.length === 0 && affectedElements.length === 0 && structuralChanges.length === 0)
  ) {
    return { supported: false, nodeUpdates: 0, lineUpdates: 0, solidUpdates: 0 };
  }

  let nodeUpdates = 0;
  let lineUpdates = 0;
  let solidUpdates = 0;
  const nodeGroup = deps.elementGroups?.Node;
  const structuralKeys = new Set();

  for (const change of structuralChanges) {
    const key = `${change.elementType}:${change.elementId}`;
    structuralKeys.add(key);

    if (change.elementType === 'Node') {
      const group = deps.elementGroups?.Node;
      if (!group?.traverse) continue;
      if (change.operation === 'add') {
        const position = getNodePosition(targetDocument, targetNodeMap, change.elementId);
        if (!position) continue;
        const result = deps.insertElementRenderablesInGroup?.(group, 'Node', change.elementId, {
          kind: 'working-node',
          position,
        });
        if (result?.inserted) nodeUpdates += 1;
      } else {
        const result = deps.removeElementRenderablesInGroup?.(group, 'Node', change.elementId);
        if (result?.removed) nodeUpdates += 1;
      }
      continue;
    }

    const displayMode = deps.displayModeManager?.getDisplayMode?.(change.elementType);
    if (displayMode === 'line') {
      const group = deps.elementGroups?.[change.elementType];
      if (!group?.traverse) continue;
      if (change.operation === 'add') {
        const descriptor = isPolygonElementType(change.elementType)
          ? getPolygonDescriptor(
              targetDocument,
              targetNodeMap,
              change.elementType,
              change.elementId,
            )
          : (() => {
              const endpoints = getLineEndpoints(
                targetDocument,
                targetNodeMap,
                change.elementType,
                change.elementId,
              );
              return endpoints ? { kind: 'working-line', ...endpoints } : null;
            })();
        if (!descriptor) continue;
        const result = deps.insertElementRenderablesInGroup?.(
          group,
          change.elementType,
          change.elementId,
          descriptor,
        );
        if (result?.inserted) lineUpdates += 1;
      } else {
        const result = deps.removeElementRenderablesInGroup?.(
          group,
          change.elementType,
          change.elementId,
        );
        if (result?.removed) lineUpdates += 1;
      }
      continue;
    }

    if (displayMode === 'solid') {
      if (change.operation === 'add') {
        const result = insertSolidElementInScene(
          deps,
          change.elementType,
          change.elementId,
          targetDocument,
          targetNodeMap,
        );
        if (result?.inserted) solidUpdates += 1;
      } else {
        const result = removeSolidElementFromScene(deps, change.elementType, change.elementId);
        if (result?.removed) solidUpdates += 1;
      }
    }
  }

  for (const change of nodeChanges) {
    const position =
      change.position || getNodePosition(targetDocument, targetNodeMap, change.nodeId);
    if (!position) continue;
    const result = deps.updateNodeRenderablesInGroup?.(nodeGroup, change.nodeId, position);
    nodeUpdates += Number(result?.objects || 0) + Number(result?.instances || 0);
  }

  const solidTypes = new Set();
  const polygonTypes = new Set();
  for (const element of affectedElements) {
    const { elementType, elementId } = element;
    if (structuralKeys.has(`${elementType}:${String(elementId)}`)) continue;
    const displayMode = deps.displayModeManager?.getDisplayMode?.(elementType);
    if (displayMode === 'solid') {
      solidTypes.add(`${elementType}:${String(elementId)}`);
      continue;
    }

    if (displayMode !== 'line') continue;
    if (isPolygonElementType(elementType)) {
      polygonTypes.add(`${elementType}:${String(elementId)}`);
      continue;
    }

    const group = deps.elementGroups?.[elementType];
    for (const change of nodeChanges) {
      if (!change.previousPosition || !change.position) continue;
      const flags = getLineEndpointFlags(targetDocument, elementType, elementId, change.nodeId);
      if (!flags.moveStart && !flags.moveEnd) continue;
      const delta = {
        x: change.position.x - change.previousPosition.x,
        y: change.position.y - change.previousPosition.y,
        z: change.position.z - change.previousPosition.z,
      };
      const result = deps.updateLineRenderablesInGroup?.(group, elementType, elementId, {
        delta,
        moveStart: flags.moveStart,
        moveEnd: flags.moveEnd,
      });
      lineUpdates += Number(result?.lines || 0) + Number(result?.segments || 0);
      lineUpdates += Number(result?.labels || 0);
    }
  }

  for (const key of polygonTypes) {
    const separator = key.indexOf(':');
    const elementType = key.slice(0, separator);
    const elementId = key.slice(separator + 1);
    const result = replacePolygonElementInScene(
      deps,
      elementType,
      elementId,
      targetDocument,
      targetNodeMap,
    );
    if (result?.replaced) lineUpdates += 1;
  }

  for (const key of solidTypes) {
    const separator = key.indexOf(':');
    const elementType = key.slice(0, separator);
    const elementId = key.slice(separator + 1);
    const result = replaceSolidElementInScene(
      deps,
      elementType,
      elementId,
      targetDocument,
      targetNodeMap,
    );
    if (result?.replaced) solidUpdates += 1;
  }

  // Discard can restore a line/polygon with no single delta when the source snapshot contains
  // a different position. Type-level redraw remains the conservative reset fallback.
  if (payload.reset === true) {
    const lineTypes = new Set(
      affectedElements
        .filter(
          (element) => deps.displayModeManager?.getDisplayMode?.(element.elementType) === 'line',
        )
        .map((element) => element.elementType),
    );
    for (const elementType of lineTypes) {
      try {
        redrawType(elementType);
      } catch (error) {
        log.error(`[EditSync] Working Document破棄後の${elementType}再描画でエラー:`, error);
      }
    }
  }

  if (nodeUpdates > 0 || lineUpdates > 0 || solidUpdates > 0 || payload.reset === true) {
    deps.scheduleRender?.();
  }

  return { supported: true, nodeUpdates, lineUpdates, solidUpdates };
}

/**
 * 1要素タイプを現在の表示モードに従って再描画する
 * @param {string} elementType - 要素タイプ
 */
function redrawType(elementType) {
  switch (elementType) {
    case 'Node':
      redrawNodesForViewMode(scheduleRender);
      break;
    case 'Joint':
      redrawJointsForViewMode(scheduleRender);
      break;
    case 'Undefined':
      redrawUndefinedElementsForViewMode(scheduleRender);
      break;
    default:
      redrawElementByType(elementType, scheduleRender);
  }
}

/**
 * 変更タイプ集合を再描画し、要素検索レジストリを同期する
 * @param {string[]} changedElementTypes - 再比較で変更された要素タイプ
 */
function handleRecomparisonCompleted(changedElementTypes) {
  if (!Array.isArray(changedElementTypes) || changedElementTypes.length === 0) return;

  const redrawTypes = new Set();
  for (const type of changedElementTypes) {
    if (NON_REDRAWABLE_TYPES.has(type)) continue;
    for (const expandedType of REDRAW_TYPE_EXPANSIONS[type] || [type]) {
      redrawTypes.add(expandedType);
    }
  }

  for (const type of redrawTypes) {
    try {
      redrawType(type);
    } catch (error) {
      log.error(`[EditSync] ${type} の再描画でエラー:`, error);
    }
  }

  if (redrawTypes.size > 0) {
    registerElementsToRegistry();
    scheduleRender();
    log.info(`[EditSync] ${[...redrawTypes].join(', ')} を再描画しました`);
  }
}

/**
 * 編集→3D再描画コントローラーの内部状態をリセットする（テスト用）
 */
export function resetEditGeometrySync() {
  removeRecomparisonListener?.();
  removeWorkingDocumentListener?.();
  removeRecomparisonListener = null;
  removeWorkingDocumentListener = null;
  isInitialized = false;
  resetWorkingGeometrySyncDependencies();
}

/**
 * 編集→3D再描画コントローラーを初期化する
 */
export function initEditGeometrySync() {
  if (isInitialized) return;

  removeRecomparisonListener = eventBus.on(
    EditEvents.RECOMPARISON_COMPLETED,
    ({ changedElementTypes } = {}) => {
      handleRecomparisonCompleted(changedElementTypes);
    },
  );
  removeWorkingDocumentListener = eventBus.on(
    EditEvents.WORKING_DOCUMENT_CHANGED,
    (payload = {}) => {
      try {
        syncWorkingDocumentGeometry(payload);
      } catch (error) {
        log.error('[EditSync] Working Documentの局所Geometry更新でエラー:', error);
      }
    },
  );

  isInitialized = true;
  log.info('編集→3D再描画コントローラーを初期化しました');
}
