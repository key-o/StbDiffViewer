/**
 * @fileoverview Generate conservative AABB inputs from Working Document solids.
 *
 * This is a diagnostic-only, explicitly invoked snapshot. It does not read the
 * visible scene, whose display filters may omit structural members, and it does
 * not change any quantity, STB document, or mesh in the viewer.
 */

import * as THREE from 'three';

import { getElementRedrawConfig } from '../../config/elementRedrawConfig.js';
import { generateWorkingSolidMeshes } from '../../app/editing/workingSolidGenerator.js';

const DEFAULT_MAX_MEMBERS = 2000;
const AXES = ['x', 'y', 'z'];

const identityKey = (elementType, elementId) => JSON.stringify([elementType, String(elementId)]);

function hasPositiveFiniteVolume(box) {
  return AXES.every(
    (axis) =>
      Number.isFinite(box.min[axis]) &&
      Number.isFinite(box.max[axis]) &&
      box.min[axis] < box.max[axis],
  );
}

/**
 * Generated meshes may carry transforms (including non-visible parents). The
 * AABB is computed in world-space (same millimetre coordinates as STB nodes).
 * Geometry bounding boxes are refreshed because Working geometry may change.
 */
function memberBounds(meshes, elementType, elementId) {
  if (!Array.isArray(meshes) || meshes.length === 0) {
    return { reason: 'solid-missing' };
  }
  const result = new THREE.Box3();
  const used = new Set();
  for (const mesh of meshes) {
    if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || used.has(mesh)) {
      return { reason: 'unsupported-mesh' };
    }
    used.add(mesh);
    const meta = mesh.userData || {};
    if (
      meta.isPoly === true ||
      meta.isLine === true ||
      meta.isOverlayModelB === true ||
      ['B', 'onlyB'].includes(meta.modelSource)
    ) {
      return { reason: 'non-working-solid' };
    }
    if (
      (meta.elementType !== undefined && meta.elementType !== elementType) ||
      (meta.elementId !== undefined && String(meta.elementId) !== String(elementId))
    ) {
      return { reason: 'member-identity-mismatch' };
    }
    const geometry = mesh.geometry;
    if (!geometry?.isBufferGeometry || !geometry.getAttribute('position')?.count) {
      return { reason: 'geometry-unavailable' };
    }
    geometry.computeBoundingBox();
    if (!geometry.boundingBox || !hasPositiveFiniteVolume(geometry.boundingBox)) {
      return { reason: 'invalid-local-bounds' };
    }
    mesh.updateWorldMatrix(true, false); // Includes invisible-parent transforms.
    if (!mesh.matrixWorld.elements.every(Number.isFinite)) {
      return { reason: 'invalid-world-transform' };
    }
    const box = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    if (!hasPositiveFiniteVolume(box)) return { reason: 'invalid-world-bounds' };
    result.union(box);
  }
  return hasPositiveFiniteVolume(result)
    ? {
        bounds: {
          min: { x: result.min.x, y: result.min.y, z: result.min.z },
          max: { x: result.max.x, y: result.max.y, z: result.max.z },
        },
      }
    : { reason: 'invalid-union-bounds' };
}

/**
 * Create an AABB snapshot for an *explicit* set of structural member types.
 *
 * The caller must pass parsedData generated from the CURRENT Working Document,
 * a corresponding workingNodeMap and an immutable session/revision token. This
 * utility intentionally makes no attempt to discover missing members via the
 * filtered display scene. A caller can inject the production generator factory.
 *
 * coverageComplete means only the requested element types were processed; it
 * does NOT mean all structural materials or building solids have been checked.
 *
 * @param {{parsedData:object,workingNodeMap:Map,sessionId:string,workingRevision:number,
 * elementTypes:string[],generatorInfoForType:function,generate?:function,maxMembers?:number}} args
 */
export function createWorkingSolidAabbSnapshot({
  parsedData,
  workingNodeMap,
  sessionId,
  workingRevision,
  elementTypes,
  generatorInfoForType,
  generate = generateWorkingSolidMeshes,
  maxMembers = DEFAULT_MAX_MEMBERS,
} = {}) {
  if (
    !parsedData ||
    !(workingNodeMap instanceof Map) ||
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    !Number.isSafeInteger(workingRevision) ||
    workingRevision < 0 ||
    !Array.isArray(elementTypes) ||
    elementTypes.length === 0 ||
    typeof generatorInfoForType !== 'function' ||
    typeof generate !== 'function' ||
    !Number.isSafeInteger(maxMembers) ||
    maxMembers < 1
  ) {
    throw new TypeError(
      'A current Working document, revision, element types and generator are required',
    );
  }

  const members = [];
  const unresolved = [];
  let considered = 0;
  let truncated = false;
  const seenTypes = new Set();
  const seenMembers = new Set();

  for (const elementType of elementTypes) {
    if (typeof elementType !== 'string' || !elementType || seenTypes.has(elementType)) {
      throw new TypeError('elementTypes must contain unique nonempty type names');
    }
    seenTypes.add(elementType);
    const config = getElementRedrawConfig(elementType);
    if (!config || !Array.isArray(parsedData[config.elementsKey])) {
      unresolved.push({ elementType, elementId: null, reason: 'type-data-unavailable' });
      continue;
    }
    const generatorInfo = generatorInfoForType(elementType);
    for (const element of parsedData[config.elementsKey]) {
      const elementId = element?.id === undefined || element?.id === null ? '' : String(element.id);
      const key = identityKey(elementType, elementId);
      if (!elementId || seenMembers.has(key)) {
        unresolved.push({ elementType, elementId, reason: 'invalid-or-duplicate-identity' });
        continue;
      }
      seenMembers.add(key);
      considered += 1;
      if (considered > maxMembers) {
        truncated = true;
        // Keep counting input members for diagnostics; do not generate further solids.
        continue;
      }
      try {
        const generated = generate({
          elementType,
          elementId,
          parsedData,
          workingNodeMap,
          generatorInfo,
          config,
        });
        if (!generated?.supported) {
          unresolved.push({
            elementType,
            elementId,
            reason: generated?.reason || 'generator-unsupported',
          });
          continue;
        }
        const extraction = memberBounds(generated.meshes, elementType, elementId);
        if (!extraction.bounds) {
          unresolved.push({ elementType, elementId, reason: extraction.reason });
          continue;
        }
        members.push({ elementType, elementId, bounds: extraction.bounds });
      } catch (_error) {
        // No partial geometry is usable for a quantity-bearing diagnostic.
        unresolved.push({ elementType, elementId, reason: 'generation-failed' });
      }
    }
  }

  return {
    sessionId,
    workingRevision,
    elementTypes: [...elementTypes],
    members,
    unresolved,
    considered,
    truncated,
    coverageComplete: !truncated && unresolved.length === 0,
    buildingCoverageVerified: false,
    verification: 'not_verified',
    quantityEffect: 'none',
  };
}
