/**
 * @fileoverview Semantic Grip の表示と drag preview / commit を統制する。
 *
 * preview 中は Working Document を変更せず、Grip と補助線だけを移動する。
 * mouseup で初めて semantic target を CAD operation service の MOVE へ解決する。
 */

import * as THREE from 'three';

import { eventBus, EditEvents, SelectionEvents, ToastEvents } from '../../../data/events/index.js';
import { RenderableLifecycleEvents } from '../../../constants/renderableLifecycleEvents.js';
import { scheduleRender } from '../../../utils/renderScheduler.js';
import { scene, controls, getActiveCamera } from '../../../viewer/index.js';
import editingSession from '../../editing/editingSession.js';
import { createCadOperationService } from '../../editing/cadOperationService.js';
import { getSemanticGripsForSelections } from '../../editing/semanticGripProvider.js';
import { constrainPosition, createSnapEngine } from '../../editing/snapEngine.js';
import { getSelectedObjects } from '../interactionController.js';
import {
  createSemanticSelectionIdentity,
  semanticSelectionIdentityKey,
} from './semanticSelection.js';

const DEFAULT_GRIP_RADIUS_PX = 7;
const DEFAULT_SNAP_TOLERANCE_PX = 10;
const DRAG_EPSILON_SQ = 1e-12;

function isEditableIdentity(identity) {
  return identity && !['B', 'onlyB'].includes(identity.modelSource);
}

function pointerToNdc(event, canvas, target = new THREE.Vector2()) {
  const rect = canvas?.getBoundingClientRect?.();
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  target.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return target;
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

function updatePreviewLine(line, start, end) {
  if (!line?.geometry?.attributes?.position) return;
  const attribute = line.geometry.attributes.position;
  attribute.setXYZ(0, start.x, start.y, start.z);
  attribute.setXYZ(1, end.x, end.y, end.z);
  attribute.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

function createPreviewLine(start, material) {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, start]);
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 1001;
  line.frustumCulled = false;
  line.userData = { isHelper: true, isSemanticGripPreview: true };
  return line;
}

export function createSemanticGripInteractionController(dependencies = {}) {
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
    gripRadiusPx = DEFAULT_GRIP_RADIUS_PX,
    snapTolerancePx = DEFAULT_SNAP_TOLERANCE_PX,
    createSnapEngine: createSnapEngineFn = createSnapEngine,
  } = dependencies;
  const cadOperations = providedCadOperationService || createCadOperationService(session);

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const gripGeometry = new THREE.SphereGeometry(1, 12, 8);
  const gripMaterial = new THREE.MeshBasicMaterial({
    color: 0x1ba7e1,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  const activeGripMaterial = new THREE.MeshBasicMaterial({
    color: 0xffb300,
    depthTest: false,
    depthWrite: false,
  });
  const previewMaterial = new THREE.LineBasicMaterial({
    color: 0xffb300,
    depthTest: false,
    depthWrite: false,
  });

  const group = new THREE.Group();
  group.name = 'semanticEditGripGroup';
  group.renderOrder = 1000;
  group.userData = { isHelper: true, isSemanticEditGripGroup: true };
  targetScene?.add?.(group);

  let drag = null;
  let previousControlsEnabled = null;
  let lastSignature = null;
  let suppressNextClick = false;
  let snapEngineCache = null;

  function gripObjects() {
    return group.children.filter((object) => object?.userData?.isSemanticEditGrip === true);
  }

  function clearGripObjects() {
    for (const object of [...group.children]) {
      if (object?.userData?.isSemanticGripPreview) {
        object.geometry?.dispose?.();
      }
      group.remove(object);
    }
  }

  function selectedIdentities() {
    const result = new Map();
    for (const identity of getSelectedIdentities?.() || []) {
      if (!isEditableIdentity(identity)) continue;
      const key = semanticSelectionIdentityKey(identity);
      if (key && !result.has(key)) result.set(key, identity);
    }
    return [...result.values()];
  }

  function signature(state, identities) {
    return JSON.stringify([
      state?.sessionId || null,
      Number(state?.workingRevision || 0),
      identities.map(semanticSelectionIdentityKey),
    ]);
  }

  function updateGripScales() {
    const camera = getCamera?.();
    const canvas = getCanvas?.();
    if (!camera || !canvas) return;
    for (const object of gripObjects()) {
      const worldPerPixel = worldUnitsPerPixel(camera, object.position, canvas);
      object.scale.setScalar(Math.max(1e-6, worldPerPixel * gripRadiusPx));
    }
  }

  function refresh(options = {}) {
    if (drag) {
      updateGripScales();
      return gripObjects().length;
    }

    const state = session?.getState?.();
    if (!state?.active) {
      if (group.children.length > 0) {
        clearGripObjects();
        requestRender();
      }
      lastSignature = null;
      return 0;
    }

    const identities = selectedIdentities();
    const nextSignature = signature(state, identities);
    if (options.force !== true && nextSignature === lastSignature) {
      updateGripScales();
      return gripObjects().length;
    }

    clearGripObjects();
    const document = session.getWorkingDocument?.();
    const nodeMap = session.getWorkingNodeMap?.();
    const grips = getSemanticGripsForSelections(document, identities, { nodeMap });

    for (const grip of grips) {
      if (grip.behavior !== 'moveNode' || grip.target?.elementType !== 'Node') continue;
      const mesh = new THREE.Mesh(gripGeometry, gripMaterial);
      mesh.position.set(grip.position.x, grip.position.y, grip.position.z);
      mesh.renderOrder = 1000;
      mesh.frustumCulled = false;
      mesh.userData = {
        isHelper: true,
        isSemanticEditGrip: true,
        semanticGrip: grip,
      };
      group.add(mesh);
    }

    lastSignature = nextSignature;
    updateGripScales();
    requestRender();
    return gripObjects().length;
  }

  function setControlsEnabled(enabled) {
    const currentControls = getControls?.();
    if (!currentControls || typeof currentControls.enabled !== 'boolean') return;
    currentControls.enabled = enabled;
  }

  function disableControls() {
    const currentControls = getControls?.();
    previousControlsEnabled =
      currentControls && typeof currentControls.enabled === 'boolean'
        ? currentControls.enabled
        : null;
    if (previousControlsEnabled !== null) currentControls.enabled = false;
  }

  function restoreControls() {
    if (previousControlsEnabled !== null) setControlsEnabled(previousControlsEnabled);
    previousControlsEnabled = null;
  }

  function setRayFromPointer(event) {
    const camera = getCamera?.();
    const canvas = getCanvas?.();
    const ndc = pointerToNdc(event, canvas, pointerNdc);
    if (!camera || !ndc) return false;
    camera.updateMatrixWorld?.(true);
    raycaster.setFromCamera(ndc, camera);
    return true;
  }

  function getSnapEngine() {
    const state = session?.getState?.();
    if (!state?.active) return null;
    const cacheKey = `${state.sessionId || ''}:${Number(state.workingRevision || 0)}`;
    if (snapEngineCache?.key === cacheKey) return snapEngineCache.engine;

    const document = session.getWorkingDocument?.();
    if (!document) return null;
    const engine = createSnapEngineFn(document, { nodeMap: session.getWorkingNodeMap?.() });
    snapEngineCache = { key: cacheKey, engine };
    return engine;
  }

  function pickGrip(event) {
    refresh();
    if (!setRayFromPointer(event)) return null;
    return raycaster.intersectObjects(gripObjects(), false)[0] || null;
  }

  function intersectDragPlane(event) {
    if (!drag || !setRayFromPointer(event)) return null;
    return raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
  }

  function beginPointerDrag(event) {
    if (drag || event?.button !== 0) return false;
    const hit = pickGrip(event);
    const grip = hit?.object?.userData?.semanticGrip;
    const camera = getCamera?.();
    if (!hit || !grip || !camera) return false;

    const normal = camera.getWorldDirection(new THREE.Vector3());
    if (normal.lengthSq() <= DRAG_EPSILON_SQ) return false;
    const start = hit.object.position.clone();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), start);
    const previewLine = createPreviewLine(start, previewMaterial);
    group.add(previewLine);

    drag = {
      grip,
      object: hit.object,
      start,
      current: start.clone(),
      plane,
      previewLine,
      moved: false,
      axisLock: null,
      snapCandidate: null,
    };
    hit.object.material = activeGripMaterial;
    disableControls();
    suppressNextClick = true;
    requestRender();
    return true;
  }

  function updatePointerDrag(event) {
    if (!drag) return false;
    const rawPosition = intersectDragPlane(event);
    if (!rawPosition) return true;

    const constrained = constrainPosition(drag.start, rawPosition, {
      axis: drag.axisLock,
      ortho: !drag.axisLock && event?.shiftKey === true,
    });
    if (!constrained) return true;

    let finalPosition = constrained;
    drag.snapCandidate = null;

    // 明示 axis lock は拘束を最優先する。通常移動と Shift-Ortho では、
    // object snap が tolerance 内にある場合だけ exact snap を優先する。
    if (!drag.axisLock) {
      const camera = getCamera?.();
      const canvas = getCanvas?.();
      const tolerance =
        camera && canvas
          ? worldUnitsPerPixel(camera, constrained, canvas) * Math.max(0, snapTolerancePx)
          : 0;
      const candidate = getSnapEngine()?.resolve?.(constrained, {
        tolerance,
        excludeNodeIds: [drag.grip.target.elementId],
      });
      if (candidate?.position) {
        finalPosition = new THREE.Vector3(
          candidate.position.x,
          candidate.position.y,
          candidate.position.z,
        );
        drag.snapCandidate = candidate;
      }
    }

    drag.current.copy(finalPosition);
    drag.object.position.copy(finalPosition);
    drag.moved = drag.start.distanceToSquared(finalPosition) > DRAG_EPSILON_SQ;
    updatePreviewLine(drag.previewLine, drag.start, finalPosition);
    updateGripScales();
    requestRender();
    return true;
  }

  function setAxisConstraint(axis) {
    if (!drag) return false;
    const normalized = axis ? String(axis).toUpperCase() : null;
    if (normalized !== null && !['X', 'Y', 'Z'].includes(normalized)) return false;
    drag.axisLock = drag.axisLock === normalized ? null : normalized;
    drag.snapCandidate = null;
    requestRender();
    return true;
  }

  function finishDragVisuals({ restoreStart = false } = {}) {
    if (!drag) return null;
    const finished = drag;
    if (restoreStart) finished.object.position.copy(finished.start);
    finished.object.material = gripMaterial;
    if (finished.previewLine) {
      group.remove(finished.previewLine);
      finished.previewLine.geometry?.dispose?.();
    }
    drag = null;
    restoreControls();
    return finished;
  }

  function commitPointerDrag(event) {
    if (!drag) return null;
    if (event) updatePointerDrag(event);
    const finalPosition = drag.current.clone();
    const moved = drag.moved;
    const grip = drag.grip;
    finishDragVisuals({ restoreStart: !moved });
    lastSignature = null;

    if (!moved) {
      refresh({ force: true });
      requestRender();
      return { changed: false, reason: 'no-op' };
    }

    try {
      const result = cadOperations.moveNodesToPositions([
        {
          nodeId: grip.target.elementId,
          position: {
            x: finalPosition.x,
            y: finalPosition.y,
            z: finalPosition.z,
          },
        },
      ]);
      refresh({ force: true });
      return result;
    } catch (error) {
      refresh({ force: true });
      onCommitError(error, grip);
      return { changed: false, error };
    }
  }

  function cancelPointerDrag() {
    if (!drag) return false;
    finishDragVisuals({ restoreStart: true });
    lastSignature = null;
    refresh({ force: true });
    requestRender();
    return true;
  }

  function consumeClickSuppression() {
    const value = suppressNextClick;
    suppressNextClick = false;
    return value;
  }

  function dispose() {
    cancelPointerDrag();
    clearGripObjects();
    targetScene?.remove?.(group);
    gripGeometry.dispose();
    gripMaterial.dispose();
    activeGripMaterial.dispose();
    previewMaterial.dispose();
  }

  return {
    refresh,
    beginPointerDrag,
    updatePointerDrag,
    commitPointerDrag,
    cancelPointerDrag,
    consumeClickSuppression,
    setAxisConstraint,
    isDragging: () => Boolean(drag),
    getActiveAxisConstraint: () => drag?.axisLock || null,
    getActiveSnapCandidate: () => drag?.snapCandidate || null,
    getGripObjects: () => [...gripObjects()],
    getGroup: () => group,
    dispose,
  };
}

let runtimeController = null;
let runtimeRemovers = [];
let runtimeCanvas = null;
let runtimeHandlers = null;

function stopGripPointerEvent(event) {
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

function runtimeSelectedIdentities() {
  return getSelectedObjects()
    .map((object) => createSemanticSelectionIdentity(object?.userData))
    .filter(Boolean);
}

export function initSemanticGripInteraction() {
  if (runtimeController) return runtimeController;
  const canvas = document.getElementById('three-canvas');
  if (!canvas) return null;

  runtimeCanvas = canvas;
  runtimeController = createSemanticGripInteractionController({
    scene,
    getCamera: () => getActiveCamera(),
    getCanvas: () => runtimeCanvas,
    getSelectedIdentities: runtimeSelectedIdentities,
    editingSession,
    getControls: () => controls,
    requestRender: scheduleRender,
    onCommitError: (error) => {
      eventBus.emit(ToastEvents.SHOW_ERROR, {
        message: `Grip編集を確定できませんでした: ${error?.message || error}`,
      });
    },
  });

  const onCanvasMove = () => runtimeController?.refresh();
  const onMouseDown = (event) => {
    if (runtimeController?.beginPointerDrag(event)) stopGripPointerEvent(event);
  };
  const onWindowMove = (event) => {
    if (!runtimeController?.isDragging()) return;
    runtimeController.updatePointerDrag(event);
    stopGripPointerEvent(event);
  };
  const onWindowUp = (event) => {
    if (event.button !== 0 || !runtimeController?.isDragging()) return;
    runtimeController.commitPointerDrag(event);
    stopGripPointerEvent(event);
  };
  const onClick = (event) => {
    if (runtimeController?.consumeClickSuppression()) stopGripPointerEvent(event);
  };
  const onKeyDown = (event) => {
    if (!runtimeController?.isDragging()) return;
    if (event.key === 'Escape') {
      runtimeController.cancelPointerDrag();
      stopGripPointerEvent(event);
      return;
    }
    if (/^[xyz]$/i.test(event.key)) {
      runtimeController.setAxisConstraint(event.key);
      stopGripPointerEvent(event);
    }
  };
  const onBlur = () => runtimeController?.cancelPointerDrag();

  runtimeHandlers = {
    onCanvasMove,
    onMouseDown,
    onWindowMove,
    onWindowUp,
    onClick,
    onKeyDown,
    onBlur,
  };

  canvas.addEventListener('mousemove', onCanvasMove, true);
  canvas.addEventListener('mousedown', onMouseDown, true);
  canvas.addEventListener('click', onClick, true);
  window.addEventListener('mousemove', onWindowMove, true);
  window.addEventListener('mouseup', onWindowUp, true);
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

export function refreshSemanticEditGrips(options = {}) {
  return runtimeController?.refresh(options) ?? 0;
}

export function resetSemanticGripInteraction() {
  for (const remove of runtimeRemovers) remove();
  runtimeRemovers = [];

  if (runtimeCanvas && runtimeHandlers) {
    runtimeCanvas.removeEventListener('mousemove', runtimeHandlers.onCanvasMove, true);
    runtimeCanvas.removeEventListener('mousedown', runtimeHandlers.onMouseDown, true);
    runtimeCanvas.removeEventListener('click', runtimeHandlers.onClick, true);
    window.removeEventListener('mousemove', runtimeHandlers.onWindowMove, true);
    window.removeEventListener('mouseup', runtimeHandlers.onWindowUp, true);
    window.removeEventListener('keydown', runtimeHandlers.onKeyDown, true);
    window.removeEventListener('blur', runtimeHandlers.onBlur, true);
  }

  runtimeController?.dispose();
  runtimeController = null;
  runtimeCanvas = null;
  runtimeHandlers = null;
}
