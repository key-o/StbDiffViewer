/**
 * Conservative, Node/Browser-shared IFC restoration diagnostics for Issue #721.
 * Every classification describes an individual source field or the *unverified*
 * conversion of a classified element. No successful STB serialization or XSD
 * validation is assumed to preserve geometry, reinforcement or semantics.
 */

export const RESTORATION_STATUS = Object.freeze({
  PRESERVED: 'PRESERVED',
  SOURCE_ABSENT: 'SOURCE_ABSENT',
  UNSUPPORTED: 'UNSUPPORTED',
  TARGET_UNREPRESENTABLE: 'TARGET_UNREPRESENTABLE',
  CONFLICT_OR_INVALID: 'CONFLICT_OR_INVALID',
  LOST_OR_CHANGED: 'LOST_OR_CHANGED',
  UNVERIFIED: 'UNVERIFIED',
});

function recordFor(element, field, status, code, reason, targetElementId = null) {
  return {
    globalId: element.globalId ?? null,
    expressID: element.expressID ?? null,
    ifcType: element.ifcTypeName ?? null,
    targetStbType: element.stbType ?? null,
    targetElementId,
    field,
    status,
    code,
    reason,
    sourceRef: element.expressID ? `IFC:#${element.expressID}.${field}` : null,
  };
}

/**
 * Inventory of elements already classified by ElementClassifier. This does
 * NOT cover IFC classes which the classifier does not enumerate, or validate
 * the serialized STB. `outcomes` is positionally aligned to classified input.
 * @param {Object[]} classifiedElements
 * @param {(Object|null)[]} outcomes
 */
export function buildRestorationDiagnostics(classifiedElements, outcomes) {
  if (!Array.isArray(classifiedElements) || !Array.isArray(outcomes)) {
    throw new TypeError('IFC diagnostic inputs must be arrays');
  }
  if (classifiedElements.length !== outcomes.length) {
    throw new Error('IFC diagnostic inputs/outcomes must have equal lengths');
  }
  const records = [];
  let processedCount = 0;
  for (let i = 0; i < classifiedElements.length; i++) {
    const el = classifiedElements[i];
    const processed = outcomes[i];
    if (!el || typeof el !== 'object') throw new TypeError(`Invalid classified IFC element #${i}`);
    if (processed) processedCount++;
    records.push(
      recordFor(
        el,
        'element',
        RESTORATION_STATUS.UNVERIFIED,
        processed ? 'GENERATED_BUT_UNVERIFIED' : 'NO_STB_ELEMENT_GENERATED',
        processed
          ? 'STB element generated; geometry, properties and semantic preservation have not been verified'
          : 'Classified IFC element did not produce an STB element; cause requires review',
        processed?.id ?? null,
      ),
    );
    if (el.placementRef == null) {
      records.push(
        recordFor(
          el,
          'ObjectPlacement',
          RESTORATION_STATUS.SOURCE_ABSENT,
          'IFC_FIELD_NOT_PRESENT',
          'IFC ObjectPlacement is not explicitly provided; this does not prove missing STB geometry',
        ),
      );
    }
    if (el.representationRef == null) {
      records.push(
        recordFor(
          el,
          'Representation',
          RESTORATION_STATUS.SOURCE_ABSENT,
          'IFC_FIELD_NOT_PRESENT',
          'IFC Representation is not explicitly provided; alternate geometry is not evaluated',
        ),
      );
    }
  }
  return {
    schemaVersion: 1,
    overallStatus: RESTORATION_STATUS.UNVERIFIED,
    scope: 'classified-ifc-elements-only',
    classifiedElementCount: classifiedElements.length,
    processedElementCount: processedCount,
    unconvertedClassifiedCount: classifiedElements.length - processedCount,
    // Deliberately not a claim that the full IFC model has been inventoried.
    unenumeratedIfcTypesChecked: false,
    records,
  };
}
