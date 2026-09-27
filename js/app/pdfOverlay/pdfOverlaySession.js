import { createRegistrationInput, evaluateRegistration } from './registration.js';
import { inspectPdfRegionMapping } from './pdfOverlayRegion.js';
import {
  REGISTRATION_VALID_CODES,
  PDF_OVERLAY_SESSION_KIND,
  PDF_OVERLAY_SESSION_SCHEMA_VERSION,
  SessionError,
  assertRecord,
  assertPositiveInteger,
  cloneJson,
  drawingSnapshot,
  fail,
  normalizeDocument,
  normalizeDrawingMemo,
  normalizeMapping,
  normalizeMemberReview,
  normalizePlacement,
  normalizeRegion,
  normalizeRegistration,
  pageRenderSnapshot,
  pdfIdentitySnapshot,
  sameJson,
  stableStringify,
} from './pdfOverlaySessionSchema.js';

export {
  PDF_OVERLAY_REVIEW_STATES,
  PDF_OVERLAY_SESSION_KIND,
  PDF_OVERLAY_SESSION_SCHEMA_VERSION,
} from './pdfOverlaySessionSchema.js';

function pdfIdentityFromMapping(mapping) {
  return mapping
    ? {
        sha256: mapping.pdf.sha256,
        byteLength: mapping.pdf.byteLength,
        numPages: mapping.pdf.numPages,
      }
    : null;
}

function pageRenderFromMapping(mapping) {
  return mapping
    ? {
        pageNumber: mapping.pdf.pageNumber,
        viewBox: [...mapping.pdf.viewBox],
        userUnit: mapping.pdf.userUnit,
        intrinsicRotation: mapping.pdf.intrinsicRotation,
      }
    : null;
}

function registrationReadiness(registration) {
  if (!registration || !registration.anchors || !registration.matrix)
    return { ready: false, code: 'ALIGNMENT_MISSING', alignmentKey: null, evaluation: null };
  const evaluation = evaluateRegistration(
    createRegistrationInput(registration.anchors),
    registration.matrix,
    registration.policy,
  );
  if (!REGISTRATION_VALID_CODES.has(evaluation.code))
    return {
      ready: false,
      code: 'ALIGNMENT_INVALID',
      validationCode: evaluation.code,
      alignmentKey: null,
      evaluation,
    };
  return {
    ready: true,
    code: evaluation.code,
    alignmentKey: stableStringify(registration),
    evaluation,
  };
}

function placementReadiness(registration, placement) {
  const alignment = registrationReadiness(registration);
  if (alignment.ready) {
    return {
      ...alignment,
      mode: 'registration',
      changeCode: 'ALIGNMENT_CHANGED',
    };
  }
  if (placement) {
    return {
      ready: true,
      code: 'MANUAL_PLACEMENT',
      alignmentKey: stableStringify(placement),
      evaluation: null,
      mode: 'manual',
      changeCode: 'PLACEMENT_CHANGED',
    };
  }
  return {
    ...alignment,
    mode: null,
    changeCode: 'PLACEMENT_CHANGED',
  };
}

function documentRegionReadiness(document) {
  if (!document.pdfIdentity) return { ready: false, code: 'PDF_IDENTITY_MISSING', regionKey: null };
  if (!document.pageRender) return { ready: false, code: 'PAGE_CONTEXT_MISSING', regionKey: null };
  if (!document.drawing) return { ready: false, code: 'STB_IDENTITY_MISSING', regionKey: null };
  if (!document.regionMapping)
    return { ready: false, code: 'REGION_MAPPING_MISSING', regionKey: null };
  if (!sameJson(document.pdfIdentity, pdfIdentityFromMapping(document.regionMapping)))
    return { ready: false, code: 'PDF_CHANGED', regionKey: null };
  const mappingPage = pageRenderFromMapping(document.regionMapping);
  if (mappingPage.pageNumber !== document.pageRender.pageNumber)
    return { ready: false, code: 'PAGE_CHANGED', regionKey: null };
  if (!sameJson(mappingPage.viewBox, document.pageRender.viewBox))
    return { ready: false, code: 'PAGE_VIEW_CHANGED', regionKey: null };
  if (mappingPage.userUnit !== document.pageRender.userUnit)
    return { ready: false, code: 'USER_UNIT_CHANGED', regionKey: null };
  if (mappingPage.intrinsicRotation !== document.pageRender.intrinsicRotation)
    return { ready: false, code: 'PDF_ROTATION_CHANGED', regionKey: null };
  if (document.pageNumber !== document.regionMapping.pdf.pageNumber)
    return { ready: false, code: 'PAGE_CHANGED', regionKey: null };
  if (!sameJson(document.selectedRegion, document.regionMapping.region))
    return { ready: false, code: 'REGION_CHANGED', regionKey: null };
  if (document.regionMapping.stb.modelKey !== document.drawing.source.modelKey)
    return { ready: false, code: 'MODEL_CHANGED', regionKey: null };
  if (document.regionMapping.stb.modelRevision !== document.drawing.source.modelRevision)
    return { ready: false, code: 'STB_CHANGED', regionKey: null };
  if (!sameJson(document.regionMapping.stb.view, document.drawing.view))
    return { ready: false, code: 'STB_VIEW_CHANGED', regionKey: null };
  return { ready: true, code: 'CURRENT', regionKey: document.regionMapping.key };
}

function assessCurrentDocument(document, current = {}) {
  const pdfIdentity = pdfIdentitySnapshot(current.pdfInfo ?? null, 'current.pdfInfo');
  if (!pdfIdentity || !document.pdfIdentity)
    return { ready: false, code: 'PDF_IDENTITY_MISSING', regionKey: null, alignmentKey: null };
  if (pdfIdentity.sha256 !== document.pdfIdentity.sha256)
    return { ready: false, code: 'PDF_CHANGED', regionKey: null, alignmentKey: null };
  if (pdfIdentity.byteLength !== document.pdfIdentity.byteLength)
    return { ready: false, code: 'PDF_BYTES_CHANGED', regionKey: null, alignmentKey: null };
  if (pdfIdentity.numPages !== document.pdfIdentity.numPages)
    return { ready: false, code: 'PDF_PAGE_COUNT_CHANGED', regionKey: null, alignmentKey: null };

  const pageRender = pageRenderSnapshot(current.pageRender ?? null, 'current.pageRender');
  if (!pageRender || !document.pageRender)
    return { ready: false, code: 'PAGE_CONTEXT_MISSING', regionKey: null, alignmentKey: null };
  if (pageRender.pageNumber !== document.pageRender.pageNumber)
    return { ready: false, code: 'PAGE_CHANGED', regionKey: null, alignmentKey: null };
  if (!sameJson(pageRender.viewBox, document.pageRender.viewBox))
    return { ready: false, code: 'PAGE_VIEW_CHANGED', regionKey: null, alignmentKey: null };
  if (pageRender.userUnit !== document.pageRender.userUnit)
    return { ready: false, code: 'USER_UNIT_CHANGED', regionKey: null, alignmentKey: null };
  if (pageRender.intrinsicRotation !== document.pageRender.intrinsicRotation)
    return { ready: false, code: 'PDF_ROTATION_CHANGED', regionKey: null, alignmentKey: null };

  const drawing = drawingSnapshot(current.drawing ?? null, 'current.drawing');
  if (!drawing || !document.drawing)
    return { ready: false, code: 'STB_IDENTITY_MISSING', regionKey: null, alignmentKey: null };
  if (drawing.source.modelKey !== document.drawing.source.modelKey)
    return { ready: false, code: 'MODEL_CHANGED', regionKey: null, alignmentKey: null };
  if (drawing.source.modelRevision !== document.drawing.source.modelRevision)
    return { ready: false, code: 'STB_CHANGED', regionKey: null, alignmentKey: null };
  if (!sameJson(drawing.view, document.drawing.view))
    return { ready: false, code: 'STB_VIEW_CHANGED', regionKey: null, alignmentKey: null };

  const currentMapping = Object.prototype.hasOwnProperty.call(current, 'regionMapping')
    ? normalizeMapping(current.regionMapping, 'current.regionMapping')
    : document.regionMapping;
  if (!currentMapping || !document.regionMapping)
    return { ready: false, code: 'REGION_MAPPING_MISSING', regionKey: null, alignmentKey: null };
  if (currentMapping.key !== document.regionMapping.key)
    return { ready: false, code: 'REGION_CHANGED', regionKey: null, alignmentKey: null };
  const mappingStatus = inspectPdfRegionMapping(document.regionMapping, {
    pdfInfo: current.pdfInfo,
    pageRender,
    drawing,
  });
  if (!mappingStatus.current)
    return { ready: false, code: mappingStatus.code, regionKey: null, alignmentKey: null };

  const currentPageNumber = current.pageNumber ?? pageRender.pageNumber;
  if (currentPageNumber !== document.pageNumber)
    return { ready: false, code: 'PAGE_CHANGED', regionKey: null, alignmentKey: null };
  if (Object.prototype.hasOwnProperty.call(current, 'selectedRegion')) {
    const selectedRegion = normalizeRegion(current.selectedRegion, 'current.selectedRegion');
    if (!sameJson(selectedRegion, document.selectedRegion))
      return { ready: false, code: 'REGION_CHANGED', regionKey: null, alignmentKey: null };
  }

  const internalRegion = documentRegionReadiness(document);
  if (!internalRegion.ready)
    return { ready: false, code: internalRegion.code, regionKey: null, alignmentKey: null };
  const registration = Object.prototype.hasOwnProperty.call(current, 'registration')
    ? normalizeRegistration(current.registration, 'current.registration')
    : document.registration;
  const placement = Object.prototype.hasOwnProperty.call(current, 'placement')
    ? normalizePlacement(current.placement, 'current.placement')
    : document.placement;
  const currentPlacement = placementReadiness(registration, placement);
  if (!currentPlacement.ready)
    return {
      ready: false,
      code: currentPlacement.code,
      validationCode: currentPlacement.validationCode,
      regionKey: currentMapping.key,
      alignmentKey: null,
      placementMode: currentPlacement.mode,
      placementChangeCode: currentPlacement.changeCode,
    };
  const expectedPlacement = placementReadiness(document.registration, document.placement);
  if (!expectedPlacement.ready)
    return {
      ready: false,
      code: expectedPlacement.code,
      validationCode: expectedPlacement.validationCode,
      regionKey: currentMapping.key,
      alignmentKey: currentPlacement.alignmentKey,
      placementMode: currentPlacement.mode,
      placementChangeCode: currentPlacement.changeCode,
    };
  if (currentPlacement.alignmentKey !== expectedPlacement.alignmentKey) {
    const changeCode =
      currentPlacement.mode === 'registration' || expectedPlacement.mode === 'registration'
        ? 'ALIGNMENT_CHANGED'
        : 'PLACEMENT_CHANGED';
    return {
      ready: false,
      code: changeCode,
      regionKey: currentMapping.key,
      alignmentKey: currentPlacement.alignmentKey,
      placementMode: currentPlacement.mode,
      placementChangeCode: changeCode,
    };
  }
  return {
    ready: true,
    code: 'CURRENT',
    regionKey: currentMapping.key,
    alignmentKey: currentPlacement.alignmentKey,
    alignmentCode: currentPlacement.code,
    placementMode: currentPlacement.mode,
    placementChangeCode: currentPlacement.changeCode,
  };
}

function normalizeCreateInput(input = {}) {
  assertRecord(input, 'input');
  const regionMapping = normalizeMapping(input.regionMapping ?? null, 'regionMapping');
  const pdfInfo = input.pdfInfo ?? pdfIdentityFromMapping(regionMapping);
  const pdfIdentity = pdfIdentitySnapshot(pdfInfo, 'pdfInfo');
  const pageRenderInput = input.pageRender ?? pageRenderFromMapping(regionMapping);
  const pageRender = pageRenderSnapshot(pageRenderInput, 'pageRender');
  const pageNumber =
    input.pageNumber ?? pageRender?.pageNumber ?? regionMapping?.pdf.pageNumber ?? null;
  const selectedRegion = normalizeRegion(
    input.selectedRegion ?? regionMapping?.region ?? null,
    'selectedRegion',
  );
  if (!Array.isArray(input.memberReviews ?? []))
    fail('INVALID_TYPE', 'memberReviews', 'memberReviews must be an array.');
  if (!Array.isArray(input.drawingMemos ?? []))
    fail('INVALID_TYPE', 'drawingMemos', 'drawingMemos must be an array.');
  const document = {
    kind: PDF_OVERLAY_SESSION_KIND,
    schemaVersion: PDF_OVERLAY_SESSION_SCHEMA_VERSION,
    pdfIdentity,
    pageRender,
    pageNumber: pageNumber == null ? null : assertPositiveInteger(pageNumber, 'pageNumber'),
    selectedRegion,
    regionMapping,
    drawing: drawingSnapshot(input.drawing ?? null, 'drawing'),
    registration: normalizeRegistration(input.registration ?? null),
    placement: normalizePlacement(input.placement ?? null),
    memberReviews: (input.memberReviews ?? []).map(normalizeMemberReview),
    drawingMemos: (input.drawingMemos ?? []).map(normalizeDrawingMemo),
  };
  const validated = normalizeDocument(document);
  const seen = new Set();
  for (const [index, memo] of validated.drawingMemos.entries()) {
    if (seen.has(memo.id))
      fail(
        'DUPLICATE_DRAWING_MEMO',
        `drawingMemos[${index}].id`,
        'Drawing memo IDs must be unique.',
      );
    seen.add(memo.id);
  }
  const readiness = documentRegionReadiness(validated);
  const placement = placementReadiness(validated.registration, validated.placement);
  const ready = readiness.ready && placement.ready;
  const context = ready
    ? { regionKey: readiness.regionKey, alignmentKey: placement.alignmentKey }
    : null;
  validated.memberReviews = validated.memberReviews.map((review) => {
    const existingContext = review.reviewContext;
    let invalidationCode = null;
    let reviewState = review.reviewState;
    if (!ready) invalidationCode = !readiness.ready ? readiness.code : placement.code;
    else if (review.identity[0] !== validated.drawing?.source?.modelKey)
      invalidationCode = 'MEMBER_MODEL_CHANGED';
    else if (existingContext && existingContext.regionKey !== context.regionKey)
      invalidationCode = 'REGION_CHANGED';
    else if (existingContext && existingContext.alignmentKey !== context.alignmentKey)
      invalidationCode = placement.changeCode;
    if (reviewState !== 'unreviewed' && invalidationCode) reviewState = 'unreviewed';
    return {
      ...review,
      reviewState,
      reviewContext: context,
      invalidationCode,
    };
  });
  return validated;
}

/** Create a new v1 document from live UI state; stale review states are downgraded. */
export function createPdfOverlaySession(input = {}) {
  return normalizeCreateInput(input);
}

/** Validate and normalize a session document without mutating the supplied value. */
export function validatePdfOverlaySession(value) {
  try {
    return { valid: true, code: 'VALID', issues: [], document: normalizeDocument(value) };
  } catch (error) {
    const issue = {
      code: error instanceof SessionError ? error.code : 'INVALID_DOCUMENT',
      path: error instanceof SessionError ? error.path : '$',
      message: error?.message || 'Invalid session document.',
    };
    return { valid: false, code: issue.code, issues: [issue] };
  }
}

/** Serialize only a fully valid v1 document. */
export function serializePdfOverlaySession(value) {
  const result = validatePdfOverlaySession(value);
  if (!result.valid)
    throw new TypeError(`${result.code}: ${result.issues[0]?.message || 'Invalid session.'}`);
  return JSON.stringify(result.document, null, 2);
}

/** Parse JSON or an object into a staged document; no application state is changed. */
export function parsePdfOverlaySession(jsonOrObject) {
  let value = jsonOrObject;
  if (typeof jsonOrObject === 'string') {
    try {
      value = JSON.parse(jsonOrObject);
    } catch (error) {
      return {
        valid: false,
        code: 'INVALID_JSON',
        issues: [{ code: 'INVALID_JSON', path: '$', message: error?.message || 'Invalid JSON.' }],
      };
    }
  }
  return validatePdfOverlaySession(value);
}

function reviewInvalidationCode(document, current, assessment, review) {
  if (!assessment.ready) return assessment.code;
  if (review.identity[0] !== current.drawing?.source?.modelKey)
    return current.drawing ? 'MEMBER_MODEL_CHANGED' : 'STB_IDENTITY_MISSING';
  if (!review.reviewContext) return 'REVIEW_CONTEXT_MISSING';
  if (review.reviewContext.regionKey !== assessment.regionKey) return 'REGION_CHANGED';
  if (review.reviewContext.alignmentKey !== assessment.alignmentKey)
    return assessment.placementChangeCode || 'ALIGNMENT_CHANGED';
  return null;
}

function memoInvalidationCode(document, current, memo) {
  const pdfIdentity = pdfIdentitySnapshot(current.pdfInfo ?? null, 'current.pdfInfo');
  if (!pdfIdentity || !document.pdfIdentity) return 'PDF_IDENTITY_MISSING';
  if (pdfIdentity.sha256 !== document.pdfIdentity.sha256) return 'PDF_CHANGED';
  if (pdfIdentity.byteLength !== document.pdfIdentity.byteLength) return 'PDF_BYTES_CHANGED';
  if (pdfIdentity.numPages !== document.pdfIdentity.numPages) return 'PDF_PAGE_COUNT_CHANGED';
  const pageNumber = current.pageNumber ?? current.pageRender?.pageNumber ?? null;
  if (memo.pageNumber != null && pageNumber !== memo.pageNumber) return 'PAGE_CHANGED';
  return null;
}

/**
 * Reconcile an imported document against current PDF/STB/placement inputs.
 * The returned document is a staged copy; confirmed/mismatch never survives a missing or changed condition.
 */
export function reconcilePdfOverlaySession(value, current = {}) {
  const validation = validatePdfOverlaySession(value);
  if (!validation.valid) return { valid: false, code: validation.code, issues: validation.issues };
  try {
    const document = validation.document;
    assertRecord(current, 'current');
    const assessment = assessCurrentDocument(document, current);
    const staged = cloneJson(document);
    let invalidatedCount = 0;
    staged.memberReviews = staged.memberReviews.map((review) => {
      const invalidationCode = reviewInvalidationCode(document, current, assessment, review);
      let reviewState = review.reviewState;
      if (reviewState !== 'unreviewed' && invalidationCode) {
        reviewState = 'unreviewed';
        invalidatedCount += 1;
      }
      const reviewContext = assessment.ready
        ? { regionKey: assessment.regionKey, alignmentKey: assessment.alignmentKey }
        : review.reviewContext;
      return { ...review, reviewState, reviewContext, invalidationCode };
    });
    const drawingMemoStatuses = staged.drawingMemos.map((memo) => {
      const invalidationCode = memoInvalidationCode(document, current, memo);
      return { id: memo.id, active: invalidationCode == null, invalidationCode };
    });
    const memberReviewStatuses = staged.memberReviews.map((review) => ({
      identity: [...review.identity],
      reviewState: review.reviewState,
      invalidationCode: review.invalidationCode,
    }));
    return {
      valid: true,
      code: assessment.ready ? 'CURRENT' : assessment.code,
      document: staged,
      invalidatedCount,
      regionStatus: {
        current: assessment.ready,
        code: assessment.ready ? 'CURRENT' : assessment.code,
      },
      alignmentStatus: {
        current: assessment.placementMode === 'registration' && Boolean(assessment.alignmentKey),
        code: assessment.placementMode === 'registration' ? assessment.alignmentCode : 'NOT_USED',
      },
      placementStatus: {
        current: Boolean(assessment.alignmentKey),
        mode: assessment.placementMode || null,
        code: assessment.alignmentKey ? assessment.alignmentCode : assessment.code,
      },
      memberReviewStatuses,
      drawingMemoStatuses,
    };
  } catch (error) {
    const issue = {
      code: error instanceof SessionError ? error.code : 'INVALID_CURRENT_CONTEXT',
      path: error instanceof SessionError ? error.path : 'current',
      message: error?.message || 'Invalid current context.',
    };
    return { valid: false, code: issue.code, issues: [issue] };
  }
}
