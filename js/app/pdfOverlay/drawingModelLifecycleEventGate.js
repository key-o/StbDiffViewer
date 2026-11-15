/**
 * Mark model lifecycle notifications that follow a successful, coordinated
 * 3D + DrawingProject publication. The marker is held outside the public event
 * payload, so ordinary model loads (including later nested events) cannot
 * accidentally opt out of drawing invalidation.
 */
import { ModelEvents } from '../../constants/eventTypes.js';

const owners = new WeakMap();

export function markCoordinatedDrawingModelEvent(eventType, payload, drawingParticipant) {
  if (
    (eventType !== ModelEvents.CLEARED && eventType !== ModelEvents.LOADED) ||
    typeof drawingParticipant?.ownsDrawingPanel !== 'function'
  )
    return payload;
  const eventPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
  owners.set(eventPayload, drawingParticipant);
  return eventPayload;
}

export function isCoordinatedDrawingModelEvent(payload, panel) {
  if (!payload || typeof payload !== 'object' || !panel) return false;
  const participant = owners.get(payload);
  try {
    return participant?.ownsDrawingPanel(panel) === true;
  } catch {
    // A faulty participant must not suppress ordinary drawing invalidation.
    return false;
  }
}
