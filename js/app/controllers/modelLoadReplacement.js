/** Provisional loader state and lifecycle; the old model stays recoverable until commit. */
import globalState from '../../data/state/globalState.js';
import { eventBus } from '../../data/events/eventBus.js';
import {
  ModelEvents,
  AppEvents,
  ComparisonEvents,
  FinalizationEvents,
  AxisEvents,
  LabelEvents,
  RenderEvents,
  ViewEvents,
  ImportanceEvents,
} from '../../constants/eventTypes.js';
import {
  beginSceneReplacement,
  beginParseCacheReplacement,
  camera,
  orthographicCamera,
  controls,
} from '../../viewer/index.js';
import { getModelContext, setModelContext } from '../viewModes/modelContext.js';
import { getImportanceManager } from '../importanceManager.js';
import * as jsonSchema from '../../common-stb/import/parser/jsonSchemaLoader.js';
import * as xsdSchema from '../../common-stb/import/parser/xsdSchemaParser.js';
import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { markCoordinatedDrawingModelEvent } from '../pdfOverlay/drawingModelLifecycleEventGate.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ModelLoadReplacement');

export function beginModelLoadReplacement() {
  const schemas = [jsonSchema.getActiveVersion(), xsdSchema.getActiveVersion()];
  const context = getModelContext();
  const cameras = [camera, orthographicCamera].map((value) => [value, value.clone()]);
  const controlState = controls?.toJSON?.();
  const notifications = eventBus.deferEvents(
    [
      ModelEvents,
      AppEvents,
      ComparisonEvents,
      FinalizationEvents,
      AxisEvents,
      LabelEvents,
      RenderEvents,
      ViewEvents,
      ImportanceEvents,
      RenderableLifecycleEvents,
    ].flatMap(Object.values),
  );
  const participants = [];
  let state;
  let scene;
  try {
    state = globalState.beginReplacement();
    participants.push(state);
    scene = beginSceneReplacement();
    participants.push(scene);
    participants.push(beginParseCacheReplacement());
    participants.push(getImportanceManager().beginReplacement());
  } catch (error) {
    notifications.rollback();
    for (const participant of participants.reverse()) participant.rollback();
    throw error;
  }
  let active = true;
  const rollback = () => {
    if (!active) return;
    active = false;
    notifications.rollback();
    for (const participant of [...participants].reverse()) participant.rollback();
    setModelContext(context);
    jsonSchema.setActiveVersion(schemas[0]);
    xsdSchema.setActiveVersion(schemas[1]);
    for (const [value, saved] of cameras) value.copy(saved);
    if (controlState) controls.fromJSON(controlState, false);
  };
  return {
    commit({ validateBeforePublish, drawingParticipant = null } = {}) {
      if (!active) return;
      // Only synchronous participants are allowed: an await between scene
      // publication and DrawingProject publication would expose mixed revisions.
      let drawingStarted = false;
      try {
        if (validateBeforePublish != null) {
          if (typeof validateBeforePublish !== 'function')
            throw new TypeError('validateBeforePublish must be a synchronous function');
          const result = validateBeforePublish();
          if (result && typeof result.then === 'function')
            throw new TypeError('validateBeforePublish must not return a Promise');
        }
        if (drawingParticipant != null) {
          if (
            typeof drawingParticipant.publish !== 'function' ||
            typeof drawingParticipant.rollback !== 'function'
          )
            throw new TypeError('DrawingProject participant must expose publish and rollback');
          if (
            (drawingParticipant.finalize != null &&
              typeof drawingParticipant.finalize !== 'function') ||
            (drawingParticipant.revoke != null && typeof drawingParticipant.revoke !== 'function')
          )
            throw new TypeError('DrawingProject finalize/revoke must be synchronous functions');
          // publish() keeps old geometry and the registry rollback snapshot.
          // No globalState listener or model event has fired at this boundary.
          scene.publish();
          drawingStarted = true; // Also rollback when publish() throws midway.
          const result = drawingParticipant.publish();
          if (result && typeof result.then === 'function')
            throw new TypeError('DrawingProject publish must be synchronous');
        }
      } catch (error) {
        let drawingRollbackError = null;
        if (drawingStarted) {
          try {
            drawingParticipant.rollback();
          } catch (cause) {
            drawingRollbackError = cause;
          }
        }
        // Never let a failed drawing rollback strand the old 3D scene or
        // deliver provisional model lifecycle events.
        try {
          rollback();
        } catch (cause) {
          throw new AggregateError(
            [error, ...(drawingRollbackError ? [drawingRollbackError] : []), cause],
            'モデルと図面の改訂ロールバックに失敗しました。',
          );
        }
        if (drawingRollbackError)
          throw new AggregateError(
            [error, drawingRollbackError],
            '図面のロールバックに失敗しました。',
          );
        throw error;
      }
      active = false;
      scene.finalize();
      // A caller must not refresh a registered drawing merely because the 3D
      // model published: Document Control may have revoked the drawing grant.
      let drawingStatus = drawingParticipant ? 'unverified' : 'none';
      // The old scene has been irreversibly retired. Finalizing Document
      // Control now can revoke the old grant without exposing provisional
      // model state; an error must never strand the new scene or its events.
      if (drawingParticipant?.finalize) {
        try {
          const outcome = drawingParticipant.finalize();
          if (outcome && typeof outcome.then === 'function')
            throw new TypeError('DrawingProject finalize must not return a Promise');
          if (!['rebound', 'revoked', 'not-open'].includes(outcome?.status))
            throw new TypeError('DrawingProject finalize did not report a verified status');
          drawingStatus = outcome.status;
          if (outcome?.status === 'revoked')
            log.warn('Document Controlの旧図面登録を安全のため失効しました。', outcome.error);
        } catch (error) {
          drawingStatus = 'revoked';
          try {
            drawingParticipant.revoke?.();
          } catch (revokeError) {
            log.error('Document Control登録の失効に失敗しました。', revokeError);
          }
          log.error('図面ライフサイクルの最終同期に失敗しました。', error);
        }
      }
      state.commit();
      notifications.commit({
        mapEvent: drawingParticipant
          ? (type, payload) => markCoordinatedDrawingModelEvent(type, payload, drawingParticipant)
          : undefined,
      });
      return Object.freeze({ modelStatus: 'published', drawingStatus });
    },
    rollback,
  };
}
