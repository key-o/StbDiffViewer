/**
 * @fileoverview Renderable geometry batch lifecycle.
 *
 * Geometry generators only create structural geometry. Viewer-level display
 * policy (currently clipping, later registry/picking/overlay policy) is applied
 * after generation, when a group batch is considered complete.
 */

import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { eventBus } from '../../data/events/eventBus.js';
import { clippingStateManager } from '../clipping/ClippingStateManager.js';

/**
 * Complete one geometry regeneration batch.
 * Clipping is synchronized first, then listeners (SectionBox/StencilCap etc.)
 * are notified exactly once for the completed group.
 * @param {{elementType: string, group: import('three').Object3D}} payload
 */
export function finalizeRenderableBatch({ elementType, group }) {
  if (!group) return;

  clippingStateManager.applyToObject(group, elementType);
  eventBus.emit(RenderableLifecycleEvents.GEOMETRY_CHANGED, {
    elementType,
    group,
  });
}
