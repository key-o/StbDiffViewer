/**
 * @fileoverview Read-only, revision-bound diagnostic entry point for certified box union.
 *
 * Scope is explicitly selected RC Working elements; unsupported material kinds
 * remain unresolved. Neither QuantityService nor either source STB is mutated.
 */
import { parseStbFile } from '../../viewer/geometry/stbStructureReader.js';
import { geometryGeneratorFactory } from '../../viewer/geometry/GeometryGeneratorFactory.js';
import {
  isCurrentWorkingDiagnosticSnapshot,
  resolveDiagnosticMaterial,
  selectDiagnosticMembers,
} from './workingCertifiedBoxSelection.js';
export {
  CERTIFIED_DIAGNOSTIC_TYPES,
  isCurrentWorkingDiagnosticSnapshot,
  resolveDiagnosticMaterial,
  selectDiagnosticMembers,
} from './workingCertifiedBoxSelection.js';
import { runWorkingCertifiedBoxWorkerJob } from './workingCertifiedBoxWorkerClient.js';

export function serializeWorkingDocumentForDiagnostic(workingDocument) {
  if (!workingDocument?.documentElement || typeof globalThis.XMLSerializer !== 'function') {
    throw new Error('diagnostic-working-xml-serialization-unavailable');
  }
  const xmlText = new globalThis.XMLSerializer().serializeToString(workingDocument);
  if (!xmlText.trim().startsWith('<')) {
    throw new Error('diagnostic-working-xml-serialization-failed');
  }
  return xmlText;
}

function defaultDefer() {
  // Give the diagnostic dialog a chance to paint before the synchronous
  // production parser/generator starts. Cancellation within those operations
  // is NOT supported until the follow-up Worker stage.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Reads the current Working XML only. A rejected or stale scan never produces
 * a result usable by the UI. The result is always a selected subset diagnostic.
 */
export async function runWorkingCertifiedBoxDiagnostic({
  getEditingState,
  elementTypes,
  elementIds = [],
  signal,
  defer = defaultDefer,
  parse = parseStbFile,
  calculate = null,
  serialize = serializeWorkingDocumentForDiagnostic,
  workerRun = runWorkingCertifiedBoxWorkerJob,
  onProgress = () => {},
  getGeneratorInfo = (type) => geometryGeneratorFactory.getGeneratorInfo(type),
} = {}) {
  if (typeof getEditingState !== 'function' || typeof defer !== 'function') {
    throw new TypeError('Editing state and scheduler are required');
  }
  // Validate input before touching the Working document.
  selectDiagnosticMembers({}, elementTypes, elementIds);
  const current = getEditingState();
  if (!current?.active || !current.workingDocument || !(current.workingNodeMap instanceof Map)) {
    throw new Error('編集セッションがありません');
  }
  const snapshot = {
    sessionId: current.sessionId,
    workingRevision: current.workingRevision,
    workingDocument: current.workingDocument,
    workingNodeMap: current.workingNodeMap,
  };
  const ensureCurrent = () => {
    if (signal?.aborted) throw new Error('diagnostic-aborted');
    if (!isCurrentWorkingDiagnosticSnapshot(getEditingState, snapshot)) {
      throw new Error('working-revision-changed');
    }
  };

  ensureCurrent();
  await defer();
  ensureCurrent();

  let result;
  let selection = null;
  // Only injected legacy test/oracle calculations parse on the main thread.
  // Normal application execution serializes a snapshot then offloads all XML
  // parsing, geometry generation, certification and union to the Worker.
  if (typeof calculate === 'function') {
    onProgress({ phase: 'parse' });
    const parsedData = parse(snapshot.workingDocument, {
      modelKey: null,
      saveToGlobalState: false,
      exposeDebugState: false,
    });
    ensureCurrent();
    selection = selectDiagnosticMembers(parsedData, elementTypes, elementIds);
    result = await calculate({
      parsedData: selection.parsedData,
      workingNodeMap: snapshot.workingNodeMap,
      sessionId: snapshot.sessionId,
      workingRevision: snapshot.workingRevision,
      elementTypes,
      generatorInfoForType: getGeneratorInfo,
      materialKindForElement: resolveDiagnosticMaterial,
      isCurrentRevision: (sessionId, revision) =>
        sessionId === snapshot.sessionId &&
        revision === snapshot.workingRevision &&
        isCurrentWorkingDiagnosticSnapshot(getEditingState, snapshot) &&
        !signal?.aborted,
    });
  } else {
    onProgress({ phase: 'serialize' });
    const xmlText = serialize(snapshot.workingDocument);
    ensureCurrent();
    result = await workerRun(
      {
        xmlText,
        workingNodeMap: snapshot.workingNodeMap,
        sessionId: snapshot.sessionId,
        workingRevision: snapshot.workingRevision,
        elementTypes,
        elementIds,
      },
      { signal, onProgress },
    );
  }
  ensureCurrent();
  return {
    ...result,
    requestedIds: selection ? selection.requestedIds : result.requestedIds || [],
    missingIds: selection ? selection.missingIds : result.missingIds || [],
    unresolved: selection
      ? [
          ...result.unresolved,
          ...selection.missingIds.map((elementId) => ({
            elementType: '(selected ID)',
            elementId,
            reason: 'selected-id-not-found',
          })),
        ]
      : result.unresolved,
    subsetCoverageComplete:
      result.subsetCoverageComplete === true &&
      (selection ? selection.missingIds.length === 0 : !result.missingIds?.length),
    // These flags must not be promoted by callers regardless of scope.
    buildingCoverageVerified: false,
    quantityServiceUpdated: false,
  };
}
