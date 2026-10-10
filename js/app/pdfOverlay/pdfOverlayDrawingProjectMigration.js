/**
 * @fileoverview 旧pdfOverlay sessionからDrawingProject v1へ移すpure adapter。
 *
 * PDF固有のレビュー/メモはDrawingProject v1へ黙って取り込まない。
 * 旧tag placementはsemantic anchorを推測せず、model-fixed intentとして保存する。
 */
import { reconcilePdfOverlaySession, validatePdfOverlaySession } from './pdfOverlaySession.js';
import {
  DRAWING_PROJECT_KIND,
  createModelFixedTagIntentFromLegacyPlacement,
  normalizeDrawingProject,
} from '../../data/drawing/drawingProjectSchema.js';
import { planViewContextSnapshot } from '../../data/drawing/drawingModel.js';

function requiredString(value, name) {
  if (value == null || !String(value).trim()) throw new TypeError(name + 'が必要です。');
  return String(value).trim();
}

function finiteScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new RangeError('図面縮尺分母が不正です。');
  return number;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  return value;
}

function sameView(left, right) {
  return (
    JSON.stringify(canonicalJson(planViewContextSnapshot(left))) ===
    JSON.stringify(canonicalJson(planViewContextSnapshot(right)))
  );
}

function identityKey(identity) {
  return JSON.stringify(identity.map(String));
}

function defaultEntityId(identity) {
  return ['legacy', ...identity.map((value) => encodeURIComponent(String(value)))].join(':');
}

function reviewRecordId(entityId, sourceRevisionId, view) {
  return ['review', entityId, sourceRevisionId, view.type, view.storyId]
    .map((value) => encodeURIComponent(String(value)))
    .join(':');
}

function findDrawingRecord(drawingModel, identity) {
  if (!drawingModel) return null;
  const [modelKey, elementType, elementId] = identity.map(String);
  return (
    (drawingModel.elements || []).find(
      (record) =>
        String(record.ref?.modelKey) === modelKey &&
        String(record.ref?.elementType) === elementType &&
        String(record.ref?.elementId) === elementId,
    ) || null
  );
}

function validateDrawingModel(drawingModel, drawing) {
  if (!drawingModel) return;
  if (
    drawingModel.source?.modelKey !== drawing.source.modelKey ||
    drawingModel.source?.modelRevision !== drawing.source.modelRevision ||
    !sameView(drawingModel.view, drawing.view)
  ) {
    throw new Error('DrawingModelが旧sessionのSTB drawing contextと一致しません。');
  }
}

function reconcileLegacySessionAgainstSavedContext(document) {
  const result = reconcilePdfOverlaySession(document, {
    pdfInfo: document.pdfIdentity,
    pageRender: document.pageRender,
    pageNumber: document.pageNumber,
    selectedRegion: document.selectedRegion,
    regionMapping: document.regionMapping,
    drawing: document.drawing,
    drawingRotationDeg: document.drawingRotationDeg,
    registration: document.registration,
    placement: document.placement,
  });
  if (!result.valid || !result.document) {
    const issue = result.issues?.[0];
    throw new Error(
      'pdfOverlay sessionの保存済みcontextを再評価できません: ' +
        (issue?.code || result.code || 'SESSION_RECONCILE_FAILED') +
        (issue?.message ? ' / ' + issue.message : ''),
    );
  }
  return result.document;
}

function sourceSha256From({ sourceSha256, modelRevision }) {
  const candidate = sourceSha256 ?? modelRevision;
  const normalized = String(candidate || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      'DrawingProject移行にはSTB原本SHA-256が必要です。旧sessionのmodelRevisionがSHA-256でない場合はsourceSha256を指定してください。',
    );
  }
  return normalized;
}

function bindingSourceRef(identity, drawingRecord) {
  const [, elementType, elementId] = identity.map(String);
  return {
    elementType,
    elementId,
    guid: drawingRecord?.ref?.guid == null ? null : String(drawingRecord.ref.guid),
  };
}

function migrationDiagnostics(
  { legacyPdfMemoCount = 0, staleModelMemoCount = 0 } = {},
  { displaySettingsProvided = false } = {},
) {
  const diagnostics = [];
  if (legacyPdfMemoCount) {
    diagnostics.push({
      code: 'PDF_DRAWING_MEMOS_NOT_MIGRATED',
      count: legacyPdfMemoCount,
      detail: 'PDF座標依存の図面メモはDrawingProject v1へ移行しません。',
    });
  }
  if (staleModelMemoCount) {
    diagnostics.push({
      code: 'STALE_DRAWING_MEMOS_NOT_MIGRATED',
      count: staleModelMemoCount,
      detail: '現在のSTB drawing contextと一致しないmodel-mmメモは自動再関連付けしません。',
    });
  }
  if (!displaySettingsProvided) {
    diagnostics.push({
      code: 'LEGACY_DISPLAY_SETTINGS_NOT_AVAILABLE',
      count: 1,
      detail:
        '旧pdfOverlay sessionは全Drawing表示設定を保持しないため、表示レイヤ/タグmodeは別契約で再設定が必要です。',
    });
  }
  return diagnostics;
}

function planViewSnapshot(view) {
  if (!view || view.type !== 'plan' || view.storyId == null)
    throw new TypeError('DrawingProject review/annotationにはplan viewが必要です。');
  return { type: 'plan', storyId: String(view.storyId) };
}

function drawingContextMatches(left, drawing) {
  return Boolean(
    left?.source?.modelKey === drawing.source?.modelKey &&
    left?.source?.modelRevision === drawing.source?.modelRevision &&
    sameView(left.view, drawing.view),
  );
}
/**
 * PDFに依存しないDrawing Workspace runtime stateからDrawingProjectを作る。
 * review/annotationはsource revision + view contextを明示保存し、自動rebindしない。
 * @returns {{project: Object, diagnostics: Array<Object>}}
 */
export function createDrawingProjectFromWorkspaceState({
  drawing,
  projectId,
  modelSlotId = 'structure',
  drawingId = null,
  sourceRevisionId = null,
  sourceSha256 = null,
  paper = 'A3',
  orientation = 'landscape',
  scaleDenominator = null,
  drawingRotationDeg = 0,
  tagOrientationMode = 'follow-member',
  displaySettings = null,
  tagFamilyState = null,
  memberReviews = [],
  drawingMemos = [],
  tagPlacements = [],
  entityIdForIdentity = defaultEntityId,
  includeLegacyDisplayDiagnostic = false,
  allowMissingDrawingRecords = false,
} = {}) {
  if (!drawing?.source?.modelKey || !drawing?.source?.modelRevision || !drawing?.view)
    throw new Error('STB drawing contextが必要です。');
  if (!Array.isArray(memberReviews)) throw new TypeError('memberReviews must be an array.');
  if (!Array.isArray(drawingMemos)) throw new TypeError('drawingMemos must be an array.');
  if (!Array.isArray(tagPlacements)) throw new TypeError('tagPlacements must be an array.');

  const projectKey = requiredString(projectId, 'projectId');
  const slotId = requiredString(modelSlotId, 'modelSlotId');
  const revisionId = requiredString(
    sourceRevisionId ?? drawing.source.modelRevision,
    'sourceRevisionId',
  );
  const sha256 = sourceSha256From({ sourceSha256, modelRevision: drawing.source.modelRevision });
  const resolvedDrawingId = requiredString(
    drawingId ?? ['drawing', slotId, drawing.view.type, drawing.view.storyId].join(':'),
    'drawingId',
  );
  const scale = finiteScale(scaleDenominator);
  const contextView = planViewSnapshot(drawing.view);

  const bindingsByIdentity = new Map();
  const runtimeStoryRef = drawing.view.storySourceRef;
  let storyBinding = null;
  let view = contextView;
  if (runtimeStoryRef != null) {
    const storySourceRef = {
      elementType: String(runtimeStoryRef.elementType),
      elementId: String(runtimeStoryRef.elementId),
      guid: runtimeStoryRef.guid == null ? null : String(runtimeStoryRef.guid),
    };
    if (storySourceRef.elementType !== 'Story' || storySourceRef.elementId !== contextView.storyId)
      throw new Error('DrawingModelのstorySourceRefが現在のplan viewと一致しません。');
    const storyIdentity = [String(drawing.source.modelKey), 'Story', storySourceRef.elementId];
    const storyEntityId = requiredString(entityIdForIdentity(storyIdentity), 'storyEntityId');
    storyBinding = {
      entityId: storyEntityId,
      modelSlotId: slotId,
      revisions: [
        {
          sourceRevisionId: revisionId,
          sourceRef: storySourceRef,
        },
      ],
    };
    view = {
      ...contextView,
      storyBinding: { entityId: storyEntityId },
    };
  }
  const ensureBinding = (identity, sourceLabel) => {
    if (!Array.isArray(identity) || identity.length !== 3)
      throw new TypeError(sourceLabel + '.identityが不正です。');
    const normalizedIdentity = identity.map(String);
    if (normalizedIdentity[0] !== String(drawing.source.modelKey))
      throw new Error(
        sourceLabel + '.identityのmodelKeyが現在のdrawingと一致しません: ' + normalizedIdentity[0],
      );
    const key = identityKey(normalizedIdentity);
    if (bindingsByIdentity.has(key)) return bindingsByIdentity.get(key);
    const drawingRecord = findDrawingRecord(drawing, normalizedIdentity);
    if (!drawingRecord && !allowMissingDrawingRecords)
      throw new Error(
        sourceLabel + 'の対象部材が現在のDrawingModelにありません: ' + normalizedIdentity.join('/'),
      );
    const entityId = requiredString(entityIdForIdentity(normalizedIdentity), 'entityId');
    const binding = {
      entityId,
      modelSlotId: slotId,
      revisions: [
        {
          sourceRevisionId: revisionId,
          sourceRef: bindingSourceRef(normalizedIdentity, drawingRecord),
        },
      ],
    };
    bindingsByIdentity.set(key, binding);
    return binding;
  };

  const dimensionReferenceById = new Map();
  for (const [index, reference] of (drawing.dimensionReferences || []).entries()) {
    if (typeof reference?.id !== 'string' || !reference.id)
      throw new TypeError(`drawing.dimensionReferences[${index}].idが不正です。`);
    if (dimensionReferenceById.has(reference.id))
      throw new Error(`drawing.dimensionReferences idが重複しています: ${reference.id}`);
    dimensionReferenceById.set(reference.id, reference);
  }
  const ensureDimensionBinding = (referenceId, sourceLabel) => {
    const reference = dimensionReferenceById.get(referenceId);
    if (!reference)
      throw new Error(
        sourceLabel + 'のsemantic axis参照がDrawingModelにありません: ' + referenceId,
      );
    if (
      String(reference.sourceRef?.elementType) !== 'ParallelAxis' ||
      reference.sourceRef?.elementId == null ||
      !String(reference.sourceRef.elementId).trim()
    )
      throw new Error(sourceLabel + 'のaxis sourceRefが不正です。');
    const identity = [
      String(drawing.source.modelKey),
      String(reference.sourceRef.elementType),
      String(reference.sourceRef.elementId),
    ];
    const key = identityKey(identity);
    if (bindingsByIdentity.has(key)) return bindingsByIdentity.get(key);
    const entityId = requiredString(entityIdForIdentity(identity), 'entityId');
    const binding = {
      entityId,
      modelSlotId: slotId,
      revisions: [
        {
          sourceRevisionId: revisionId,
          sourceRef: {
            elementType: 'ParallelAxis',
            elementId: String(reference.sourceRef.elementId),
            guid: reference.sourceRef.guid == null ? null : String(reference.sourceRef.guid),
          },
        },
      ],
    };
    bindingsByIdentity.set(key, binding);
    return binding;
  };

  const tagIntents = [];
  for (const [index, placement] of tagPlacements.entries()) {
    if (!drawingContextMatches(placement.drawing, drawing))
      throw new Error(
        'tagPlacements[' + index + ']のdrawing contextが現在のdrawingと一致しません。',
      );
    const binding = ensureBinding(placement.identity, 'tagPlacements[' + index + ']');
    tagIntents.push(
      createModelFixedTagIntentFromLegacyPlacement({
        id: 'legacy-tag:' + index + ':' + placement.template.id,
        entityId: binding.entityId,
        template: placement.template,
        anchorModel: placement.anchorModel,
        offsetModel: placement.offsetModel,
        rotationDeg: placement.rotationDeg,
        leader: placement.leader,
      }),
    );
  }

  const dimensionIntents = (drawing.dimensionIntents || []).map((intent, intentIndex) => {
    if (intent?.kind !== 'linear-chain')
      throw new Error(
        `drawing.dimensionIntents[${intentIndex}]はlinear-chainである必要があります。`,
      );
    if (!Array.isArray(intent.references) || intent.references.length < 2)
      throw new Error(`drawing.dimensionIntents[${intentIndex}].referencesが不正です。`);
    if (!Number.isFinite(intent.placement?.offsetModelMm))
      throw new Error(`drawing.dimensionIntents[${intentIndex}].placementが不正です。`);
    return {
      id: requiredString(intent.id, `drawing.dimensionIntents[${intentIndex}].id`),
      kind: 'linear-chain',
      references: intent.references.map((reference, referenceIndex) => {
        if (reference?.kind !== 'axis')
          throw new Error(
            `drawing.dimensionIntents[${intentIndex}].references[${referenceIndex}]はsemantic axis参照である必要があります。`,
          );
        const binding = ensureDimensionBinding(
          reference.axisId,
          `drawing.dimensionIntents[${intentIndex}].references[${referenceIndex}]`,
        );
        return { kind: 'axis-binding', binding: { entityId: binding.entityId } };
      }),
      placement: { offsetModelMm: intent.placement.offsetModelMm },
      familyId: requiredString(
        intent.familyId,
        `drawing.dimensionIntents[${intentIndex}].familyId`,
      ),
    };
  });

  const persistedReviews = memberReviews.map((review, index) => {
    if (!Array.isArray(review.identity) || review.identity.length !== 3)
      throw new TypeError('memberReviews[' + index + '].identityが不正です。');
    const binding = ensureBinding(review.identity, 'memberReviews[' + index + ']');
    const reviewState = String(review.reviewState || 'unreviewed');
    if (!['unreviewed', 'confirmed', 'mismatch'].includes(reviewState))
      throw new TypeError('memberReviews[' + index + '].reviewStateが不正です。');
    return {
      id: reviewRecordId(binding.entityId, revisionId, contextView),
      binding: { entityId: binding.entityId },
      context: { sourceRevisionId: revisionId, view: contextView },
      reviewState,
      memo: typeof review.memo === 'string' ? review.memo : '',
    };
  });

  const annotations = [];
  let legacyPdfMemoCount = 0;
  let staleModelMemoCount = 0;
  for (const memo of drawingMemos) {
    if (Array.isArray(memo.modelPoint) && memo.drawing) {
      if (!drawingContextMatches(memo.drawing, drawing)) {
        staleModelMemoCount += 1;
        continue;
      }
      annotations.push({
        id: requiredString(memo.id, 'drawingMemo.id'),
        type: 'text',
        context: { sourceRevisionId: revisionId, view: contextView },
        anchor: { frame: 'model', unit: 'mm', xy: [...memo.modelPoint] },
        text: typeof memo.text === 'string' ? memo.text : '',
      });
      continue;
    }
    legacyPdfMemoCount += 1;
  }

  const project = normalizeDrawingProject({
    kind: DRAWING_PROJECT_KIND,
    schemaVersion: 1,
    units: { model: 'mm', paper: 'mm' },
    projectId: projectKey,
    modelSlots: [
      {
        id: slotId,
        currentRevisionId: revisionId,
        revisions: [{ id: revisionId, sha256 }],
      },
    ],
    bindings: [...bindingsByIdentity.values(), ...(storyBinding ? [storyBinding] : [])],
    drawingDocuments: [
      {
        id: resolvedDrawingId,
        modelSlotId: slotId,
        sourceRevisionId: revisionId,
        view,
        sheet: {
          paper,
          orientation,
          scaleDenominator: scale,
          rotationDeg: drawingRotationDeg,
          tagOrientationMode,
        },
        display: displaySettings ?? {},
        tagIntents,
        dimensionIntents,
        memberReviews: persistedReviews,
        annotations,
      },
    ],
    definitions: {
      tagFamilyState: tagFamilyState ?? undefined,
    },
  });

  return {
    project,
    diagnostics: migrationDiagnostics(
      { legacyPdfMemoCount, staleModelMemoCount },
      { displaySettingsProvided: displaySettings != null || !includeLegacyDisplayDiagnostic },
    ),
  };
}

/**
 * @returns {{project: Object, diagnostics: Array<Object>}}
 */
export function migratePdfOverlaySessionToDrawingProject({
  session,
  projectId,
  modelSlotId = 'structure',
  drawingId = null,
  sourceRevisionId = null,
  sourceSha256 = null,
  paper = 'A3',
  orientation = 'landscape',
  scaleDenominator = null,
  displaySettings = null,
  drawingModel = null,
  entityIdForIdentity = defaultEntityId,
} = {}) {
  const validation = validatePdfOverlaySession(session);
  if (!validation.valid || !validation.document) {
    const issue = validation.issues?.[0];
    throw new Error(
      'pdfOverlay sessionをDrawingProjectへ移行できません: ' +
        (issue?.code || validation.code || 'SESSION_INVALID') +
        (issue?.message ? ' / ' + issue.message : ''),
    );
  }

  // Structural validation alone does not prove a saved legacy review is still current.
  // Reconcile against the session's own saved context so missing/mismatched reviewContext
  // cannot preserve confirmed/mismatch when promoted into revision-bound history.
  const document = reconcileLegacySessionAgainstSavedContext(validation.document);
  const drawing = document.drawing;
  if (!drawing) throw new Error('STB drawing contextのないpdfOverlay sessionは移行できません。');
  validateDrawingModel(drawingModel, drawing);

  return createDrawingProjectFromWorkspaceState({
    drawing: drawingModel ?? drawing,
    projectId,
    modelSlotId,
    drawingId,
    sourceRevisionId,
    sourceSha256,
    paper,
    orientation,
    scaleDenominator: scaleDenominator ?? document.placement?.scaleDenominator,
    drawingRotationDeg: document.drawingRotationDeg,
    tagOrientationMode: document.tagOrientationMode,
    displaySettings,
    tagFamilyState: document.tagFamilyState,
    memberReviews: document.memberReviews,
    drawingMemos: document.drawingMemos,
    tagPlacements: document.tagPlacements,
    entityIdForIdentity,
    includeLegacyDisplayDiagnostic: true,
    allowMissingDrawingRecords: drawingModel == null,
  });
}

function sourceRefMatches(left, right) {
  return (
    String(left?.elementType) === String(right?.elementType) &&
    String(left?.elementId) === String(right?.elementId) &&
    (left?.guid == null || String(left.guid) === String(right?.guid))
  );
}

function drawingRecordInvalidationCode(record) {
  if (!record) return 'MEMBER_MISSING';
  if (record.state == null || record.state === 'drawn') return null;
  if (record.state === 'outside-view') return 'MEMBER_OUTSIDE_VIEW';
  if (record.state === 'failed') return 'MEMBER_DRAWING_FAILED';
  return 'MEMBER_NOT_DRAWN';
}

function drawingDocumentById(project, drawingId) {
  const document = project.drawingDocuments.find((item) => item.id === drawingId);
  if (!document) throw new Error('DrawingDocumentがありません: ' + drawingId);
  return document;
}

function revisionForDrawing(project, document, drawingModel) {
  const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
  if (!slot) return null;
  const revisionKey = String(drawingModel?.source?.modelRevision || '').toLowerCase();
  return (
    slot.revisions.find(
      (revision) =>
        revision.id === drawingModel?.source?.modelRevision || revision.sha256 === revisionKey,
    ) || null
  );
}

function bindingRevision(project, document, entityId, sourceRevisionId) {
  const binding = project.bindings.find(
    (item) => item.entityId === entityId && item.modelSlotId === document.modelSlotId,
  );
  if (!binding) return null;
  const revision = binding.revisions.find((item) => item.sourceRevisionId === sourceRevisionId);
  return revision ? { binding, revision } : null;
}

/**
 * 保存済みreview/annotationのview contextを現在のplan viewと比較する。
 * 明示storyBindingは、document/当該改訂binding/runtime Storyで検証してから
 * 同等の正規化view同士で比較する。不一致bindingは無視せず不一致として扱う。
 */
function contextViewMatches({ project, document, context, drawingModel, currentView }) {
  const { storyBinding, ...planView } = context.view;
  if (storyBinding) {
    const expected = document.view?.storyBinding;
    if (!expected || expected.entityId !== storyBinding.entityId) return false;
    const mapped = bindingRevision(
      project,
      document,
      storyBinding.entityId,
      context.sourceRevisionId,
    );
    const ref = mapped?.revision.sourceRef;
    if (!ref || ref.elementType !== 'Story' || ref.elementId !== String(planView.storyId))
      return false;
    const runtimeRef = drawingModel.view?.storySourceRef;
    if (runtimeRef?.guid != null && ref.guid != null && String(runtimeRef.guid) !== ref.guid)
      return false;
  }
  return sameView(planView, currentView);
}

/**
 * DrawingProjectのreview/annotationを現在のDrawingModelへfail-closedで復元する。
 * 異なるrevision/viewは履歴として保持されるが、現在のruntime stateへ自動継承しない。
 */
export function restoreDrawingWorkspaceReviewState({ project, drawingId, drawingModel } = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = drawingDocumentById(normalized, requiredString(drawingId, 'drawingId'));
  if (
    !drawingModel?.source?.modelKey ||
    !drawingModel?.source?.modelRevision ||
    !drawingModel?.view
  )
    throw new Error('現在のDrawingModelが必要です。');
  const currentRevision = revisionForDrawing(normalized, document, drawingModel);
  const currentView = planViewSnapshot(drawingModel.view);
  const memberReviews = [];
  const drawingMemos = [];
  const tagPlacements = [];
  const reviewStatuses = [];
  const annotationStatuses = [];
  const tagStatuses = [];

  for (const review of document.memberReviews) {
    let invalidationCode = null;
    if (!currentRevision || review.context.sourceRevisionId !== currentRevision.id)
      invalidationCode = 'STB_CHANGED';
    else if (
      !contextViewMatches({
        project: normalized,
        document,
        context: review.context,
        drawingModel,
        currentView,
      })
    )
      invalidationCode = 'STB_VIEW_CHANGED';

    let mapped = null;
    let record = null;
    if (!invalidationCode) {
      mapped = bindingRevision(
        normalized,
        document,
        review.binding.entityId,
        review.context.sourceRevisionId,
      );
      if (!mapped) invalidationCode = 'BINDING_MISSING';
    }
    if (!invalidationCode) {
      const sourceRef = mapped.revision.sourceRef;
      record = findDrawingRecord(drawingModel, [
        drawingModel.source.modelKey,
        sourceRef.elementType,
        sourceRef.elementId,
      ]);
      if (!record) invalidationCode = 'MEMBER_MISSING';
      else if (!sourceRefMatches(sourceRef, record.ref)) invalidationCode = 'SOURCE_REF_MISMATCH';
      else invalidationCode = drawingRecordInvalidationCode(record);
    }

    const active = invalidationCode == null;
    reviewStatuses.push({ id: review.id, active, invalidationCode });
    if (active) {
      memberReviews.push({
        identity: [
          String(drawingModel.source.modelKey),
          String(record.ref.elementType),
          String(record.ref.elementId),
        ],
        reviewState: review.reviewState,
        memo: review.memo,
        invalidationCode: null,
      });
    }
  }

  for (const annotation of document.annotations) {
    let invalidationCode = null;
    if (!currentRevision || annotation.context.sourceRevisionId !== currentRevision.id)
      invalidationCode = 'STB_CHANGED';
    else if (
      !contextViewMatches({
        project: normalized,
        document,
        context: annotation.context,
        drawingModel,
        currentView,
      })
    )
      invalidationCode = 'STB_VIEW_CHANGED';
    const active = invalidationCode == null;
    annotationStatuses.push({ id: annotation.id, active, invalidationCode });
    if (active) {
      drawingMemos.push({
        id: annotation.id,
        drawing: {
          source: {
            modelKey: String(drawingModel.source.modelKey),
            modelRevision: String(drawingModel.source.modelRevision),
          },
          view: JSON.parse(JSON.stringify(planViewContextSnapshot(drawingModel.view))),
        },
        modelPoint: [...annotation.anchor.xy],
        text: annotation.text,
        active: true,
        invalidationCode: null,
      });
    }
  }

  for (const intent of document.tagIntents) {
    let invalidationCode = null;
    if (!currentRevision || document.sourceRevisionId !== currentRevision.id)
      invalidationCode = 'STB_CHANGED';
    else if (!sameView(planViewSnapshot(document.view), currentView))
      invalidationCode = 'STB_VIEW_CHANGED';
    else if (intent.placement.mode !== 'model-fixed')
      invalidationCode = 'UNSUPPORTED_TAG_PLACEMENT_MODE';

    let mapped = null;
    let record = null;
    if (!invalidationCode) {
      mapped = bindingRevision(
        normalized,
        document,
        intent.binding.entityId,
        document.sourceRevisionId,
      );
      if (!mapped) invalidationCode = 'BINDING_MISSING';
    }
    if (!invalidationCode) {
      const sourceRef = mapped.revision.sourceRef;
      record = findDrawingRecord(drawingModel, [
        drawingModel.source.modelKey,
        sourceRef.elementType,
        sourceRef.elementId,
      ]);
      if (!record) invalidationCode = 'MEMBER_MISSING';
      else if (!sourceRefMatches(sourceRef, record.ref)) invalidationCode = 'SOURCE_REF_MISMATCH';
      else invalidationCode = drawingRecordInvalidationCode(record);
    }

    const active = invalidationCode == null;
    tagStatuses.push({ id: intent.id, active, invalidationCode });
    if (active) {
      tagPlacements.push({
        schemaVersion: 2,
        identity: [
          String(drawingModel.source.modelKey),
          String(record.ref.elementType),
          String(record.ref.elementId),
        ],
        drawing: {
          source: {
            modelKey: String(drawingModel.source.modelKey),
            modelRevision: String(drawingModel.source.modelRevision),
          },
          view: JSON.parse(JSON.stringify(planViewContextSnapshot(drawingModel.view))),
        },
        template: { ...intent.template },
        anchorModel: [...intent.placement.origin.xy],
        offsetModel: [0, 0],
        rotationDeg: intent.placement.orientation.rotationDeg,
        leader: intent.placement.leader,
        invalidationCode: null,
      });
    }
  }

  return {
    memberReviews,
    drawingMemos,
    tagPlacements,
    tagFamilyState: normalized.definitions.tagFamilyState,
    display: document.display,
    sheet: document.sheet,
    reviewStatuses,
    annotationStatuses,
    tagStatuses,
  };
}

/**
 * 旧DrawingRenderPlanのresolveTagPlacement契約へmodel-fixed intentを投影する。
 * follow-member/paper-fixedは将来のproject-native compileで扱い、ここでは黙って近似しない。
 */
export function createLegacyTagPlacementResolverFromDrawingProject({ project, drawingId } = {}) {
  const normalized = normalizeDrawingProject(project);
  const document = drawingDocumentById(normalized, requiredString(drawingId, 'drawingId'));
  const bindingBySource = new Map();

  for (const binding of normalized.bindings) {
    if (binding.modelSlotId !== document.modelSlotId) continue;
    const revision = binding.revisions.find(
      (item) => item.sourceRevisionId === document.sourceRevisionId,
    );
    if (!revision?.sourceRef) continue;
    const key = JSON.stringify([revision.sourceRef.elementType, revision.sourceRef.elementId]);
    if (bindingBySource.has(key))
      throw new Error('同一STB sourceRefへ複数entityIdが対応しています: ' + key);
    bindingBySource.set(key, { binding, sourceRef: revision.sourceRef });
  }

  const intentKeys = new Set();
  for (const intent of document.tagIntents) {
    const key = JSON.stringify([
      intent.binding.entityId,
      intent.template.id,
      intent.template.version,
    ]);
    if (intentKeys.has(key))
      throw new Error('同一部材/templateの複数tag intentはまだcompileできません: ' + key);
    intentKeys.add(key);
  }

  return (context) => {
    const key = JSON.stringify([
      String(context?.ref?.elementType),
      String(context?.ref?.elementId),
    ]);
    const mapped = bindingBySource.get(key);
    if (!mapped) return null;
    if (!sourceRefMatches(mapped.sourceRef, context.ref))
      throw new Error('DrawingProject bindingのsourceRefがDrawingModelと一致しません: ' + key);
    const templateId = String(context?.template?.id || '');
    const templateVersion = Number(context?.template?.version);
    const intent = document.tagIntents.find(
      (item) =>
        item.binding.entityId === mapped.binding.entityId &&
        item.template.id === templateId &&
        item.template.version === templateVersion,
    );
    if (!intent) return null;
    if (intent.placement.mode !== 'model-fixed') {
      throw new Error(
        'legacy resolveTagPlacementへ投影できないDrawingProject配置です: ' + intent.placement.mode,
      );
    }
    return {
      anchorModel: [...intent.placement.origin.xy],
      offsetModel: [0, 0],
      rotationDeg: intent.placement.orientation.rotationDeg,
      leader: intent.placement.leader,
    };
  };
}
