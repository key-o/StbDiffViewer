/**
 * @fileoverview PERF-4: generation単位の配筋mesh保持・再表示制御。
 *
 * facts生成はrebarDisplayへ委譲し、OFFではmeshをdisposeせず非表示だけにする。
 * 同じDocument/config generationなら再ON時の3D生成を省略する。
 */
import { eventBus } from '../../data/events/eventBus.js';
import { EditEvents, FinalizationEvents } from '../../constants/eventTypes.js';
import { applyColorModeToAllObjects } from '../../colorModes/applyColorMode.js';
import { setRebarGhostActive } from '../../colorModes/modelSourceMapping.js';
import { getRebarProjectDetailingRevision } from '../../config/rebarProjectDetailing.js';
import { incrementRebarPerformanceCounter } from '../../utils/rebarPerformanceMetrics.js';
import {
  invalidateAllRebarFactsCaches,
  invalidateRebarFactsCache,
} from '../../data/extractors/rebar3d/rebarFactsCache.js';
import editingSession from '../editing/editingSession.js';
import { getModelContext } from './modelContext.js';
import {
  collectRebarAnchorageChecks,
  resolveRebarFactsGenerationKey,
  setRebarDisplayVisible as baseSetRebarDisplayVisible,
  setRebarMemberVisible as baseSetRebarMemberVisible,
} from './rebarDisplay.js';
import { getRebarDisplayManager, requestRender, scene } from '../../viewer/index.js';

const MEMBER_KINDS = Object.freeze({
  column: ['main', 'hoop'],
  girder: ['main', 'hoop'],
  beam: ['main', 'hoop'],
  pile: ['main', 'hoop'],
  slab: ['main'],
  wall: ['main'],
  footing: ['main'],
  stripFooting: ['main'],
});
const SAFE_OPTION_KEYS = new Set(['coverMm', 'columnCoverMm', 'includeSupportFacts']);
const documentIds = new WeakMap();
let nextDocumentId = 1;
let initialized = false;
let onHiddenCallback = null;
const requestedMembers = new Map();

function groupKey(memberKey, kindKey) {
  return `${memberKey}.${kindKey}`;
}

function documentId(document) {
  if (!document || (typeof document !== 'object' && typeof document !== 'function')) return 'none';
  let id = documentIds.get(document);
  if (!id) {
    id = nextDocumentId;
    nextDocumentId += 1;
    documentIds.set(document, id);
  }
  return String(id);
}

function retainableOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  if (options.projectDetailing !== undefined) return false;
  return Object.keys(options).every((key) => SAFE_OPTION_KEYS.has(key));
}

function effectiveContext() {
  const context = getModelContext();
  const editing = editingSession.getState();
  if (!editing?.active || !editing.workingDocument) return context;
  return { ...context, modelADocument: editing.workingDocument, workingDocument: true };
}

export function resolveRebarMeshGenerationKey(
  context,
  options = {},
  memberKey = 'column',
  kindKey = 'main',
) {
  if (!retainableOptions(options)) return null;
  const token = (label, document) =>
    document
      ? `${label}:${documentId(document)}:${resolveRebarFactsGenerationKey(document, options)}`
      : `${label}:none`;
  return [
    `group:${groupKey(memberKey, kindKey)}`,
    `project:${getRebarProjectDetailingRevision()}`,
    token('A', context?.modelADocument),
    token('B', context?.modelBDocument),
  ].join('|');
}

function syncGhost(manager) {
  const active = manager.isAnyVisible();
  if (setRebarGhostActive(active)) {
    applyColorModeToAllObjects(active ? 'RebarGhostOn' : 'RebarGhostOff');
  }
  requestRender();
}

function canReuseMember(manager, context, options, memberKey) {
  const kinds = MEMBER_KINDS[memberKey];
  if (!kinds) return false;
  return kinds.every((kindKey) => {
    const key = groupKey(memberKey, kindKey);
    const generation = resolveRebarMeshGenerationKey(context, options, memberKey, kindKey);
    return generation && manager.hasMeshes(key) && manager.getGenerationKey(key) === generation;
  });
}

export function stampRebarMeshGeneration(
  manager,
  context,
  options,
  memberKey,
  kindKeys = MEMBER_KINDS[memberKey] || [],
) {
  const supportedKinds = MEMBER_KINDS[memberKey];
  if (!manager || !supportedKinds) return 0;

  let stamped = 0;
  for (const kindKey of kindKeys) {
    if (!supportedKinds.includes(kindKey)) continue;
    const key = groupKey(memberKey, kindKey);
    const generation = resolveRebarMeshGenerationKey(context, options, memberKey, kindKey);
    manager.setGenerationKey(key, generation);
    stamped += 1;
  }
  return stamped;
}

export function setRebarMemberVisible(visible, options = {}, memberKey = 'column') {
  const manager = getRebarDisplayManager(scene);
  if (!manager || !MEMBER_KINDS[memberKey]) return false;

  if (!visible) {
    requestedMembers.delete(memberKey);
    const result = baseSetRebarMemberVisible(false, options, memberKey);
    syncGhost(manager);
    return result;
  }

  requestedMembers.set(memberKey, options);
  const context = effectiveContext();
  if (canReuseMember(manager, context, options, memberKey)) {
    for (const kindKey of MEMBER_KINDS[memberKey]) {
      const key = groupKey(memberKey, kindKey);
      manager.setVisible(true, key);
      incrementRebarPerformanceCounter('mesh.retention.hit.count');
      incrementRebarPerformanceCounter(`mesh.retention.${key}.hit.count`);
    }
    syncGhost(manager);
    return true;
  }

  incrementRebarPerformanceCounter('mesh.retention.miss.count');
  const shown = baseSetRebarMemberVisible(true, options, memberKey);
  stampRebarMeshGeneration(manager, context, options, memberKey);
  syncGhost(manager);
  return shown;
}

export function setRebarDisplayVisible(visible, options = {}, kindKey = 'main') {
  const result = baseSetRebarDisplayVisible(visible, options, kindKey);
  if (visible) {
    const context = effectiveContext();
    const manager = getRebarDisplayManager(scene);
    for (const [memberKey, kinds] of Object.entries(MEMBER_KINDS)) {
      if (!kinds.includes(kindKey)) continue;
      requestedMembers.set(memberKey, options);
      stampRebarMeshGeneration(manager, context, options, memberKey, [kindKey]);
    }
  } else {
    for (const [memberKey, kinds] of Object.entries(MEMBER_KINDS)) {
      if (kinds.includes(kindKey)) requestedMembers.delete(memberKey);
    }
  }
  return result;
}

export function refreshVisibleRebarGroups() {
  let count = 0;
  for (const [memberKey, options] of [...requestedMembers.entries()]) {
    if (setRebarMemberVisible(true, options, memberKey)) count += 1;
  }
  return count;
}

export function initializeRebarDisplaySync(onHidden = null) {
  if (initialized) return;
  initialized = true;
  onHiddenCallback = onHidden;

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('rebar-detailing-choice-changed', () => {
      if (requestedMembers.size === 0) return;
      refreshVisibleRebarGroups();
    });
  }

  eventBus.on(FinalizationEvents.COMPLETED, () => {
    invalidateAllRebarFactsCaches();
    const manager = getRebarDisplayManager(scene);
    manager?.disposeMeshes();
    for (const [memberKey, options] of [...requestedMembers.entries()]) {
      const shown = setRebarMemberVisible(true, options, memberKey);
      if (!shown && onHiddenCallback) onHiddenCallback(memberKey);
    }
  });

  eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, ({ targetDocument } = {}) => {
    if (targetDocument) invalidateRebarFactsCache(targetDocument);
    if (!targetDocument || requestedMembers.size === 0) return;
    refreshVisibleRebarGroups();
  });
}

export { collectRebarAnchorageChecks, resolveRebarFactsGenerationKey };
