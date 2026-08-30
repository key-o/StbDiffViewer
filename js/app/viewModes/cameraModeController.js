/**
 * @fileoverview Camera mode controller
 *
 * This module keeps the UI state for:
 * - display context: solid view / drawing view
 * - solid projection: perspective / orthographic
 * - drawing directions: top / front / right / left / iso
 */

import { CAMERA_CONTEXTS, CAMERA_MODES } from '../../constants/displayModes.js';
import {
  getCameraContext,
  getCameraMode,
  setCameraContext,
  setCameraMode,
  setView,
} from '../../viewer/index.js';
import { setStbExportPanelVisibility } from '../controllers/dxfLoader.js';
import { createLogger } from '../../utils/logger.js';
import { getModelContext } from './modelContext.js';
import { eventBus } from '../../data/events/eventBus.js';
import { ViewEvents, AxisEvents } from '../../constants/eventTypes.js';
import { getState } from '../../data/state/globalState.js';

const log = createLogger('cameraModeController');

const ORTHOGRAPHIC_VIEWS = {
  PLAN: 'top',
  ISOMETRIC: 'iso',
};

let currentSolidProjectionMode = CAMERA_MODES.PERSPECTIVE;
let currentDrawingView = ORTHOGRAPHIC_VIEWS.PLAN;

function emitAxisRedraw(targetStoryId, is2DMode) {
  const stories = getState('models.stories') || [];
  const axesData = getState('models.axesData') || { xAxes: [], yAxes: [] };
  const modelBounds = getState('models.modelBounds') || null;
  if (!axesData.xAxes?.length && !axesData.yAxes?.length) return;

  const labelCheckbox = document.getElementById('toggleLabel-Axis');
  const labelToggle = labelCheckbox ? labelCheckbox.checked : true;

  const dimCheckbox = document.getElementById('showAxisDimensions');
  const showDimensions = dimCheckbox ? dimCheckbox.checked : false;

  eventBus.emit(AxisEvents.REDRAW_REQUESTED, {
    axesData,
    stories,
    modelBounds,
    labelToggle,
    showDimensions,
    targetStoryId,
    is2DMode,
  });
}

function emitCameraModeChanged(mode, context) {
  eventBus.emit(ViewEvents.CAMERA_MODE_CHANGED, {
    mode,
    context,
    isDrawingMode: context === CAMERA_CONTEXTS.DRAWING,
  });
}

function setOrthographicView(view) {
  const { modelBounds } = getModelContext();
  setView(view, modelBounds);
}

function syncPrimaryModeButtons(context) {
  const isSolid = context === CAMERA_CONTEXTS.SOLID;

  const cameraPerspectiveBtn = document.getElementById('cameraPerspectiveBtn');
  const cameraOrthographicBtn = document.getElementById('cameraOrthographicBtn');
  if (cameraPerspectiveBtn) {
    cameraPerspectiveBtn.classList.toggle('active', isSolid);
  }
  if (cameraOrthographicBtn) {
    cameraOrthographicBtn.classList.toggle('active', !isSolid);
  }

  const viewModePerspectiveBtn = document.getElementById('viewModePerspectiveBtn');
  const viewModeOrthographicBtn = document.getElementById('viewModeOrthographicBtn');
  if (viewModePerspectiveBtn) {
    viewModePerspectiveBtn.classList.toggle('active', isSolid);
  }
  if (viewModeOrthographicBtn) {
    viewModeOrthographicBtn.classList.toggle('active', !isSolid);
  }

  const cameraPerspective = document.getElementById('cameraPerspective');
  const cameraOrthographic = document.getElementById('cameraOrthographic');
  if (cameraPerspective) {
    cameraPerspective.checked = isSolid;
  }
  if (cameraOrthographic) {
    cameraOrthographic.checked = !isSolid;
  }
}

function syncSolidProjectionButtons(mode) {
  const perspectiveBtn = document.getElementById('solidProjectionPerspectiveBtn');
  const orthographicBtn = document.getElementById('solidProjectionOrthographicBtn');
  const isPerspective = mode === CAMERA_MODES.PERSPECTIVE;

  if (perspectiveBtn) {
    perspectiveBtn.classList.toggle('active', isPerspective);
  }
  if (orthographicBtn) {
    orthographicBtn.classList.toggle('active', !isPerspective);
  }
}

function syncViewDirectionButtons(viewType) {
  const viewDirectionButtons = document.getElementById('viewDirectionButtons');
  const panelBtns = viewDirectionButtons?.querySelectorAll('.view-dir-btn');
  if (panelBtns) {
    panelBtns.forEach((button) => button.classList.remove('active'));
    const activeBtn = viewDirectionButtons?.querySelector(`.view-dir-btn[data-view="${viewType}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }

  const floatBtns = document.querySelectorAll('#viewDirectionPanel button[data-view]');
  floatBtns.forEach((button) => button.classList.remove('active'));
  const floatActiveBtn = document.querySelector(
    `#viewDirectionPanel button[data-view="${viewType}"]`,
  );
  if (floatActiveBtn) floatActiveBtn.classList.add('active');
}

function syncSubPanels(context) {
  const solidProjectionButtons = document.getElementById('solidProjectionButtons');
  const viewDirectionButtons = document.getElementById('viewDirectionButtons');
  const viewDirectionPanel = document.getElementById('viewDirectionPanel');
  const isSolid = context === CAMERA_CONTEXTS.SOLID;

  if (solidProjectionButtons) {
    solidProjectionButtons.classList.toggle('hidden', !isSolid);
  }
  if (viewDirectionButtons) {
    viewDirectionButtons.classList.toggle('hidden', isSolid);
  }
  if (viewDirectionPanel) {
    viewDirectionPanel.classList.toggle('hidden', isSolid);
  }
}

function syncUiState(context = getCameraContext()) {
  syncPrimaryModeButtons(context);
  syncSolidProjectionButtons(currentSolidProjectionMode);
  syncSubPanels(context);
  syncViewDirectionButtons(context === CAMERA_CONTEXTS.DRAWING ? currentDrawingView : null);
}

function switchToSolidDisplay(scheduleRender, projectionMode = currentSolidProjectionMode) {
  const previousContext = getCameraContext();
  currentSolidProjectionMode =
    projectionMode === CAMERA_MODES.ORTHOGRAPHIC
      ? CAMERA_MODES.ORTHOGRAPHIC
      : CAMERA_MODES.PERSPECTIVE;

  setCameraContext(CAMERA_CONTEXTS.SOLID);
  setCameraMode(currentSolidProjectionMode);

  if (previousContext === CAMERA_CONTEXTS.DRAWING) {
    setOrthographicView(ORTHOGRAPHIC_VIEWS.ISOMETRIC);
  }

  syncUiState(CAMERA_CONTEXTS.SOLID);
  emitCameraModeChanged(currentSolidProjectionMode, CAMERA_CONTEXTS.SOLID);
  setStbExportPanelVisibility(false);
  emitAxisRedraw('all', false);
  scheduleRender();
}

function switchToDrawingDisplay(scheduleRender, viewType = currentDrawingView) {
  currentDrawingView = viewType || ORTHOGRAPHIC_VIEWS.PLAN;

  setCameraContext(CAMERA_CONTEXTS.DRAWING);
  setCameraMode(CAMERA_MODES.ORTHOGRAPHIC);
  setOrthographicView(currentDrawingView);

  syncUiState(CAMERA_CONTEXTS.DRAWING);
  emitCameraModeChanged(CAMERA_MODES.ORTHOGRAPHIC, CAMERA_CONTEXTS.DRAWING);
  setStbExportPanelVisibility(true);
  emitAxisRedraw('all', true);
  scheduleRender();
}

function updateDrawingView(scheduleRender, viewType) {
  currentDrawingView = viewType;
  syncUiState(CAMERA_CONTEXTS.DRAWING);
  setOrthographicView(viewType);
  scheduleRender();
}

function initializeLocalState() {
  const context = getCameraContext();
  const mode = getCameraMode();

  if (context === CAMERA_CONTEXTS.SOLID) {
    currentSolidProjectionMode =
      mode === CAMERA_MODES.ORTHOGRAPHIC ? CAMERA_MODES.ORTHOGRAPHIC : CAMERA_MODES.PERSPECTIVE;
  }
}

export function setupCameraModeListeners(scheduleRender) {
  log.debug('[setupCameraModeListeners] Initializing camera mode listeners');

  initializeLocalState();

  const cameraPerspective = document.getElementById('cameraPerspective');
  const cameraOrthographic = document.getElementById('cameraOrthographic');
  const cameraPerspectiveBtn = document.getElementById('cameraPerspectiveBtn');
  const cameraOrthographicBtn = document.getElementById('cameraOrthographicBtn');
  const viewModePerspectiveBtn = document.getElementById('viewModePerspectiveBtn');
  const viewModeOrthographicBtn = document.getElementById('viewModeOrthographicBtn');
  const solidProjectionPerspectiveBtn = document.getElementById('solidProjectionPerspectiveBtn');
  const solidProjectionOrthographicBtn = document.getElementById('solidProjectionOrthographicBtn');

  const hasRadioButtons = cameraPerspective && cameraOrthographic;
  const hasFloatingButtons = cameraPerspectiveBtn && cameraOrthographicBtn;
  const hasPanelButtons = viewModePerspectiveBtn && viewModeOrthographicBtn;

  if (!hasRadioButtons && !hasFloatingButtons && !hasPanelButtons) {
    log.warn('[setupCameraModeListeners] No camera mode buttons found in DOM');
    return;
  }

  if (hasFloatingButtons) {
    cameraPerspectiveBtn.addEventListener('click', () => {
      switchToSolidDisplay(scheduleRender);
    });

    cameraOrthographicBtn.addEventListener('click', () => {
      switchToDrawingDisplay(scheduleRender);
    });
  }

  if (hasPanelButtons) {
    viewModePerspectiveBtn.addEventListener('click', () => {
      switchToSolidDisplay(scheduleRender);
    });

    viewModeOrthographicBtn.addEventListener('click', () => {
      switchToDrawingDisplay(scheduleRender);
    });
  }

  if (solidProjectionPerspectiveBtn) {
    solidProjectionPerspectiveBtn.addEventListener('click', () => {
      switchToSolidDisplay(scheduleRender, CAMERA_MODES.PERSPECTIVE);
    });
  }

  if (solidProjectionOrthographicBtn) {
    solidProjectionOrthographicBtn.addEventListener('click', () => {
      switchToSolidDisplay(scheduleRender, CAMERA_MODES.ORTHOGRAPHIC);
    });
  }

  const viewButtons = document.querySelectorAll('#viewDirectionPanel button[data-view]');
  viewButtons.forEach((button) => {
    button.addEventListener('click', function (event) {
      event.preventDefault();
      updateDrawingView(scheduleRender, this.dataset.view);
    });
  });

  const panelViewButtons = document.querySelectorAll('#viewDirectionButtons .view-dir-btn');
  panelViewButtons.forEach((button) => {
    button.addEventListener('click', function (event) {
      event.preventDefault();
      updateDrawingView(scheduleRender, this.dataset.view);
    });
  });

  if (hasRadioButtons) {
    cameraPerspective.addEventListener('change', function () {
      if (this.checked) {
        switchToSolidDisplay(scheduleRender);
      }
    });

    cameraOrthographic.addEventListener('change', function () {
      if (this.checked) {
        switchToDrawingDisplay(scheduleRender);
      }
    });
  }

  syncUiState();
  log.info('[setupCameraModeListeners] Camera mode listeners initialized successfully');
}
