import { BUILTIN_TAG_FAMILIES } from './tags/tagFamilyRegistry.js';
import { createEmptyTagFamilyState, normalizeTagFamilyState } from './tags/tagFamilyStore.js';
import { resolveDimensionFamily } from './dimensions/dimensionFamilyRegistry.js';

/**
 * @fileoverview #423/#424 DrawingProjectの最小永続契約。
 * DrawingRenderPlan / SVG / DXF / viewport stateは派生物として保存対象外にする。
 */

export const DRAWING_PROJECT_KIND = 'stb-diff-viewer.drawing-project';
export const DRAWING_PROJECT_SCHEMA_VERSION = 1;
export const DRAWING_PROJECT_UNITS = Object.freeze({ model: 'mm', paper: 'mm' });

const FORBIDDEN_DERIVED_KEYS = new Set([
  'drawingRenderPlan',
  'renderPlan',
  'svg',
  'dxf',
  'preview',
  'cache',
]);
const FORBIDDEN_SCREEN_KEYS = new Set([
  'zoom',
  'pan',
  'devicePixelRatio',
  'dpr',
  'cssScale',
  'viewport',
]);

export class DrawingProjectSchemaError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'DrawingProjectSchemaError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new DrawingProjectSchemaError(code, path, message);
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_TYPE', path, path + ' must be an object.');
  return value;
}

function keys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_DERIVED_KEYS.has(key))
      fail(
        'DERIVED_ARTIFACT_FORBIDDEN',
        path + '.' + key,
        '派生出力はDrawingProjectへ保存できません。',
      );
    if (FORBIDDEN_SCREEN_KEYS.has(key))
      fail(
        'SCREEN_STATE_FORBIDDEN',
        path + '.' + key,
        '画面専用状態はDrawingProjectへ保存できません。',
      );
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', path + '.' + key, 'Unknown field: ' + key);
  }
}

function id(value, path) {
  if (value == null || !String(value).trim())
    fail('INVALID_STRING', path, path + ' must be a non-empty string.');
  return String(value).trim();
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail('INVALID_INTEGER', path, path + ' must be a positive safe integer.');
  return value;
}

function finite(value, path) {
  if (!Number.isFinite(value)) fail('INVALID_NUMBER', path, path + ' must be finite.');
  return value;
}

function pair(value, path) {
  if (!Array.isArray(value) || value.length !== 2)
    fail('INVALID_POINT', path, path + ' must contain two coordinates.');
  return value.map((item, index) => finite(item, path + '[' + index + ']'));
}

function unique(items, keyOf, path, code) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const key = keyOf(item);
    if (seen.has(key)) fail(code, path + '[' + index + ']', 'Duplicate key: ' + key);
    seen.add(key);
  }
}

function sourceRevision(value, path) {
  record(value, path);
  keys(value, new Set(['id', 'sha256']), path);
  const sha256 = id(value.sha256, path + '.sha256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256))
    fail('INVALID_SHA256', path + '.sha256', 'SHA-256 must be 64 hexadecimal digits.');
  return { id: id(value.id, path + '.id'), sha256 };
}

function modelSlot(value, index) {
  const path = 'modelSlots[' + index + ']';
  record(value, path);
  keys(value, new Set(['id', 'currentRevisionId', 'revisions']), path);
  if (!Array.isArray(value.revisions) || value.revisions.length === 0)
    fail('INVALID_REVISIONS', path + '.revisions', 'At least one source revision is required.');
  const revisions = value.revisions.map((item, i) =>
    sourceRevision(item, path + '.revisions[' + i + ']'),
  );
  unique(revisions, (item) => item.id, path + '.revisions', 'DUPLICATE_SOURCE_REVISION');
  const currentRevisionId = id(value.currentRevisionId, path + '.currentRevisionId');
  if (!revisions.some((item) => item.id === currentRevisionId))
    fail(
      'UNKNOWN_CURRENT_REVISION',
      path + '.currentRevisionId',
      'currentRevisionId is not defined in this model slot.',
    );
  return { id: id(value.id, path + '.id'), currentRevisionId, revisions };
}

function sourceRef(value, path) {
  record(value, path);
  keys(value, new Set(['elementType', 'elementId', 'guid']), path);
  return {
    elementType: id(value.elementType, path + '.elementType'),
    elementId: id(value.elementId, path + '.elementId'),
    guid: value.guid == null ? null : id(value.guid, path + '.guid'),
  };
}

function binding(value, index) {
  const path = 'bindings[' + index + ']';
  record(value, path);
  keys(value, new Set(['entityId', 'modelSlotId', 'revisions']), path);
  if (!Array.isArray(value.revisions) || value.revisions.length === 0)
    fail(
      'INVALID_BINDING_REVISIONS',
      path + '.revisions',
      'At least one revision mapping is required.',
    );
  const revisions = value.revisions.map((item, i) => {
    const itemPath = path + '.revisions[' + i + ']';
    record(item, itemPath);
    keys(item, new Set(['sourceRevisionId', 'sourceRef']), itemPath);
    return {
      sourceRevisionId: id(item.sourceRevisionId, itemPath + '.sourceRevisionId'),
      sourceRef: sourceRef(item.sourceRef, itemPath + '.sourceRef'),
    };
  });
  unique(
    revisions,
    (item) => item.sourceRevisionId,
    path + '.revisions',
    'DUPLICATE_BINDING_REVISION',
  );
  return {
    entityId: id(value.entityId, path + '.entityId'),
    modelSlotId: id(value.modelSlotId, path + '.modelSlotId'),
    revisions,
  };
}

function planView(value, path) {
  record(value, path);
  keys(value, new Set(['type', 'storyId', 'storyBinding']), path);
  if (value.type !== 'plan')
    fail('INVALID_VIEW', path + '.type', 'DrawingProject v1 supports plan view only.');
  let storyBinding = null;
  if (value.storyBinding != null) {
    record(value.storyBinding, path + '.storyBinding');
    keys(value.storyBinding, new Set(['entityId']), path + '.storyBinding');
    storyBinding = {
      entityId: id(value.storyBinding.entityId, path + '.storyBinding.entityId'),
    };
  }
  return {
    type: 'plan',
    storyId: id(value.storyId, path + '.storyId'),
    ...(storyBinding ? { storyBinding } : {}),
  };
}

function sheet(value, path) {
  record(value, path);
  keys(
    value,
    new Set(['paper', 'orientation', 'scaleDenominator', 'rotationDeg', 'tagOrientationMode']),
    path,
  );
  const paper = value.paper == null ? 'A3' : id(value.paper, path + '.paper');
  if (paper !== 'A3') fail('INVALID_PAPER', path + '.paper', 'DrawingProject v1 supports A3 only.');
  const orientation =
    value.orientation == null ? 'landscape' : id(value.orientation, path + '.orientation');
  if (!['landscape', 'portrait'].includes(orientation))
    fail('INVALID_PAPER_ORIENTATION', path + '.orientation', 'Unsupported paper orientation.');
  const scaleDenominator = finite(value.scaleDenominator, path + '.scaleDenominator');
  if (scaleDenominator < 1)
    fail('INVALID_SCALE', path + '.scaleDenominator', 'Scale denominator must be at least 1.');
  const raw = finite(value.rotationDeg == null ? 0 : value.rotationDeg, path + '.rotationDeg');
  const rotationDeg = ((raw % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotationDeg))
    fail('INVALID_ROTATION', path + '.rotationDeg', 'Rotation must be 0/90/180/270 degrees.');
  const tagOrientationMode =
    value.tagOrientationMode == null
      ? 'follow-member'
      : id(value.tagOrientationMode, path + '.tagOrientationMode');
  if (!['follow-drawing', 'follow-member', 'keep-screen-down'].includes(tagOrientationMode))
    fail(
      'INVALID_TAG_ORIENTATION_MODE',
      path + '.tagOrientationMode',
      'Unsupported drawing tag orientation mode.',
    );
  return { paper, orientation, scaleDenominator, rotationDeg, tagOrientationMode };
}

function tagIntent(value, index, prefix) {
  const path = prefix + '[' + index + ']';
  record(value, path);
  keys(value, new Set(['id', 'binding', 'template', 'placement']), path);

  record(value.binding, path + '.binding');
  keys(value.binding, new Set(['entityId', 'anchor']), path + '.binding');
  let anchor = null;
  if (value.binding.anchor != null) {
    record(value.binding.anchor, path + '.binding.anchor');
    keys(value.binding.anchor, new Set(['kind', 'stationRatio']), path + '.binding.anchor');
    const anchorKind = id(value.binding.anchor.kind, path + '.binding.anchor.kind');
    if (!['member-bounds-center', 'member-axis'].includes(anchorKind))
      fail('INVALID_TAG_ANCHOR', path + '.binding.anchor.kind', 'Unsupported semantic tag anchor.');
    if (anchorKind === 'member-axis') {
      const stationRatio = finite(
        value.binding.anchor.stationRatio == null ? 0.5 : value.binding.anchor.stationRatio,
        path + '.binding.anchor.stationRatio',
      );
      if (stationRatio < 0 || stationRatio > 1)
        fail(
          'INVALID_TAG_ANCHOR',
          path + '.binding.anchor.stationRatio',
          'stationRatio must be between 0 and 1.',
        );
      anchor = { kind: anchorKind, stationRatio };
    } else {
      if (value.binding.anchor.stationRatio !== undefined)
        fail(
          'INVALID_TAG_ANCHOR',
          path + '.binding.anchor.stationRatio',
          'stationRatio is valid only for member-axis.',
        );
      anchor = { kind: anchorKind };
    }
  }

  record(value.template, path + '.template');
  keys(value.template, new Set(['id', 'version']), path + '.template');

  record(value.placement, path + '.placement');
  keys(
    value.placement,
    new Set(['mode', 'offset', 'origin', 'orientation', 'leader']),
    path + '.placement',
  );
  const mode = id(value.placement.mode, path + '.placement.mode');
  if (!['follow-member', 'model-fixed', 'paper-fixed'].includes(mode))
    fail('INVALID_TAG_PLACEMENT_MODE', path + '.placement.mode', 'Unsupported tag placement mode.');
  if (typeof value.placement.leader !== 'boolean')
    fail('INVALID_TAG_LEADER', path + '.placement.leader', 'leader must be boolean.');

  record(value.placement.orientation, path + '.placement.orientation');
  keys(
    value.placement.orientation,
    new Set(['mode', 'rotationDeg']),
    path + '.placement.orientation',
  );
  const orientationMode = id(
    value.placement.orientation.mode,
    path + '.placement.orientation.mode',
  );
  if (orientationMode !== 'follow-view')
    fail(
      'INVALID_TAG_ORIENTATION',
      path + '.placement.orientation.mode',
      'v1 tag orientation must be follow-view.',
    );
  const rotationDeg =
    ((finite(
      value.placement.orientation.rotationDeg == null ? 0 : value.placement.orientation.rotationDeg,
      path + '.placement.orientation.rotationDeg',
    ) %
      360) +
      360) %
    360;
  if (![0, 90, 180, 270].includes(rotationDeg))
    fail(
      'INVALID_TAG_ROTATION',
      path + '.placement.orientation.rotationDeg',
      'Tag rotation must be 0/90/180/270 degrees.',
    );

  let offset = null;
  let origin = null;
  if (mode === 'follow-member') {
    if (!anchor)
      fail(
        'TAG_ANCHOR_REQUIRED',
        path + '.binding.anchor',
        'follow-member placement requires a semantic anchor.',
      );
    if (value.placement.origin !== undefined)
      fail(
        'INVALID_TAG_PLACEMENT',
        path + '.placement.origin',
        'follow-member placement cannot persist an absolute origin.',
      );
    record(value.placement.offset, path + '.placement.offset');
    keys(value.placement.offset, new Set(['frame', 'unit', 'xy']), path + '.placement.offset');
    if (value.placement.offset.frame !== 'paper' || value.placement.offset.unit !== 'mm')
      fail(
        'INVALID_TAG_OFFSET_FRAME',
        path + '.placement.offset',
        'follow-member offset must use paper mm.',
      );
    offset = {
      frame: 'paper',
      unit: 'mm',
      xy: pair(value.placement.offset.xy, path + '.placement.offset.xy'),
    };
  } else {
    if (anchor)
      fail(
        'TAG_ANCHOR_FORBIDDEN',
        path + '.binding.anchor',
        'fixed placement keeps member binding but does not use a semantic anchor.',
      );
    if (value.placement.offset !== undefined)
      fail(
        'INVALID_TAG_PLACEMENT',
        path + '.placement.offset',
        'fixed placement cannot persist a follow-member offset.',
      );
    record(value.placement.origin, path + '.placement.origin');
    keys(value.placement.origin, new Set(['frame', 'unit', 'xy']), path + '.placement.origin');
    const expectedFrame = mode === 'model-fixed' ? 'model' : 'paper';
    if (value.placement.origin.frame !== expectedFrame || value.placement.origin.unit !== 'mm')
      fail(
        'INVALID_TAG_ORIGIN_FRAME',
        path + '.placement.origin',
        mode + ' origin must use ' + expectedFrame + ' mm.',
      );
    origin = {
      frame: expectedFrame,
      unit: 'mm',
      xy: pair(value.placement.origin.xy, path + '.placement.origin.xy'),
    };
  }

  return {
    id: id(value.id, path + '.id'),
    binding: { entityId: id(value.binding.entityId, path + '.binding.entityId'), anchor },
    template: {
      id: id(value.template.id, path + '.template.id'),
      version: positiveInteger(value.template.version, path + '.template.version'),
    },
    placement: {
      mode,
      ...(offset ? { offset } : {}),
      ...(origin ? { origin } : {}),
      orientation: { mode: 'follow-view', rotationDeg },
      leader: value.placement.leader,
    },
  };
}

export function createModelFixedTagIntentFromLegacyPlacement({
  id: intentId,
  entityId,
  template,
  anchorModel,
  offsetModel = [0, 0],
  rotationDeg = 0,
  leader = true,
} = {}) {
  const anchor = pair(anchorModel, 'legacyPlacement.anchorModel');
  const offset = pair(offsetModel, 'legacyPlacement.offsetModel');
  return tagIntent(
    {
      id: intentId,
      binding: { entityId, anchor: null },
      template,
      placement: {
        mode: 'model-fixed',
        origin: {
          frame: 'model',
          unit: 'mm',
          xy: [anchor[0] + offset[0], anchor[1] + offset[1]],
        },
        orientation: { mode: 'follow-view', rotationDeg },
        leader,
      },
    },
    0,
    'legacyTagIntent',
  );
}

function stringMap(value, path, normalizeValue) {
  const input = value == null ? {} : record(value, path);
  const result = {};
  for (const [key, item] of Object.entries(input)) {
    const normalizedKey = id(key, path + '.<key>');
    result[normalizedKey] = normalizeValue(item, path + '.' + normalizedKey);
  }
  return result;
}

function drawingDisplay(value, path) {
  const input = value == null ? {} : record(value, path);
  keys(
    input,
    new Set(['visibility', 'tagModes', 'colors', 'cutSurfaceFill', 'cutSurfaceFillOpacity']),
    path,
  );
  const visibility = stringMap(input.visibility, path + '.visibility', (item, itemPath) => {
    if (typeof item !== 'boolean')
      fail('INVALID_VISIBILITY', itemPath, 'visibility must be boolean.');
    return item;
  });
  const tagModes = stringMap(input.tagModes, path + '.tagModes', (item, itemPath) =>
    id(item, itemPath),
  );
  const colors = stringMap(input.colors, path + '.colors', (item, itemPath) => {
    const color = id(item, itemPath);
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      fail('INVALID_COLOR', itemPath, 'Drawing color must be #RRGGBB.');
    return color.toLowerCase();
  });
  const cutSurfaceFill = input.cutSurfaceFill == null ? true : input.cutSurfaceFill;
  if (typeof cutSurfaceFill !== 'boolean')
    fail('INVALID_CUT_FILL', path + '.cutSurfaceFill', 'cutSurfaceFill must be boolean.');
  const cutSurfaceFillOpacity =
    input.cutSurfaceFillOpacity == null
      ? 0.18
      : finite(input.cutSurfaceFillOpacity, path + '.cutSurfaceFillOpacity');
  if (cutSurfaceFillOpacity < 0 || cutSurfaceFillOpacity > 1)
    fail(
      'INVALID_CUT_FILL_OPACITY',
      path + '.cutSurfaceFillOpacity',
      'cutSurfaceFillOpacity must be between 0 and 1.',
    );
  return { visibility, tagModes, colors, cutSurfaceFill, cutSurfaceFillOpacity };
}

function reviewContext(value, path) {
  record(value, path);
  keys(value, new Set(['sourceRevisionId', 'view']), path);
  return {
    sourceRevisionId: id(value.sourceRevisionId, path + '.sourceRevisionId'),
    view: planView(value.view, path + '.view'),
  };
}

function memberReview(value, index, prefix) {
  const path = prefix + '[' + index + ']';
  record(value, path);
  keys(value, new Set(['id', 'binding', 'context', 'reviewState', 'memo']), path);
  record(value.binding, path + '.binding');
  keys(value.binding, new Set(['entityId']), path + '.binding');
  const reviewState = id(value.reviewState, path + '.reviewState');
  if (!['unreviewed', 'confirmed', 'mismatch'].includes(reviewState))
    fail('INVALID_REVIEW_STATE', path + '.reviewState', 'Unsupported member review state.');
  if (typeof value.memo !== 'string')
    fail('INVALID_REVIEW_MEMO', path + '.memo', 'Member review memo must be a string.');
  return {
    id: id(value.id, path + '.id'),
    binding: { entityId: id(value.binding.entityId, path + '.binding.entityId') },
    context: reviewContext(value.context, path + '.context'),
    reviewState,
    memo: value.memo,
  };
}

function memberReviewContextKey(review) {
  return JSON.stringify([
    review.binding.entityId,
    review.context.sourceRevisionId,
    review.context.view.type,
    review.context.view.storyId,
  ]);
}

function drawingAnnotation(value, index, prefix) {
  const path = prefix + '[' + index + ']';
  record(value, path);
  keys(value, new Set(['id', 'type', 'context', 'anchor', 'text']), path);
  if (value.type !== 'text')
    fail(
      'INVALID_DRAWING_ANNOTATION_TYPE',
      path + '.type',
      'DrawingProject v1 supports text annotations only.',
    );
  record(value.anchor, path + '.anchor');
  keys(value.anchor, new Set(['frame', 'unit', 'xy']), path + '.anchor');
  if (value.anchor.frame !== 'model' || value.anchor.unit !== 'mm')
    fail(
      'INVALID_DRAWING_ANNOTATION_ANCHOR',
      path + '.anchor',
      'Text annotation anchor must use model mm.',
    );
  if (typeof value.text !== 'string')
    fail(
      'INVALID_DRAWING_ANNOTATION_TEXT',
      path + '.text',
      'Drawing annotation text must be a string.',
    );
  return {
    id: id(value.id, path + '.id'),
    type: 'text',
    context: reviewContext(value.context, path + '.context'),
    anchor: { frame: 'model', unit: 'mm', xy: pair(value.anchor.xy, path + '.anchor.xy') },
    text: value.text,
  };
}

function persistentDimensionReference(value, index, prefix) {
  const path = prefix + '[' + index + ']';
  record(value, path);
  keys(value, new Set(['kind', 'binding']), path);
  if (value.kind !== 'axis-binding')
    fail(
      'INVALID_DIMENSION_REFERENCE_KIND',
      path + '.kind',
      'DrawingProject v1 supports axis-binding dimension references only.',
    );
  record(value.binding, path + '.binding');
  keys(value.binding, new Set(['entityId']), path + '.binding');
  return {
    kind: 'axis-binding',
    binding: { entityId: id(value.binding.entityId, path + '.binding.entityId') },
  };
}

function persistentDimensionIntent(value, index, prefix) {
  const path = prefix + '[' + index + ']';
  record(value, path);
  keys(value, new Set(['id', 'kind', 'references', 'placement', 'familyId']), path);
  if (value.kind !== 'linear-chain')
    fail(
      'INVALID_DIMENSION_INTENT_KIND',
      path + '.kind',
      'DrawingProject v1 supports linear-chain dimensions only.',
    );
  if (!Array.isArray(value.references) || value.references.length < 2)
    fail(
      'INVALID_DIMENSION_REFERENCES',
      path + '.references',
      'Persistent dimension requires at least two references.',
    );
  record(value.placement, path + '.placement');
  keys(value.placement, new Set(['offsetModelMm']), path + '.placement');
  const familyId = id(value.familyId, path + '.familyId');
  try {
    resolveDimensionFamily(familyId);
  } catch (error) {
    fail('UNKNOWN_DIMENSION_FAMILY', path + '.familyId', error.message);
  }
  return {
    id: id(value.id, path + '.id'),
    kind: 'linear-chain',
    references: value.references.map((item, i) =>
      persistentDimensionReference(item, i, path + '.references'),
    ),
    placement: {
      offsetModelMm: finite(value.placement.offsetModelMm, path + '.placement.offsetModelMm'),
    },
    familyId,
  };
}

function drawingDocument(value, index) {
  const path = 'drawingDocuments[' + index + ']';
  record(value, path);
  keys(
    value,
    new Set([
      'id',
      'modelSlotId',
      'sourceRevisionId',
      'view',
      'sheet',
      'display',
      'tagIntents',
      'dimensionIntents',
      'memberReviews',
      'annotations',
    ]),
    path,
  );
  if (!Array.isArray(value.tagIntents))
    fail('INVALID_TAG_INTENTS', path + '.tagIntents', 'tagIntents must be an array.');
  if (value.dimensionIntents != null && !Array.isArray(value.dimensionIntents))
    fail(
      'INVALID_DIMENSION_INTENTS',
      path + '.dimensionIntents',
      'dimensionIntents must be an array.',
    );
  if (value.memberReviews != null && !Array.isArray(value.memberReviews))
    fail('INVALID_MEMBER_REVIEWS', path + '.memberReviews', 'memberReviews must be an array.');
  if (value.annotations != null && !Array.isArray(value.annotations))
    fail('INVALID_DRAWING_ANNOTATIONS', path + '.annotations', 'annotations must be an array.');
  const tagIntents = value.tagIntents.map((item, i) => tagIntent(item, i, path + '.tagIntents'));
  const dimensionIntents = (value.dimensionIntents ?? []).map((item, i) =>
    persistentDimensionIntent(item, i, path + '.dimensionIntents'),
  );
  const memberReviews = (value.memberReviews ?? []).map((item, i) =>
    memberReview(item, i, path + '.memberReviews'),
  );
  const annotations = (value.annotations ?? []).map((item, i) =>
    drawingAnnotation(item, i, path + '.annotations'),
  );
  unique(tagIntents, (item) => item.id, path + '.tagIntents', 'DUPLICATE_TAG_INTENT');
  unique(
    dimensionIntents,
    (item) => item.id,
    path + '.dimensionIntents',
    'DUPLICATE_DIMENSION_INTENT',
  );
  unique(memberReviews, (item) => item.id, path + '.memberReviews', 'DUPLICATE_MEMBER_REVIEW');
  unique(
    memberReviews,
    memberReviewContextKey,
    path + '.memberReviews',
    'DUPLICATE_MEMBER_REVIEW_CONTEXT',
  );
  unique(annotations, (item) => item.id, path + '.annotations', 'DUPLICATE_DRAWING_ANNOTATION');
  return {
    id: id(value.id, path + '.id'),
    modelSlotId: id(value.modelSlotId, path + '.modelSlotId'),
    sourceRevisionId: id(value.sourceRevisionId, path + '.sourceRevisionId'),
    view: planView(value.view, path + '.view'),
    sheet: sheet(value.sheet, path + '.sheet'),
    display: drawingDisplay(value.display, path + '.display'),
    tagIntents,
    dimensionIntents,
    memberReviews,
    annotations,
  };
}

function validateReferences(project) {
  const slots = new Map(project.modelSlots.map((item) => [item.id, item]));
  const bindings = new Map(project.bindings.map((item) => [item.entityId, item]));

  for (const [i, item] of project.bindings.entries()) {
    const slot = slots.get(item.modelSlotId);
    if (!slot)
      fail(
        'UNKNOWN_MODEL_SLOT',
        'bindings[' + i + '].modelSlotId',
        'Binding modelSlotId is not defined.',
      );
    const revisionIds = new Set(slot.revisions.map((revision) => revision.id));
    for (const [j, revision] of item.revisions.entries()) {
      if (!revisionIds.has(revision.sourceRevisionId))
        fail(
          'UNKNOWN_SOURCE_REVISION',
          'bindings[' + i + '].revisions[' + j + '].sourceRevisionId',
          'Binding revision must belong to its model slot.',
        );
    }
  }

  for (const [i, drawing] of project.drawingDocuments.entries()) {
    const slot = slots.get(drawing.modelSlotId);
    if (!slot)
      fail(
        'UNKNOWN_MODEL_SLOT',
        'drawingDocuments[' + i + '].modelSlotId',
        'Drawing modelSlotId is not defined.',
      );
    if (!slot.revisions.some((revision) => revision.id === drawing.sourceRevisionId))
      fail(
        'UNKNOWN_SOURCE_REVISION',
        'drawingDocuments[' + i + '].sourceRevisionId',
        'Drawing revision must belong to its model slot.',
      );
    if (drawing.view.storyBinding) {
      const storyPath = 'drawingDocuments[' + i + '].view.storyBinding.entityId';
      const item = bindings.get(drawing.view.storyBinding.entityId);
      if (!item)
        fail(
          'UNKNOWN_ENTITY_BINDING',
          storyPath,
          'Story entityId is not defined in BindingRegistry.',
        );
      if (item.modelSlotId !== drawing.modelSlotId)
        fail(
          'BINDING_MODEL_SLOT_MISMATCH',
          storyPath,
          'Story binding must belong to the drawing model slot.',
        );
      const revision = item.revisions.find(
        (candidate) => candidate.sourceRevisionId === drawing.sourceRevisionId,
      );
      if (!revision)
        fail(
          'UNBOUND_DRAWING_REVISION',
          storyPath,
          'Story binding is not mapped for the drawing source revision.',
        );
      if (revision.sourceRef.elementType !== 'Story')
        fail(
          'INVALID_STORY_REFERENCE_BINDING',
          storyPath,
          'Plan view story binding must reference Story.',
        );
      if (String(revision.sourceRef.elementId) !== String(drawing.view.storyId))
        fail(
          'STORY_BINDING_ID_MISMATCH',
          storyPath,
          'Plan view storyId must match the current revision Story sourceRef.',
        );
    }
    for (const [j, tag] of drawing.tagIntents.entries()) {
      const item = bindings.get(tag.binding.entityId);
      const tagPath = 'drawingDocuments[' + i + '].tagIntents[' + j + '].binding.entityId';
      if (!item)
        fail('UNKNOWN_ENTITY_BINDING', tagPath, 'Tag entityId is not defined in BindingRegistry.');
      if (item.modelSlotId !== drawing.modelSlotId)
        fail(
          'BINDING_MODEL_SLOT_MISMATCH',
          tagPath,
          'Tag binding must belong to the drawing model slot.',
        );
      if (
        !item.revisions.some((revision) => revision.sourceRevisionId === drawing.sourceRevisionId)
      )
        fail(
          'UNBOUND_DRAWING_REVISION',
          tagPath,
          'Tag binding is not mapped for the drawing source revision.',
        );
    }
    for (const [j, dimension] of drawing.dimensionIntents.entries()) {
      for (const [k, reference] of dimension.references.entries()) {
        const dimensionPath =
          'drawingDocuments[' +
          i +
          '].dimensionIntents[' +
          j +
          '].references[' +
          k +
          '].binding.entityId';
        const item = bindings.get(reference.binding.entityId);
        if (!item)
          fail(
            'UNKNOWN_ENTITY_BINDING',
            dimensionPath,
            'Dimension entityId is not defined in BindingRegistry.',
          );
        if (item.modelSlotId !== drawing.modelSlotId)
          fail(
            'BINDING_MODEL_SLOT_MISMATCH',
            dimensionPath,
            'Dimension binding must belong to the drawing model slot.',
          );
        const revision = item.revisions.find(
          (candidate) => candidate.sourceRevisionId === drawing.sourceRevisionId,
        );
        if (!revision)
          fail(
            'UNBOUND_DRAWING_REVISION',
            dimensionPath,
            'Dimension binding is not mapped for the drawing source revision.',
          );
        if (revision.sourceRef.elementType !== 'ParallelAxis')
          fail(
            'INVALID_DIMENSION_REFERENCE_BINDING',
            dimensionPath,
            'DrawingProject v1 dimension references must bind to ParallelAxis.',
          );
      }
    }
    const slotRevisionIds = new Set(slot.revisions.map((revision) => revision.id));
    for (const [j, review] of drawing.memberReviews.entries()) {
      const reviewPath = 'drawingDocuments[' + i + '].memberReviews[' + j + ']';
      if (!slotRevisionIds.has(review.context.sourceRevisionId))
        fail(
          'UNKNOWN_REVIEW_SOURCE_REVISION',
          reviewPath + '.context.sourceRevisionId',
          'Review source revision must belong to the drawing model slot.',
        );
      const item = bindings.get(review.binding.entityId);
      if (!item)
        fail(
          'UNKNOWN_ENTITY_BINDING',
          reviewPath + '.binding.entityId',
          'Review entityId is not defined in BindingRegistry.',
        );
      if (item.modelSlotId !== drawing.modelSlotId)
        fail(
          'BINDING_MODEL_SLOT_MISMATCH',
          reviewPath + '.binding.entityId',
          'Review binding must belong to the drawing model slot.',
        );
      if (
        !item.revisions.some(
          (revision) => revision.sourceRevisionId === review.context.sourceRevisionId,
        )
      )
        fail(
          'UNBOUND_REVIEW_REVISION',
          reviewPath + '.context.sourceRevisionId',
          'Review binding is not mapped for the review source revision.',
        );
    }
    for (const [j, annotation] of drawing.annotations.entries()) {
      const annotationPath = 'drawingDocuments[' + i + '].annotations[' + j + ']';
      if (!slotRevisionIds.has(annotation.context.sourceRevisionId))
        fail(
          'UNKNOWN_ANNOTATION_SOURCE_REVISION',
          annotationPath + '.context.sourceRevisionId',
          'Annotation source revision must belong to the drawing model slot.',
        );
    }
  }
}

function definitions(value, path = 'definitions') {
  const input = value == null ? {} : record(value, path);
  keys(input, new Set(['tagFamilyState']), path);
  return {
    tagFamilyState: normalizeTagFamilyState(input.tagFamilyState ?? createEmptyTagFamilyState(), {
      builtIns: BUILTIN_TAG_FAMILIES,
    }),
  };
}

export function normalizeDrawingProject(value) {
  record(value, '$');
  keys(
    value,
    new Set([
      'kind',
      'schemaVersion',
      'units',
      'projectId',
      'modelSlots',
      'bindings',
      'drawingDocuments',
      'definitions',
    ]),
    '$',
  );
  if (value.kind !== DRAWING_PROJECT_KIND)
    fail('INVALID_DOCUMENT_KIND', '$.kind', 'Unexpected DrawingProject document kind.');
  if (value.schemaVersion !== DRAWING_PROJECT_SCHEMA_VERSION)
    fail(
      'UNSUPPORTED_SCHEMA_VERSION',
      '$.schemaVersion',
      'Unsupported DrawingProject schema version.',
    );
  record(value.units, '$.units');
  keys(value.units, new Set(['model', 'paper']), '$.units');
  if (value.units.model !== 'mm' || value.units.paper !== 'mm')
    fail('INVALID_UNITS', '$.units', 'DrawingProject v1 requires model mm and paper mm.');
  if (!Array.isArray(value.modelSlots) || value.modelSlots.length === 0)
    fail('INVALID_MODEL_SLOTS', '$.modelSlots', 'At least one model slot is required.');
  if (!Array.isArray(value.bindings))
    fail('INVALID_BINDINGS', '$.bindings', 'bindings must be an array.');
  if (!Array.isArray(value.drawingDocuments) || value.drawingDocuments.length === 0)
    fail(
      'INVALID_DRAWING_DOCUMENTS',
      '$.drawingDocuments',
      'At least one drawing document is required.',
    );

  const project = {
    kind: DRAWING_PROJECT_KIND,
    schemaVersion: DRAWING_PROJECT_SCHEMA_VERSION,
    units: { ...DRAWING_PROJECT_UNITS },
    projectId: id(value.projectId, '$.projectId'),
    modelSlots: value.modelSlots.map(modelSlot),
    bindings: value.bindings.map(binding),
    drawingDocuments: value.drawingDocuments.map(drawingDocument),
    definitions: definitions(value.definitions),
  };
  unique(project.modelSlots, (item) => item.id, 'modelSlots', 'DUPLICATE_MODEL_SLOT');
  unique(project.bindings, (item) => item.entityId, 'bindings', 'DUPLICATE_ENTITY_BINDING');
  unique(
    project.drawingDocuments,
    (item) => item.id,
    'drawingDocuments',
    'DUPLICATE_DRAWING_DOCUMENT',
  );
  validateReferences(project);
  return project;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function serializeDrawingProject(value) {
  return JSON.stringify(canonical(normalizeDrawingProject(value)), null, 2);
}

export function parseDrawingProject(text) {
  if (typeof text !== 'string')
    fail('INVALID_JSON_TEXT', '$', 'DrawingProject JSON text is required.');
  try {
    return normalizeDrawingProject(JSON.parse(text));
  } catch (error) {
    if (error instanceof DrawingProjectSchemaError) throw error;
    fail('INVALID_JSON', '$', 'DrawingProject JSON parse failed: ' + error.message);
  }
}
