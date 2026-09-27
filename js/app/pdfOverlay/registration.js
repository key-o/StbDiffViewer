/** @fileoverview A/B登録 + 独立確認点C。元STBとPDFを変更しない。 */
import {
  assertPoint,
  isDirectSimilarity,
  pointDistance,
  solveSimilarity,
  transformPoint,
} from '../../data/drawing/affine2d.js';

export const REGISTRATION_SCHEMA_VERSION = 1;
export const REGISTRATION_COORDINATE_UNITS = Object.freeze({
  model: 'mm',
  pdf: 'user-space-unit',
});
export const REGISTRATION_COORDINATE_FRAMES = Object.freeze({
  model: 'STB_MODEL',
  pdf: 'UNROTATED_PDF_PAGE',
});
export const REGISTRATION_RESULT_SCHEMA = Object.freeze({
  version: REGISTRATION_SCHEMA_VERSION,
  coordinateUnits: REGISTRATION_COORDINATE_UNITS,
  coordinateFrames: REGISTRATION_COORDINATE_FRAMES,
  matrix: Object.freeze({ from: 'STB_MODEL_MM', to: 'UNROTATED_PDF_USER_SPACE' }),
  resultUnits: Object.freeze({
    errorMm: 'mm',
    errorPdf: 'user-space-unit',
    predicted: 'user-space-unit',
  }),
});

/** Registration input has explicit, versioned coordinate units. */
export function createRegistrationInput(anchors) {
  return {
    schemaVersion: REGISTRATION_SCHEMA_VERSION,
    coordinateUnits: REGISTRATION_COORDINATE_UNITS,
    coordinateFrames: REGISTRATION_COORDINATE_FRAMES,
    anchors,
  };
}

function hasRegistrationSchema(input) {
  return (
    input?.schemaVersion === REGISTRATION_SCHEMA_VERSION &&
    input?.coordinateUnits?.model === REGISTRATION_COORDINATE_UNITS.model &&
    input?.coordinateUnits?.pdf === REGISTRATION_COORDINATE_UNITS.pdf &&
    input?.coordinateFrames?.model === REGISTRATION_COORDINATE_FRAMES.model &&
    input?.coordinateFrames?.pdf === REGISTRATION_COORDINATE_FRAMES.pdf
  );
}

// 操作上の仮設定。部材の設計許容差・施工許容差ではない。
export const DEFAULT_REGISTRATION_POLICY = Object.freeze({
  toleranceMm: 20,
  minModelBaselineMm: 1000,
  minPdfBaselinePt: 20,
  minCheckAltitudeRatio: 0.05,
  userUnit: 1,
});

/** Cを推定に使わない。復元された行列もA/Bから独立に再検証する。 */
export function evaluateRegistration(anchors, matrix, policy = {}) {
  const settings = { ...DEFAULT_REGISTRATION_POLICY, ...policy };
  const invalid = (code) => ({
    schema: REGISTRATION_RESULT_SCHEMA,
    ok: false,
    code,
    errorMm: null,
    errorPdf: null,
  });
  if (!hasRegistrationSchema(anchors)) return invalid('INVALID_COORDINATE_SCHEMA');
  anchors = anchors.anchors;
  if (!Object.values(settings).every((value) => Number.isFinite(value) && value > 0))
    return invalid('INVALID_POLICY');
  if (settings.minCheckAltitudeRatio > 1) return invalid('INVALID_POLICY');
  if (!isDirectSimilarity(matrix)) return invalid('NOT_DIRECT_SIMILARITY');
  try {
    for (const key of ['a', 'b', 'c']) {
      assertPoint(anchors?.[key]?.model);
      assertPoint(anchors?.[key]?.pdf);
    }
  } catch {
    return invalid('MISSING_OR_INVALID_ANCHOR');
  }
  const { a, b, c } = anchors;
  const baseline = pointDistance(a.model, b.model);
  const paperBaseline = pointDistance(a.pdf, b.pdf) * settings.userUnit;
  if (baseline < settings.minModelBaselineMm || paperBaseline < settings.minPdfBaselinePt)
    return invalid('BASELINE_TOO_SHORT');
  const ux = (b.model[0] - a.model[0]) / baseline;
  const uy = (b.model[1] - a.model[1]) / baseline;
  const altitude = Math.abs(ux * (c.model[1] - a.model[1]) - uy * (c.model[0] - a.model[0]));
  if (altitude / baseline < settings.minCheckAltitudeRatio)
    return invalid('CHECK_POINT_NEAR_BASELINE');
  try {
    // A/Bに一致しない保存行列を、Cだけが一致したことを理由に固定しない。
    const fitted = solveSimilarity(a.model, b.model, a.pdf, b.pdf);
    const anchorTolerance = Math.max(pointDistance(a.pdf, b.pdf) * 1e-9, 1e-8);
    for (const anchor of [a, b]) {
      if (
        pointDistance(transformPoint(matrix, anchor.model), transformPoint(fitted, anchor.model)) >
        anchorTolerance
      )
        return invalid('ANCHOR_MATRIX_MISMATCH');
    }
    const predicted = transformPoint(matrix, c.model);
    const errorPdf = pointDistance(predicted, c.pdf);
    const errorMm = errorPdf / Math.hypot(matrix[0], matrix[1]);
    if (!Number.isFinite(errorMm)) return invalid('NONFINITE_RESIDUAL');
    return {
      schema: REGISTRATION_RESULT_SCHEMA,
      ok: errorMm <= settings.toleranceMm,
      code: errorMm <= settings.toleranceMm ? 'CHECK_WITHIN_GUIDE' : 'CHECK_EXCEEDS_GUIDE',
      errorPdf,
      errorMm,
      predicted,
    };
  } catch {
    return invalid('INVALID_TRANSFORM');
  }
}
