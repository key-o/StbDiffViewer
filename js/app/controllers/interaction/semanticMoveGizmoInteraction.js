/**
 * @fileoverview ST-Bridge semantic MOVE 用 X/Y/Z Transform gizmo を統制する。
 *
 * TransformControls は入力と preview に限定し、Object3D transform を編集正本にしない。
 * mouseup 時だけ cadOperationService.moveNodesByVector() へ解決し、Working Document を更新する。
 */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { RenderableLifecycleEvents } from '../../../constants/renderableLifecycleEvents.js';
import { eventBus, EditEvents, SelectionEvents, ToastEvents } from '../../../data/events/index.js';
import { scheduleRender } from '../../../utils/renderScheduler.js';
import { controls, getActiveCamera, scene } from '../../../viewer/index.js';
import { createCadOperationService } from '../../editing/cadOperationService.js';
import editingSession from '../../editing/editingSession.js';
import { getSemanticGripsForSelections } from '../../editing/semanticGripProvider.js';
import { createSnapEngine } from '../../editing/snapEngine.js';
import { getSelectedObjects } from '../interactionController.js';
import {
  createSemanticSelectionIdentity,
  semanticSelectionIdentityKey,
} from './semanticSelection.js';

const AXIS_KEYS = Object.freeze({ X: 'x', Y: 'y', Z: 'z' });
const DEFAULT_SNAP_TOLERANCE_PX = 10;
const DELTA_EPSILON_SQ = 1e-12;

function isModelBIdentity(identity) {
  return identity && ['B', 'onlyB'].includes(identity.modelSource);
}

function normalizeIdentities(identities) {
  const result = new Map();
  for (const identity of Array.isArray(identities) ? identities : []) {
    const key = semanticSelectionIdentityKey(identity);
    if (key && !result.has(key)) result.set(key, identity);
  }
  return [...result.values()];
}

function finitePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const position = {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z),
  };
  return Object.values(position).every(Number.isFinite) ? position : null;
}

function resolveMoveTargets(document, nodeMap, identities) {
  const targets = new Map();
  for (const grip of getSemanticGripsForSelections(document, identities, { nodeMap })) {
    if (grip.behavior !== 'moveNode' || grip.target?.elementType !== 'Node') continue;
    const position = finitePosition(grip.position);
    if (!position) continue;
    const nodeId = String(grip.target.elementId);
    if (!targets.has(nodeId)) targets.set(nodeId, { nodeId, position });
  }
  return [...targets.values()];
}

function centroid(targets) {
  if (!targets.length) return null;
  const sum = targets.reduce(
    (value, target) => {
      value.x += target.position.x;
      value.y += target.position.y;
      value.z += target.position.z;
      return value;
    },
    { x: 0, y: 0, z: 0 },
  );
  const count = targets.length;
  return new THREE.Vector3(sum.x / count, sum.y / count, sum.z / count);
}

function worldUnitsPerPixel(camera, point, canvas) {
  const rect = canvas?.getBoundingClientRect?.();
  const heightPx = Math.max(1, Number(rect?.height || canvas?.clientHeight || 1));
  if (camera?.isPerspectiveCamera) {
    const distance = Math.max(1e-9, camera.position.distanceTo(point));
    const fov = THREE.MathUtils.degToRad(camera.fov || 50);
    return (2 * Math.tan(fov / 2) * distance) / heightPx;
  }
  if (camera?.isOrthographicCamera) {
    const zoom = Number(camera.zoom) || 1;
    return Math.abs(camera.top - camera.bottom) / zoom / heightPx;
  }
  return 1;
}

function createPreviewMarker(geometry, material, position) {
  const marker = new THREE.Mesh(geometry, material);
  marker.position.set(position.x, position.y, position.z);
  marker.renderOrder = 1002;
  marker.frustumCulled = false;
  marker.userData = { isHelper: true, isSemanticMoveGizmoPreview: true };
  return marker;
}

export function createSemanticMoveGizmoController(dependencies = {}) {
  const {
    scene: targetScene,
    getCamera,
    getCanvas,
    getSelectedIdentities,
    editingSession: session,
    cadOperationService: providedCadOperationService,
    getControls = () => null,
    requestRender = () => {},
    onCommitError = () => {},
    snapTolerancePx = DEFAULT_SNAP_TOLERANCE_PX,
    createSnapEngine: createSnapEngineFn = createSnapEngine,
    createTransformControls = (camera, canvas) => new TransformControls(camera, canvas),
  } = dependencies;

  const camera = getCamera?.();
  const canvas = getCanvas?.();
  if (!camera || !canvas) throw new Error('MOVE gizmo の camera / canvas が利用できません。');

  const cadOperations = providedCadOperationService || createCadOperationService(session);
  const proxy = new THREE.Object3D();
  proxy.name = 'semanticMoveGizmoProxy';
  proxy.userData = { isHelper: true, isSemanticMoveGizmoProxy: true };
  targetScene?.add?.(proxy);

  const transformControl = createTransformControls(camera, canvas);
  const transformHelper = transformControl.getHelper?.() || transformControl;
  if (transformHelper !== proxy) targetScene?.add?.(transformHelper);
  transformControl.setMode?.('translate');
  transformControl.setSpace?.('world');

  const previewGeometry = new THREE.SphereGeometry(1, 10, 8);
  const previewMaterial = new THREE.MeshBasicMaterial({
    color: 0xffb300,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.6,
  });
  const previewGroup = new THREE.Group();
  previewGroup.name = 'semanticMoveGizmoPreviewGroup';
  previewGroup.userData = { isHelper: true, isSemanticMoveGizmoPreviewGroup: true };
  targetScene?.add?.(previewGroup);

  let targets = [];
  let selectionIdentities = [];
  let lastSignature = null;
  let drag = null;
  let previousControlsEnabled = null;
  let snapEngineCache = null;
  let suppressNextClick = false;
  let syncingProxy = false;
  let mixedSelectionBlocked = false;

  function setVisible(visible) {
    transformHelper.visible = Boolean(visible);
    proxy.visible = Boolean(visible);
    if (!visible) transformControl.detach?.();
  }

  function clearPreview() {
    previewGroup.clear();
  }

  function updatePreview(delta) {
    if (!drag) return;
    if (previewGroup.children.length !== drag.targets.length) {
      clearPreview();
      for (const target of drag.targets) {
        previewGroup.add(createPreviewMarker(previewGeometry, previewMaterial, target.position));
      }
    }
    drag.targets.forEach((target, index) => {
      previewGroup.children[index]?.position.set(
        target.position.x + delta.x,
        target.position.y + delta.y,
        target.position.z + delta.z,
      );
    });
  }

  function selectionSignature(state, identities) {
    return JSON.stringify([
      state?.sessionId || null,
      Number(state?.workingRevision || 0),
      identities.map(semanticSelectionIdentityKey),
    ]);
  }

  function getSnapEngine() {
    const state = session?.getState?.();
    if (!state?.active) return null;
    const key = `${state.sessionId || ''}:${Number(state.workingRevision || 0)}`;
    if (snapEngineCache?.key === key) return snapEngineCache.engine;
    const document = session.getWorkingDocument?.();
    if (!document) return null;
    const engine = createSnapEngineFn(document, { nodeMap: session.getWorkingNodeMap?.() });
    snapEngineCache = { key, engine };
    return engine;
  }

  function restoreControls() {
    const currentControls = getControls?.();
    if (
      previousControlsEnabled !== null &&
      currentControls &&
      typeof currentControls.enabled === 'boolean'
    ) {
      currentControls.enabled = previousControlsEnabled;
    }
    previousControlsEnabled = null;
  }

  function disableControls() {
    const currentControls = getControls?.();
    previousControlsEnabled =
      currentControls && typeof currentControls.enabled === 'boolean'
        ? currentControls.enabled
        : null;
    if (previousControlsEnabled !== null) currentControls.enabled = false;
  }

  function currentAxis() {
    const axis = String(transformControl.axis || '').toUpperCase();
    return AXIS_KEYS[axis] ? axis : null;
  }

  function applyProxyDelta(delta) {
    if (!drag) return;
    syncingProxy = true;
    proxy.position.set(
      drag.startAnchor.x + delta.x,
      drag.startAnchor.y + delta.y,
      drag.startAnchor.z + delta.z,
    );
    syncingProxy = false;
    drag.currentDelta.copy(delta);
    updatePreview(delta);
    requestRender();
  }

  function snapDeltaAlongAxis(rawDelta, axis) {
    const key = AXIS_KEYS[axis];
    if (!key) return { delta: rawDelta, candidate: null };
    const engine = getSnapEngine();
    const cameraNow = getCamera?.();
    const canvasNow = getCanvas?.();
    if (!engine || !cameraNow || !canvasNow) return { delta: rawDelta, candidate: null };

    const excludeNodeIds = drag.targets.map((target) => target.nodeId);
    let best = null;
    for (const target of drag.targets) {
      const rawTarget = new THREE.Vector3(
        target.position.x + rawDelta.x,
        target.position.y + rawDelta.y,
        target.position.z + rawDelta.z,
      );
      const tolerance =
        worldUnitsPerPixel(cameraNow, rawTarget, canvasNow) * Math.max(0, snapTolerancePx);
      const candidate = engine.resolve?.(rawTarget, { tolerance, excludeNodeIds });
      const candidatePosition = finitePosition(candidate?.position);
      if (!candidatePosition) continue;
      const snappedAxisDelta = candidatePosition[key] - target.position[key];
      const adjustment = Math.abs(snappedAxisDelta - rawDelta[key]);
      if (!best || adjustment < best.adjustment) {
        best = {
          candidate: { ...candidate, sourceNodeId: target.nodeId },
          axisDelta: snappedAxisDelta,
          adjustment,
        };
      }
    }

    if (!best) return { delta: rawDelta, candidate: null };
    const snapped = rawDelta.clone();
    snapped[key] = best.axisDelta;
    return { delta: snapped, candidate: best.candidate };
  }

  function refresh(options = {}) {
    if (drag) return targets.length;
    const state = session?.getState?.();
    if (!state?.active) {
      targets = [];
      selectionIdentities = [];
      mixedSelectionBlocked = false;
      lastSignature = null;
      setVisible(false);
      clearPreview();
      requestRender();
      return 0;
    }

    const identities = normalizeIdentities(getSelectedIdentities?.());
    mixedSelectionBlocked = identities.some(isModelBIdentity);
    if (mixedSelectionBlocked || identities.length === 0) {
      targets = [];
      selectionIdentities = [];
      lastSignature = selectionSignature(state, identities);
      setVisible(false);
      clearPreview();
      requestRender();
      return 0;
    }

    const signature = selectionSignature(state, identities);
    if (options.force !== true && signature === lastSignature) return targets.length;

    const document = session.getWorkingDocument?.();
    const nodeMap = session.getWorkingNodeMap?.();
    targets = resolveMoveTargets(document, nodeMap, identities);
    selectionIdentities = identities.map((identity) => ({ ...identity }));
    lastSignature = signature;
    clearPreview();

    const anchor = centroid(targets);
    if (!anchor) {
      setVisible(false);
      requestRender();
      return 0;
    }

    const cameraNow = getCamera?.();
    if (cameraNow) transformControl.camera = cameraNow;
    proxy.position.copy(anchor);
    transformControl.attach?.(proxy);
    transformControl.setMode?.('translate');
    transformControl.setSpace?.('world');
    setVisible(true);
    requestRender();
    return targets.length;
  }

  function beginDrag() {
    if (drag || targets.length === 0 || mixedSelectionBlocked) return false;
    const state = session?.getState?.();
    if (!state?.active) return false;

    drag = {
      sessionId: state.sessionId || null,
      workingRevision: Number(state.workingRevision || 0),
      startAnchor: proxy.position.clone(),
      currentDelta: new THREE.Vector3(),
      axis: currentAxis(),
      snapCandidate: null,
      targets: targets.map((target) => ({
        nodeId: target.nodeId,
        position: { ...target.position },
      })),
      selections: selectionIdentities.map((identity) => ({ ...identity })),
      followRelatedNodes:
        typeof session?.getMoveFollowRelatedNodes === 'function'
          ? session.getMoveFollowRelatedNodes()
          : state.moveFollowRelatedNodes !== false,
    };
    disableControls();
    updatePreview(drag.currentDelta);
    requestRender();
    return true;
  }

  function updateDrag() {
    if (!drag || syncingProxy) return false;
    const axis = currentAxis();
    drag.axis = axis;
    if (!axis) {
      drag.snapCandidate = null;
      applyProxyDelta(new THREE.Vector3());
      return true;
    }

    const key = AXIS_KEYS[axis];
    const rawDelta = new THREE.Vector3();
    rawDelta[key] = proxy.position[key] - drag.startAnchor[key];
    const snapped = snapDeltaAlongAxis(rawDelta, axis);
    drag.snapCandidate = snapped.candidate;
    applyProxyDelta(snapped.delta);
    return true;
  }

  function finishDragVisuals() {
    clearPreview();
    restoreControls();
    suppressNextClick = true;
    requestRender();
  }

  function failCommit(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    onCommitError(failure);
    finishDragVisuals();
    drag = null;
    lastSignature = null;
    refresh({ force: true });
    return { changed: false, error: failure };
  }

  function commitDrag() {
    if (!drag) return null;
    updateDrag();
    const pending = drag;
    const state = session?.getState?.();
    if (
      !state?.active ||
      (state.sessionId || null) !== pending.sessionId ||
      Number(state.workingRevision || 0) !== pending.workingRevision
    ) {
      return failCommit(new Error('MOVE gizmo 操作中に Working Session が変更されました。'));
    }

    const delta = pending.currentDelta.clone();
    const nodeIds = pending.targets.map((target) => target.nodeId);
    finishDragVisuals();
    drag = null;
    lastSignature = null;

    if (delta.lengthSq() <= DELTA_EPSILON_SQ) {
      refresh({ force: true });
      return { changed: false, reason: 'no-op' };
    }

    try {
      const result = cadOperations.moveSelectionsByVector(
        pending.selections,
        { x: delta.x, y: delta.y, z: delta.z },
        {
          followRelatedNodes: pending.followRelatedNodes,
          label: pending.followRelatedNodes
            ? `MOVE gizmo Node ${nodeIds.length}件`
            : `MOVE gizmo (節点固定) ${pending.selections.length}要素`,
          reason: 'cadMoveGizmo',
        },
      );
      refresh({ force: true });
      return result;
    } catch (error) {
      onCommitError(error);
      refresh({ force: true });
      return { changed: false, error };
    }
  }

  function cancelDrag() {
    if (!drag) return false;
    const startAnchor = drag.startAnchor.clone();
    syncingProxy = true;
    transformControl.reset?.();
    proxy.position.copy(startAnchor);
    syncingProxy = false;
    if ('dragging' in transformControl) transformControl.dragging = false;
    if ('axis' in transformControl) transformControl.axis = null;
    drag = null;
    finishDragVisuals();
    lastSignature = null;
    refresh({ force: true });
    return true;
  }

  function consumeClickSuppression() {
    const value = suppressNextClick;
    suppressNextClick = false;
    return value;
  }

  const onMouseDown = () => beginDrag();
  const onObjectChange = () => updateDrag();
  const onMouseUp = () => commitDrag();
  transformControl.addEventListener?.('mouseDown', onMouseDown);
  transformControl.addEventListener?.('objectChange', onObjectChange);
  transformControl.addEventListener?.('mouseUp', onMouseUp);

  setVisible(false);

  function dispose() {
    cancelDrag();
    transformControl.removeEventListener?.('mouseDown', onMouseDown);
    transformControl.removeEventListener?.('objectChange', onObjectChange);
    transformControl.removeEventListener?.('mouseUp', onMouseUp);
    transformControl.detach?.();
    transformControl.dispose?.();
    clearPreview();
    previewGeometry.dispose();
    previewMaterial.dispose();
    targetScene?.remove?.(previewGroup);
    targetScene?.remove?.(proxy);
    if (transformHelper !== proxy) targetScene?.remove?.(transformHelper);
  }

  return {
    refresh,
    beginDrag,
    updateDrag,
    commitDrag,
    cancelDrag,
    consumeClickSuppression,
    isDragging: () => Boolean(drag),
    isMixedSelectionBlocked: () => mixedSelectionBlocked,
    getTargets: () => targets.map((target) => ({ ...target, position: { ...target.position } })),
    getActiveAxis: () => drag?.axis || null,
    getActiveSnapCandidate: () => drag?.snapCandidate || null,
    getProxy: () => proxy,
    getPreviewObjects: () => [...previewGroup.children],
    getTransformControl: () => transformControl,
    dispose,
  };
}

let runtimeController = null;
let runtimeRemovers = [];
let runtimeCanvas = null;
let runtimeHandlers = null;

function runtimeSelectedIdentities() {
  return getSelectedObjects()
    .map((object) => createSemanticSelectionIdentity(object?.userData))
    .filter(Boolean);
}

function stopGizmoFollowupEvent(event) {
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

export function initSemanticMoveGizmoInteraction() {
  if (runtimeController) return runtimeController;
  const canvas = document.getElementById('three-canvas');
  if (!canvas) return null;

  runtimeCanvas = canvas;
  runtimeController = createSemanticMoveGizmoController({
    scene,
    getCamera: () => getActiveCamera(),
    getCanvas: () => runtimeCanvas,
    getSelectedIdentities: runtimeSelectedIdentities,
    editingSession,
    getControls: () => controls,
    requestRender: scheduleRender,
    onCommitError: (error) => {
      eventBus.emit(ToastEvents.SHOW_ERROR, {
        message: `MOVE gizmo を確定できませんでした: ${error?.message || error}`,
      });
    },
  });

  const onMouseDown = (event) => {
    if (runtimeController?.isDragging()) stopGizmoFollowupEvent(event);
  };
  const onClick = (event) => {
    if (runtimeController?.consumeClickSuppression()) stopGizmoFollowupEvent(event);
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && runtimeController?.isDragging()) {
      runtimeController.cancelDrag();
      stopGizmoFollowupEvent(event);
    }
  };
  const onPointerCancel = () => runtimeController?.cancelDrag();
  const onBlur = () => runtimeController?.cancelDrag();

  runtimeHandlers = { onMouseDown, onClick, onKeyDown, onPointerCancel, onBlur };
  canvas.addEventListener('mousedown', onMouseDown, true);
  canvas.addEventListener('click', onClick, true);
  canvas.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur, true);

  const refresh = () => runtimeController?.refresh({ force: true });
  runtimeRemovers = [
    eventBus.on(SelectionEvents.ELEMENT_SELECTED, refresh),
    eventBus.on(SelectionEvents.MULTI_SELECT, refresh),
    eventBus.on(SelectionEvents.SELECTION_CLEARED, refresh),
    eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, refresh),
    eventBus.on(EditEvents.MODE_TOGGLED, refresh),
    eventBus.on(RenderableLifecycleEvents.RENDERABLES_REPLACED, refresh),
  ].filter((remove) => typeof remove === 'function');

  runtimeController.refresh({ force: true });
  return runtimeController;
}

export function refreshSemanticMoveGizmo(options = {}) {
  return runtimeController?.refresh(options) ?? 0;
}

export function resetSemanticMoveGizmoInteraction() {
  for (const remove of runtimeRemovers) remove();
  runtimeRemovers = [];

  if (runtimeCanvas && runtimeHandlers) {
    runtimeCanvas.removeEventListener('mousedown', runtimeHandlers.onMouseDown, true);
    runtimeCanvas.removeEventListener('click', runtimeHandlers.onClick, true);
    runtimeCanvas.removeEventListener('pointercancel', runtimeHandlers.onPointerCancel, true);
    window.removeEventListener('keydown', runtimeHandlers.onKeyDown, true);
    window.removeEventListener('blur', runtimeHandlers.onBlur, true);
  }

  runtimeController?.dispose();
  runtimeController = null;
  runtimeCanvas = null;
  runtimeHandlers = null;
}
