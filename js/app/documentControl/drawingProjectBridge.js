/**
 * #489 Per-JavaScript-realm bridge between the drawing UI owner and Document Control.
 * No raw DrawingProject, memo text, PDF, DXF or DOM references cross this boundary.
 * Each browser tab / Tauri WebView has its own module instance.
 */
let owner = null;
const subscribers = new Set();

function notifySubscribers(event) {
  // Deliver invalidation to every consumer even when an unrelated UI observer fails.
  for (const notify of [...subscribers]) {
    try {
      notify(event);
    } catch {
      // The remaining access-control listeners must still receive revocation.
    }
  }
}

export function registerDrawingProjectOwner(candidate) {
  if (
    typeof candidate?.getOpenDrawingProjectDescriptor !== 'function' ||
    typeof candidate?.subscribeDrawingProjectLifecycle !== 'function'
  ) {
    throw new TypeError('Drawing owner must expose a descriptor and lifecycle events.');
  }
  owner?.unsubscribe();
  const registration = { candidate, unsubscribe: null };
  owner = registration;
  registration.unsubscribe = candidate.subscribeDrawingProjectLifecycle((event) => {
    if (owner !== registration) return;
    notifySubscribers(event);
  });
  notifySubscribers({ event: 'drawing_owner_changed' });
  return () => {
    if (owner !== registration) return;
    owner = null;
    registration.unsubscribe?.();
    notifySubscribers({ event: 'drawing_owner_changed' });
  };
}

export const drawingProjectReadBridge = Object.freeze({
  getOpenDrawingProjectDescriptor() {
    return owner?.candidate.getOpenDrawingProjectDescriptor() ?? null;
  },
  hasLoadedDrawingProject() {
    return owner?.candidate.hasLoadedDrawingProject?.() === true;
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Listener must be a function.');
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
});
