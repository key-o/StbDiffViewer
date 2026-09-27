import {
  DEFAULT_REGISTRATION_POLICY,
  REGISTRATION_COORDINATE_FRAMES,
  REGISTRATION_COORDINATE_UNITS,
  REGISTRATION_SCHEMA_VERSION,
} from './registration.js';

export const PDF_OVERLAY_SESSION_SCHEMA_VERSION = 1;
export const PDF_OVERLAY_SESSION_KIND = 'stb-diff-viewer.pdf-overlay-session';
export const PDF_OVERLAY_REVIEW_STATES = Object.freeze(['unreviewed', 'confirmed', 'mismatch']);

const REVIEW_STATE_SET = new Set(PDF_OVERLAY_REVIEW_STATES);
export const REGISTRATION_VALID_CODES = new Set(['CHECK_WITHIN_GUIDE', 'CHECK_EXCEEDS_GUIDE']);
const SESSION_KEYS = new Set([
  'kind',
  'schemaVersion',
  'pdfIdentity',
  'pageRender',
  'pageNumber',
  'selectedRegion',
  'regionMapping',
  'drawing',
  'registration',
  'placement',
  'memberReviews',
  'drawingMemos',
]);
const REQUIRED_SESSION_KEYS = new Set([...SESSION_KEYS].filter((key) => key !== 'placement'));

export class SessionError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.path = path;
  }
}

export function fail(code, path, message) {
  throw new SessionError(code, path, message);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function assertRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_TYPE', path, `${path} must be an object.`);
  return value;
}

function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${key}`, `Unknown field: ${key}`);
  }
}

function assertString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()))
    fail('INVALID_STRING', path, `${path} must be a non-empty string.`);
  return value;
}

function assertFinite(value, path) {
  if (!Number.isFinite(value)) fail('INVALID_NUMBER', path, `${path} must be finite.`);
  return value;
}

export function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail('INVALID_INTEGER', path, `${path} must be a positive safe integer.`);
  return value;
}

export function cloneJson(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return assertFinite(value, path);
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (!isRecord(value)) fail('INVALID_JSON_VALUE', path, `${path} is not JSON data.`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      fail('INVALID_JSON_KEY', `${path}.${key}`, `${path} contains a forbidden property.`);
    result[key] = cloneJson(item, `${path}.${key}`);
  }
  return result;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalJson(value));
}

export function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

export function normalizePdfIdentity(value, path = 'pdfIdentity') {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['sha256', 'byteLength', 'numPages']), path);
  const sha256 = assertString(value.sha256, `${path}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256))
    fail('INVALID_PDF_IDENTITY', `${path}.sha256`, 'PDF SHA-256 must be 64 lowercase hex digits.');
  const byteLength = assertPositiveInteger(value.byteLength, `${path}.byteLength`);
  const numPages = assertPositiveInteger(value.numPages, `${path}.numPages`);
  return { sha256, byteLength, numPages };
}

export function pdfIdentitySnapshot(value, path) {
  if (value == null) return null;
  assertRecord(value, path);
  return normalizePdfIdentity(
    { sha256: value.sha256, byteLength: value.byteLength, numPages: value.numPages },
    path,
  );
}

export function normalizePageRender(value, path = 'pageRender') {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['pageNumber', 'viewBox', 'userUnit', 'intrinsicRotation']), path);
  const pageNumber = assertPositiveInteger(value.pageNumber, `${path}.pageNumber`);
  if (
    !Array.isArray(value.viewBox) ||
    value.viewBox.length !== 4 ||
    !value.viewBox.every(Number.isFinite) ||
    value.viewBox[0] >= value.viewBox[2] ||
    value.viewBox[1] >= value.viewBox[3]
  ) {
    fail('INVALID_PAGE_VIEW', `${path}.viewBox`, 'PDF page viewBox is invalid.');
  }
  if (!Number.isFinite(value.userUnit) || value.userUnit <= 0)
    fail('INVALID_PAGE_VIEW', `${path}.userUnit`, 'PDF page UserUnit must be positive.');
  if (!Number.isInteger(value.intrinsicRotation) || value.intrinsicRotation % 90 !== 0)
    fail(
      'INVALID_PAGE_VIEW',
      `${path}.intrinsicRotation`,
      'PDF page rotation must be a multiple of 90.',
    );
  return {
    pageNumber,
    viewBox: [...value.viewBox],
    userUnit: value.userUnit,
    intrinsicRotation: value.intrinsicRotation,
  };
}

export function pageRenderSnapshot(value, path) {
  if (value == null) return null;
  assertRecord(value, path);
  return normalizePageRender(
    {
      pageNumber: value.pageNumber,
      viewBox: value.viewBox,
      userUnit: value.userUnit,
      intrinsicRotation: value.intrinsicRotation,
    },
    path,
  );
}

export function normalizeRegion(value, path, { allowNull = true } = {}) {
  if (value == null && allowNull) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['xMin', 'yMin', 'xMax', 'yMax', 'units']), path);
  const { xMin, yMin, xMax, yMax } = value;
  [xMin, yMin, xMax, yMax].forEach((item, index) =>
    assertFinite(item, `${path}.${['xMin', 'yMin', 'xMax', 'yMax'][index]}`),
  );
  if (xMin >= xMax || yMin >= yMax)
    fail('INVALID_REGION', path, 'PDF region must have positive area.');
  if (value.units !== undefined && value.units !== 'pdf-user-space')
    fail('INVALID_REGION', `${path}.units`, 'PDF region units must be pdf-user-space.');
  return { xMin, yMin, xMax, yMax, units: 'pdf-user-space' };
}

function normalizeView(value, path) {
  const view = cloneJson(assertRecord(value, path), path);
  if (view.type !== 'plan' || typeof view.storyId !== 'string' || !view.storyId.trim())
    fail('INVALID_STB_VIEW', path, 'STB drawing view must identify a plan and story.');
  return view;
}

export function normalizeDrawing(value, path = 'drawing') {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['source', 'view']), path);
  const source = assertRecord(value.source, `${path}.source`);
  assertKeys(source, new Set(['modelKey', 'modelRevision']), `${path}.source`);
  return {
    source: {
      modelKey: assertString(source.modelKey, `${path}.source.modelKey`),
      modelRevision: assertString(source.modelRevision, `${path}.source.modelRevision`),
    },
    view: normalizeView(value.view, `${path}.view`),
  };
}

export function drawingSnapshot(value, path) {
  if (value == null) return null;
  assertRecord(value, path);
  assertRecord(value.source, `${path}.source`);
  return normalizeDrawing(
    {
      source: {
        modelKey: value.source.modelKey,
        modelRevision: value.source.modelRevision,
      },
      view: value.view,
    },
    path,
  );
}

export function normalizeMapping(value, path = 'regionMapping') {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['schemaVersion', 'pdf', 'region', 'stb', 'key']), path);
  if (value.schemaVersion !== 1)
    fail('REGION_SCHEMA_MISMATCH', `${path}.schemaVersion`, 'Unsupported region mapping schema.');
  const pdf = assertRecord(value.pdf, `${path}.pdf`);
  assertKeys(
    pdf,
    new Set([
      'sha256',
      'byteLength',
      'numPages',
      'pageNumber',
      'viewBox',
      'userUnit',
      'intrinsicRotation',
    ]),
    `${path}.pdf`,
  );
  const pdfIdentity = normalizePdfIdentity(
    { sha256: pdf.sha256, byteLength: pdf.byteLength, numPages: pdf.numPages },
    `${path}.pdf`,
  );
  const pageRender = normalizePageRender(
    {
      pageNumber: pdf.pageNumber,
      viewBox: pdf.viewBox,
      userUnit: pdf.userUnit,
      intrinsicRotation: pdf.intrinsicRotation,
    },
    `${path}.pdf`,
  );
  if (pageRender.pageNumber > pdfIdentity.numPages)
    fail('INVALID_REGION_MAPPING', `${path}.pdf.pageNumber`, 'Page exceeds PDF page count.');
  const region = normalizeRegion(value.region, `${path}.region`, { allowNull: false });
  if (
    region.xMin < pageRender.viewBox[0] - 1e-6 ||
    region.yMin < pageRender.viewBox[1] - 1e-6 ||
    region.xMax > pageRender.viewBox[2] + 1e-6 ||
    region.yMax > pageRender.viewBox[3] + 1e-6
  ) {
    fail('INVALID_REGION', `${path}.region`, 'PDF region exceeds the page viewBox.');
  }
  const stb = assertRecord(value.stb, `${path}.stb`);
  assertKeys(stb, new Set(['modelKey', 'modelRevision', 'view']), `${path}.stb`);
  const normalizedStb = {
    modelKey: assertString(stb.modelKey, `${path}.stb.modelKey`),
    modelRevision: assertString(stb.modelRevision, `${path}.stb.modelRevision`),
    view: normalizeView(stb.view, `${path}.stb.view`),
  };
  const normalized = {
    schemaVersion: 1,
    pdf: { ...pdfIdentity, ...pageRender },
    region,
    stb: normalizedStb,
  };
  const expectedKey = JSON.stringify([
    normalized.pdf.sha256,
    normalized.pdf.pageNumber,
    normalized.region.xMin,
    normalized.region.yMin,
    normalized.region.xMax,
    normalized.region.yMax,
    normalized.stb.modelKey,
    normalized.stb.modelRevision,
    canonicalJson(normalized.stb.view),
  ]);
  if (value.key !== expectedKey)
    fail(
      'REGION_MAPPING_KEY_INVALID',
      `${path}.key`,
      'Region mapping key does not match its contents.',
    );
  return { ...normalized, key: expectedKey };
}

function normalizeAnchors(value, path) {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['a', 'b', 'c']), path);
  const anchors = {};
  for (const name of ['a', 'b', 'c']) {
    const point = assertRecord(value[name], `${path}.${name}`);
    assertKeys(point, new Set(['model', 'pdf']), `${path}.${name}`);
    for (const space of ['model', 'pdf']) {
      const pair = point[space];
      if (!Array.isArray(pair) || pair.length !== 2)
        fail(
          'INVALID_ANCHOR',
          `${path}.${name}.${space}`,
          'Anchor point must contain two coordinates.',
        );
      pair.forEach((coordinate, index) =>
        assertFinite(coordinate, `${path}.${name}.${space}[${index}]`),
      );
    }
    anchors[name] = { model: [...point.model], pdf: [...point.pdf] };
  }
  return anchors;
}

export function normalizeRegistration(value, path = 'registration') {
  if (value == null) return null;
  assertRecord(value, path);
  const allowed = new Set([
    'schemaVersion',
    'coordinateUnits',
    'coordinateFrames',
    'anchors',
    'matrix',
    'policy',
  ]);
  assertKeys(value, allowed, path);
  const schemaVersion = value.schemaVersion ?? REGISTRATION_SCHEMA_VERSION;
  if (schemaVersion !== REGISTRATION_SCHEMA_VERSION)
    fail(
      'REGISTRATION_SCHEMA_MISMATCH',
      `${path}.schemaVersion`,
      'Unsupported registration schema.',
    );
  const coordinateUnits = value.coordinateUnits ?? REGISTRATION_COORDINATE_UNITS;
  const coordinateFrames = value.coordinateFrames ?? REGISTRATION_COORDINATE_FRAMES;
  if (!sameJson(coordinateUnits, REGISTRATION_COORDINATE_UNITS))
    fail(
      'INVALID_COORDINATE_SCHEMA',
      `${path}.coordinateUnits`,
      'Registration units are unsupported.',
    );
  if (!sameJson(coordinateFrames, REGISTRATION_COORDINATE_FRAMES))
    fail(
      'INVALID_COORDINATE_SCHEMA',
      `${path}.coordinateFrames`,
      'Registration frames are unsupported.',
    );
  const anchors = normalizeAnchors(value.anchors, `${path}.anchors`);
  let matrix = null;
  if (value.matrix != null) {
    if (!Array.isArray(value.matrix) || value.matrix.length !== 6)
      fail('INVALID_MATRIX', `${path}.matrix`, 'Registration matrix must contain six values.');
    value.matrix.forEach((entry, index) => assertFinite(entry, `${path}.matrix[${index}]`));
    matrix = [...value.matrix];
  }
  const policyInput = value.policy == null ? {} : assertRecord(value.policy, `${path}.policy`);
  assertKeys(policyInput, new Set(Object.keys(DEFAULT_REGISTRATION_POLICY)), `${path}.policy`);
  const policy = { ...DEFAULT_REGISTRATION_POLICY, ...cloneJson(policyInput, `${path}.policy`) };
  if (!Object.values(policy).every((entry) => Number.isFinite(entry) && entry > 0))
    fail(
      'INVALID_POLICY',
      `${path}.policy`,
      'Registration policy values must be positive and finite.',
    );
  if (policy.minCheckAltitudeRatio > 1)
    fail(
      'INVALID_POLICY',
      `${path}.policy.minCheckAltitudeRatio`,
      'Check altitude ratio cannot exceed 1.',
    );
  return {
    schemaVersion,
    coordinateUnits: { ...REGISTRATION_COORDINATE_UNITS },
    coordinateFrames: { ...REGISTRATION_COORDINATE_FRAMES },
    anchors,
    matrix,
    policy,
  };
}

export function normalizePlacement(value, path = 'placement') {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['mode', 'scaleDenominator', 'matrix']), path);
  if (value.mode !== 'manual')
    fail('INVALID_PLACEMENT_MODE', `${path}.mode`, 'Placement mode must be manual.');
  const scaleDenominator = assertFinite(value.scaleDenominator, `${path}.scaleDenominator`);
  if (scaleDenominator < 1)
    fail(
      'INVALID_PLACEMENT_SCALE',
      `${path}.scaleDenominator`,
      'Scale denominator must be at least 1.',
    );
  if (!Array.isArray(value.matrix) || value.matrix.length !== 6)
    fail('INVALID_PLACEMENT_MATRIX', `${path}.matrix`, 'Placement matrix must contain six values.');
  value.matrix.forEach((entry, index) => assertFinite(entry, `${path}.matrix[${index}]`));
  const [a, b, c, d] = value.matrix;
  const scale = Math.hypot(a, b);
  const det = a * d - b * c;
  if (
    !Number.isFinite(det) ||
    !Number.isFinite(scale) ||
    scale === 0 ||
    Math.abs(det) <= scale * scale * 1e-12 ||
    Math.abs(c + b) > scale * 1e-10 ||
    Math.abs(d - a) > scale * 1e-10
  )
    fail(
      'INVALID_PLACEMENT_MATRIX',
      `${path}.matrix`,
      'Placement matrix must be an invertible direct similarity.',
    );
  return { mode: 'manual', scaleDenominator, matrix: [...value.matrix] };
}

function normalizeIdentity(value, path) {
  if (!Array.isArray(value) || value.length !== 3)
    fail(
      'INVALID_MEMBER_IDENTITY',
      path,
      'Member identity must be [modelKey, elementType, elementId].',
    );
  return value.map((part, index) => assertString(part, `${path}[${index}]`));
}

function normalizeReviewContext(value, path) {
  if (value == null) return null;
  assertRecord(value, path);
  assertKeys(value, new Set(['regionKey', 'alignmentKey']), path);
  const regionKey =
    value.regionKey == null ? null : assertString(value.regionKey, `${path}.regionKey`);
  const alignmentKey =
    value.alignmentKey == null ? null : assertString(value.alignmentKey, `${path}.alignmentKey`);
  return { regionKey, alignmentKey };
}

export function normalizeMemberReview(value, index) {
  const path = `memberReviews[${index}]`;
  assertRecord(value, path);
  assertKeys(
    value,
    new Set(['identity', 'reviewState', 'memo', 'reviewContext', 'invalidationCode']),
    path,
  );
  const reviewState = value.reviewState ?? 'unreviewed';
  if (!REVIEW_STATE_SET.has(reviewState))
    fail('INVALID_REVIEW_STATE', `${path}.reviewState`, 'Unsupported member review state.');
  const memo = value.memo == null ? '' : value.memo;
  if (typeof memo !== 'string')
    fail('INVALID_MEMO', `${path}.memo`, 'Member memo must be a string.');
  const invalidationCode = value.invalidationCode ?? null;
  if (invalidationCode !== null && typeof invalidationCode !== 'string')
    fail(
      'INVALID_INVALIDATION_CODE',
      `${path}.invalidationCode`,
      'Invalidation code must be a string or null.',
    );
  return {
    identity: normalizeIdentity(value.identity, `${path}.identity`),
    reviewState,
    memo,
    reviewContext: normalizeReviewContext(value.reviewContext, `${path}.reviewContext`),
    invalidationCode,
  };
}

export function normalizeDrawingMemo(value, index) {
  const path = `drawingMemos[${index}]`;
  assertRecord(value, path);
  if (
    'identity' in value ||
    'memberIdentity' in value ||
    'elementType' in value ||
    'elementId' in value ||
    'modelKey' in value
  ) {
    fail('MEMBER_BOUND_DRAWING_MEMO', path, 'Drawing memos cannot reference an STB member.');
  }
  assertKeys(value, new Set(['id', 'pageNumber', 'pdfPoint', 'text']), path);
  const id = assertString(value.id, `${path}.id`);
  const pageNumber =
    value.pageNumber == null ? null : assertPositiveInteger(value.pageNumber, `${path}.pageNumber`);
  let pdfPoint = null;
  if (value.pdfPoint != null) {
    if (!Array.isArray(value.pdfPoint) || value.pdfPoint.length !== 2)
      fail(
        'INVALID_DRAWING_MEMO_POINT',
        `${path}.pdfPoint`,
        'Drawing memo point must contain two coordinates.',
      );
    value.pdfPoint.forEach((coordinate, pointIndex) =>
      assertFinite(coordinate, `${path}.pdfPoint[${pointIndex}]`),
    );
    pdfPoint = [...value.pdfPoint];
  }
  if (pageNumber == null && pdfPoint != null)
    fail(
      'INVALID_DRAWING_MEMO_POINT',
      `${path}.pageNumber`,
      'A positioned drawing memo requires a page number.',
    );
  if (typeof value.text !== 'string')
    fail('INVALID_MEMO', `${path}.text`, 'Drawing memo text must be a string.');
  return { id, pageNumber, pdfPoint, text: value.text };
}

export function normalizeDocument(value) {
  assertRecord(value, '$');
  if (value.schemaVersion !== PDF_OVERLAY_SESSION_SCHEMA_VERSION) {
    fail(
      value.schemaVersion == null ? 'SCHEMA_VERSION_MISSING' : 'UNSUPPORTED_SCHEMA_VERSION',
      '$.schemaVersion',
      `Expected session schema version ${PDF_OVERLAY_SESSION_SCHEMA_VERSION}.`,
    );
  }
  if (value.kind !== PDF_OVERLAY_SESSION_KIND)
    fail('INVALID_DOCUMENT_KIND', '$.kind', 'Unexpected PDF overlay session document kind.');
  assertKeys(value, SESSION_KEYS, '$');
  for (const key of REQUIRED_SESSION_KEYS) {
    if (!(key in value)) fail('MISSING_FIELD', `$.${key}`, `Session field ${key} is required.`);
  }
  const pdfIdentity = normalizePdfIdentity(value.pdfIdentity);
  const pageRender = normalizePageRender(value.pageRender);
  const pageNumber =
    value.pageNumber == null ? null : assertPositiveInteger(value.pageNumber, 'pageNumber');
  const selectedRegion = normalizeRegion(value.selectedRegion, 'selectedRegion');
  const regionMapping = normalizeMapping(value.regionMapping);
  const drawing = normalizeDrawing(value.drawing);
  const registration = normalizeRegistration(value.registration);
  const placement = normalizePlacement(value.placement ?? null);
  if (!Array.isArray(value.memberReviews))
    fail('INVALID_TYPE', 'memberReviews', 'memberReviews must be an array.');
  if (!Array.isArray(value.drawingMemos))
    fail('INVALID_TYPE', 'drawingMemos', 'drawingMemos must be an array.');
  const memberReviews = value.memberReviews.map(normalizeMemberReview);
  const seenMemberKeys = new Set();
  for (const [index, review] of memberReviews.entries()) {
    const key = JSON.stringify(review.identity);
    if (seenMemberKeys.has(key))
      fail('DUPLICATE_MEMBER_REVIEW', `memberReviews[${index}]`, 'Member reviews must be unique.');
    seenMemberKeys.add(key);
  }
  const drawingMemos = value.drawingMemos.map(normalizeDrawingMemo);
  const seenMemoIds = new Set();
  for (const [index, memo] of drawingMemos.entries()) {
    if (seenMemoIds.has(memo.id))
      fail(
        'DUPLICATE_DRAWING_MEMO',
        `drawingMemos[${index}].id`,
        'Drawing memo IDs must be unique.',
      );
    seenMemoIds.add(memo.id);
  }
  return {
    kind: PDF_OVERLAY_SESSION_KIND,
    schemaVersion: PDF_OVERLAY_SESSION_SCHEMA_VERSION,
    pdfIdentity,
    pageRender,
    pageNumber,
    selectedRegion,
    regionMapping,
    drawing,
    registration,
    placement,
    memberReviews,
    drawingMemos,
  };
}
