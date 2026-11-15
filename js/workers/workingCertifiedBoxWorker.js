/**
 * @fileoverview #746 Worker-only certified subset calculation.
 * Parses serialized Working XML and generates geometry entirely in this Worker.
 * This worker never receives a DOM Document or writes quantities.
 */
import * as THREE from 'three';
import { DOMParser } from '@xmldom/xmldom';

import { geometryGeneratorFactory } from '../viewer/geometry/GeometryGeneratorFactory.js';
import { parseStbFile } from '../viewer/geometry/stbStructureReader.js';
import {
  resolveDiagnosticMaterial,
  selectDiagnosticMembers,
} from '../app/editing/workingCertifiedBoxSelection.js';
import { calculateWorkingCertifiedBoxSubset } from '../quantities/overlap/WorkingCertifiedBoxUnion.js';

/** Structured clone removes THREE.Vector3 prototypes. Restore only node coordinates. */
function restoreParsedNodes(parsedData) {
  if (!(parsedData?.nodes instanceof Map)) {
    throw new TypeError('diagnostic-worker-nodes-unavailable');
  }
  const nodes = new Map();
  for (const [id, coords] of parsedData.nodes) {
    const values = [Number(coords?.x), Number(coords?.y), Number(coords?.z)];
    if (!values.every(Number.isFinite)) {
      throw new TypeError('diagnostic-worker-invalid-node');
    }
    nodes.set(id, new THREE.Vector3(...values));
  }
  return { ...parsedData, nodes };
}

/**
 * DOMParser is not available in dedicated browser Workers. Reuse the existing
 * xmldom dependency; unsupported XML or parse errors fail closed.
 */
export function parseWorkingXmlInWorker(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim() || xmlText.length > 30_000_000) {
    throw new TypeError('diagnostic-worker-xml-invalid');
  }
  const rejectMalformedXml = () => {
    throw new TypeError('diagnostic-worker-xml-invalid');
  };
  const document = new DOMParser({
    errorHandler: {
      warning: rejectMalformedXml,
      error: rejectMalformedXml,
      fatalError: rejectMalformedXml,
    },
  }).parseFromString(xmlText, 'text/xml');
  if (!document?.documentElement || document.getElementsByTagName('parsererror').length) {
    throw new TypeError('diagnostic-worker-xml-invalid');
  }
  return parseStbFile(document, {
    modelKey: null,
    saveToGlobalState: false,
    exposeDebugState: false,
  });
}

/** Exported to permit a direct oracle test independently of Worker messaging. */
export function calculateCertifiedSubsetInWorker(payload, onProgress = () => {}) {
  if (
    !payload ||
    typeof payload.sessionId !== 'string' ||
    !Number.isSafeInteger(payload.workingRevision) ||
    !Array.isArray(payload.elementTypes) ||
    !(payload.workingNodeMap instanceof Map)
  ) {
    throw new TypeError('diagnostic-worker-invalid-request');
  }
  onProgress({ phase: 'parse' });
  const parsedData =
    typeof payload.xmlText === 'string'
      ? parseWorkingXmlInWorker(payload.xmlText)
      : restoreParsedNodes(payload.parsedData);
  onProgress({ phase: 'selection' });
  const selection = selectDiagnosticMembers(
    parsedData,
    payload.elementTypes,
    payload.elementIds || [],
  );
  const result = calculateWorkingCertifiedBoxSubset({
    parsedData: selection.parsedData,
    workingNodeMap: payload.workingNodeMap,
    sessionId: payload.sessionId,
    workingRevision: payload.workingRevision,
    elementTypes: payload.elementTypes,
    generatorInfoForType: (type) => geometryGeneratorFactory.getGeneratorInfo(type),
    materialKindForElement: resolveDiagnosticMaterial,
    isCurrentRevision: (sessionId, revision) =>
      sessionId === payload.sessionId && revision === payload.workingRevision,
    onProgress,
  });
  return {
    ...result,
    requestedIds: selection.requestedIds,
    missingIds: selection.missingIds,
    unresolved: [
      ...result.unresolved,
      ...selection.missingIds.map((elementId) => ({
        elementType: '(selected ID)',
        elementId,
        reason: 'selected-id-not-found',
      })),
    ],
    truncated: result.truncated || selection.selectionTruncated === true,
    excludedMemberCount: selection.excludedMemberCount || 0,
    subsetCoverageComplete:
      result.subsetCoverageComplete === true &&
      selection.missingIds.length === 0 &&
      !selection.selectionTruncated,
    buildingCoverageVerified: false,
    quantityServiceUpdated: false,
  };
}

const workerScope =
  typeof globalThis.postMessage === 'function' && typeof globalThis.document === 'undefined'
    ? globalThis
    : null;

if (workerScope) {
  workerScope.onmessage = (event) => {
    const { type, requestId, payload } = event?.data || {};
    if (type !== 'start' || !Number.isSafeInteger(requestId)) return;
    try {
      const result = calculateCertifiedSubsetInWorker(payload, (progress) => {
        workerScope.postMessage({ type: 'progress', requestId, progress });
      });
      workerScope.postMessage({ type: 'result', requestId, result });
    } catch (error) {
      workerScope.postMessage({
        type: 'error',
        requestId,
        reason: error?.message || 'diagnostic-worker-failed',
      });
    }
  };
}
