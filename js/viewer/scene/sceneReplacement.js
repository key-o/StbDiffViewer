/** Keep the old renderables alive until a candidate model has finished rendering. */
import { scene, elementGroups } from '../core/core.js';
import { getElementRegistry } from '../utils/ElementRegistry.js';
import { disposeRecursive } from '../utils/ResourceDisposer.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:sceneReplacement');

function collectResources(roots) {
  const resources = new Set();
  for (const root of roots) {
    root.traverse((object) => {
      if (object.geometry) resources.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials.filter(Boolean)) {
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      }
    });
  }
  return resources;
}

export function beginSceneReplacement({ targetScene = scene, groups = elementGroups } = {}) {
  const roots = [...targetScene.children];
  const saved = Object.values(groups).map((group) => ({
    group,
    children: [...group.children],
    visible: group.visible,
  }));
  const detached = saved.flatMap(({ children }) => children);
  const groupRoots = new Set(Object.values(groups));
  // Hide old overlays/labels too: staging must not mutate them through scene traversal.
  const auxiliaryRoots = roots.filter(
    (root) => !groupRoots.has(root) && !root.isLight && !root.isCamera,
  );
  const grids = auxiliaryRoots.filter((root) => root.type === 'GridHelper');
  detached.push(...auxiliaryRoots);
  const preserved = collectResources(roots);
  for (const child of detached) child.removeFromParent();
  const registry = getElementRegistry().beginReplacement();
  let active = true;
  let published = false;

  // The first phase reinstalls lifecycle-owned overlays, but neither retires
  // the previous model's GPU resources nor releases its rollback snapshot.
  // This gives a synchronous drawing transaction a reversible publication
  // boundary. No external observers/events should be published at this stage.
  const publish = () => {
    if (!active || published) return;
    published = true;
    for (const root of auxiliaryRoots) if (!grids.includes(root)) targetScene.add(root);
  };

  // Irreversible retirement must happen only after all reversible participants
  // have succeeded. Existing commit() callers retain their original behavior.
  const finalize = () => {
    if (!active) return;
    publish();
    active = false;
    // Once an old resource has begun disposal it cannot be reliably restored.
    // A renderer dispose callback must therefore never interrupt the already
    // committed model/drawing state or drop pending lifecycle notifications.
    let currentResources;
    try {
      currentResources = collectResources(targetScene.children);
    } catch (error) {
      // If the live resource graph cannot be inspected, preserving the retired
      // resources is safer than accidentally disposing a shared live texture.
      log.error('Committed scene resource inspection failed; old resources retained:', error);
      return;
    }
    for (const child of detached) {
      if (auxiliaryRoots.includes(child) && !grids.includes(child)) continue;
      try {
        disposeRecursive(child, { preservedResources: currentResources });
      } catch (error) {
        // Continue with other roots; the retired model is already detached.
        log.error('Retired scene resource disposal failed:', error);
      }
    }
  };

  return {
    publish,
    finalize,
    commit: finalize,
    rollback() {
      if (!active) return;
      active = false;
      for (const { group } of saved) {
        for (const child of [...group.children]) {
          disposeRecursive(child, { preservedResources: preserved });
        }
      }
      for (const child of [...targetScene.children]) {
        if (!roots.includes(child)) disposeRecursive(child, { preservedResources: preserved });
      }
      for (const { group, children, visible } of saved) {
        group.visible = visible;
        for (const child of children) group.add(child);
      }
      for (const root of auxiliaryRoots) targetScene.add(root);
      targetScene.children.sort((a, b) => roots.indexOf(a) - roots.indexOf(b));
      registry.rollback();
    },
  };
}
