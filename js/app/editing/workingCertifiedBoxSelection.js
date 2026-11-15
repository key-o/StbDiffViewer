/**
 * @fileoverview Shared, side-effect-free selection rules for Working box diagnostics.
 * Runs identically in the viewer and its module Worker.
 */
import { getElementRedrawConfig } from '../../config/elementRedrawConfig.js';

export const CERTIFIED_DIAGNOSTIC_TYPES = Object.freeze([
  'Column',
  'Girder',
  'Beam',
  'Wall',
  'Slab',
]);

const MAX_SELECTED_IDS = 64;

export function isCurrentWorkingDiagnosticSnapshot(getEditingState, snapshot) {
  const current = getEditingState?.();
  return (
    current?.active === true &&
    current.sessionId === snapshot.sessionId &&
    current.workingRevision === snapshot.workingRevision &&
    current.workingDocument === snapshot.workingDocument &&
    current.workingNodeMap === snapshot.workingNodeMap
  );
}

/** RC is the only supported material proof in this first UI integration. */
export function resolveDiagnosticMaterial(elementType, element) {
  return CERTIFIED_DIAGNOSTIC_TYPES.includes(elementType) && element?.kind_structure === 'RC'
    ? 'CONCRETE'
    : null;
}

export function selectDiagnosticMembers(parsedData, elementTypes, elementIds = []) {
  if (
    !parsedData ||
    !Array.isArray(elementTypes) ||
    elementTypes.length === 0 ||
    elementTypes.some((type) => !CERTIFIED_DIAGNOSTIC_TYPES.includes(type)) ||
    new Set(elementTypes).size !== elementTypes.length ||
    !Array.isArray(elementIds) ||
    elementIds.length > MAX_SELECTED_IDS ||
    elementIds.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    throw new TypeError('診断対象の部材種別・IDが不正です');
  }

  const requestedIds = [...new Set(elementIds.map((id) => id.trim()))];
  if (requestedIds.length === 0) {
    const groups = elementTypes
      .map((type) => {
        const key = getElementRedrawConfig(type)?.elementsKey;
        return { key, elements: key && Array.isArray(parsedData[key]) ? parsedData[key] : [] };
      })
      .filter(({ key }) => Boolean(key));
    const total = groups.reduce((sum, group) => sum + group.elements.length, 0);
    if (total <= MAX_SELECTED_IDS) return { parsedData, requestedIds, missingIds: [] };

    // Never silently fill the first 64 slots with Column elements while
    // excluding all the selected Girder/Beam/Wall/Slab categories.
    const selected = { ...parsedData };
    for (const group of groups) selected[group.key] = [];
    let included = 0;
    for (let index = 0; included < MAX_SELECTED_IDS; index++) {
      let advanced = false;
      for (const group of groups) {
        if (index >= group.elements.length || included >= MAX_SELECTED_IDS) continue;
        selected[group.key].push(group.elements[index]);
        included++;
        advanced = true;
      }
      if (!advanced) break;
    }
    return {
      parsedData: selected,
      requestedIds,
      missingIds: [],
      selectionTruncated: true,
      excludedMemberCount: total - included,
    };
  }
  const wanted = new Set(requestedIds);
  const matched = new Set();
  const selected = { ...parsedData };
  for (const type of elementTypes) {
    const key = getElementRedrawConfig(type)?.elementsKey;
    if (!key || !Array.isArray(parsedData[key])) continue;
    selected[key] = parsedData[key].filter((element) => {
      const id = String(element?.id ?? '');
      if (!wanted.has(id)) return false;
      matched.add(id);
      return true;
    });
  }
  return {
    parsedData: selected,
    requestedIds,
    missingIds: requestedIds.filter((id) => !matched.has(id)),
  };
}
