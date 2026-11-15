/**
 * @fileoverview Limited exact union of *certified* Working geometry cuboids.
 *
 * This is independent of QuantityService and deliberately has no UI effect.
 * Only single closed orthogonal solids with an explicitly resolved homogeneous
 * material are included. All others remain unresolved (no guessed deductions).
 */

import { getElementRedrawConfig } from '../../config/elementRedrawConfig.js';
import { generateWorkingSolidMeshes } from '../../app/editing/workingSolidGenerator.js';
import { certifyOrthogonalBoxMesh } from './CertifiedOrthogonalBox.js';
import { calculateCertifiedBoxUnion } from './CertifiedBoxUnion.js';

const DEFAULT_MAX_MEMBERS = 64;

/**
 * @param {{parsedData:object,workingNodeMap:Map,sessionId:string,workingRevision:number,
 * elementTypes:string[],generatorInfoForType:function,materialKindForElement:function,
 * generate?:function,maxMembers?:number,isCurrentRevision:function}} options
 * @returns {object} Exact subset volume only, not a whole-building quantity.
 */
export function calculateWorkingCertifiedBoxSubset({
  parsedData,
  workingNodeMap,
  sessionId,
  workingRevision,
  elementTypes,
  generatorInfoForType,
  materialKindForElement,
  generate = generateWorkingSolidMeshes,
  maxMembers = DEFAULT_MAX_MEMBERS,
  isCurrentRevision,
  onProgress = () => {},
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
    new Set(elementTypes).size !== elementTypes.length ||
    elementTypes.some((type) => typeof type !== 'string' || !type.trim()) ||
    typeof generatorInfoForType !== 'function' ||
    typeof materialKindForElement !== 'function' ||
    typeof generate !== 'function' ||
    typeof isCurrentRevision !== 'function' ||
    typeof onProgress !== 'function' ||
    !Number.isSafeInteger(maxMembers) ||
    maxMembers < 1 ||
    maxMembers > DEFAULT_MAX_MEMBERS
  ) {
    throw new TypeError('Current Working revision, member types and material resolver required');
  }

  if (isCurrentRevision(sessionId, workingRevision) !== true) {
    throw new Error('working-revision-changed');
  }

  const boxes = [];
  const unresolved = [];
  const seen = new Set();
  let considered = 0;
  let truncated = false;
  onProgress({ phase: 'geometry', processed: 0 });
  for (const elementType of elementTypes) {
    const config = getElementRedrawConfig(elementType);
    if (!config || !Array.isArray(parsedData[config.elementsKey])) {
      unresolved.push({ elementType, elementId: null, reason: 'type-data-unavailable' });
      continue;
    }
    for (const element of parsedData[config.elementsKey]) {
      const elementId = element?.id === null || element?.id === undefined ? '' : String(element.id);
      const key = JSON.stringify([elementType, elementId]);
      if (!elementId || seen.has(key)) {
        unresolved.push({ elementType, elementId, reason: 'invalid-or-duplicate-identity' });
        continue;
      }
      seen.add(key);
      considered += 1;
      if (considered > maxMembers) {
        truncated = true;
        // Exact union requires complete certified inputs; never extrapolate.
        continue;
      }
      try {
        const materialKind = materialKindForElement(elementType, element);
        if (!['CONCRETE', 'STEEL'].includes(materialKind)) {
          unresolved.push({ elementType, elementId, reason: 'material-unresolved' });
          continue;
        }
        const generated = generate({
          elementType,
          elementId,
          parsedData,
          workingNodeMap,
          generatorInfo: generatorInfoForType(elementType),
          config,
        });
        if (!generated?.supported || !Array.isArray(generated.meshes)) {
          unresolved.push({
            elementType,
            elementId,
            reason: generated?.reason || 'solid-generator-unavailable',
          });
          continue;
        }
        // Disconnected multipart/mesh composites could intersect internally.
        // No AABB surrogate is allowed into a certified union.
        if (generated.meshes.length !== 1) {
          unresolved.push({ elementType, elementId, reason: 'not-single-solid' });
          continue;
        }
        const certified = certifyOrthogonalBoxMesh(generated.meshes[0], {
          elementType,
          elementId,
          materialKind,
        });
        if (!certified.certified) {
          unresolved.push({ elementType, elementId, reason: certified.reason });
          continue;
        }
        boxes.push(certified);
      } catch (_error) {
        unresolved.push({ elementType, elementId, reason: 'certification-failed' });
      } finally {
        // Exact per-member completion count; no fabricated percent estimate.
        onProgress({ phase: 'geometry', processed: considered });
      }
    }
  }

  if (isCurrentRevision(sessionId, workingRevision) !== true) {
    throw new Error('working-revision-changed');
  }
  onProgress({ phase: 'union', processed: considered });
  const union = calculateCertifiedBoxUnion(boxes);
  return {
    ...union,
    sessionId,
    workingRevision,
    elementTypes: [...elementTypes],
    considered,
    unresolved,
    truncated,
    certifiedMemberCount: boxes.length,
    subsetCoverageComplete: !truncated && unresolved.length === 0,
    // Even if the requested subset was complete, this is NEVER a building figure.
    buildingCoverageVerified: false,
    quantityServiceUpdated: false,
  };
}
