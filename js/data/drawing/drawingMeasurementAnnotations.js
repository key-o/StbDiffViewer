/** @fileoverview 完了測定をtemporary DimensionIntentとして共通寸法compilerへ接続する。 */
import { assertMatrix, assertPoint } from './affine2d.js';
import { resolveDimensionFamily } from './dimensions/dimensionFamilyRegistry.js';
import { normalizeDimensionIntent } from './dimensions/dimensionIntentDefinition.js';
import { compileDimensionIntent } from './dimensions/dimensionRenderPlanCompiler.js';

export const MEASUREMENT_DIMENSION_FAMILY_ID = 'builtin:measurement-dimension-v1';
const MEASUREMENT_COLOR = '#087f8c';

function pointReference(point) {
  return Object.freeze({ kind: 'point', point: Object.freeze([...assertPoint(point)]) });
}

function formatMeasurementValue(valueModelMm) {
  return new globalThis.Intl.NumberFormat('ja-JP').format(Math.round(valueModelMm)) + ' mm';
}

/**
 * 完了測定を、viewportやpointer状態から独立したtemporary DimensionIntentとしてcompileする。
 * 永続的なsemantic referenceは持たず、解決済みmodel-mm端点だけを入力とする。
 */
export function compileDrawingMeasurementDimensions(measurements, modelToPaperInput) {
  if (!Array.isArray(measurements)) throw new TypeError('Completed measurements must be an array.');
  const modelToPaper = Object.freeze([...assertMatrix(modelToPaperInput)]);
  const family = resolveDimensionFamily(MEASUREMENT_DIMENSION_FAMILY_ID);
  const ids = new Set();

  return Object.freeze(
    measurements.map((measurement) => {
      const { id, offsetModelMm, pageNumber } = measurement || {};
      if (typeof id !== 'string' || !id || ids.has(id))
        throw new TypeError('Completed measurement IDs must be unique nonempty strings.');
      ids.add(id);
      if (pageNumber != null)
        throw new TypeError('PDF-bound measurements cannot become sheet dimensions.');
      if (!Number.isFinite(offsetModelMm))
        throw new TypeError('Completed measurement offset must be resolved in model mm.');

      const p1 = assertPoint(measurement.p1);
      const p2 = assertPoint(measurement.p2);
      const distance = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (!Number.isFinite(distance) || distance < 1)
        throw new RangeError('Completed dimension must measure at least 1 mm.');

      const intent = normalizeDimensionIntent({
        schemaVersion: 1,
        id,
        kind: 'linear-chain',
        references: [pointReference(p1), pointReference(p2)],
        placement: { offsetModelMm },
        familyId: family.id,
      });
      const compiled = compileDimensionIntent({
        intent,
        family,
        familyBuiltIn: true,
        modelToPaper,
        formatValue: formatMeasurementValue,
      });

      return Object.freeze({
        id: `dimension:measurement:${id}`,
        intentId: compiled.intent.id,
        familyId: compiled.familyId,
        measurementId: id,
        layerId: 'Annotation',
        visibilitySource: 'Annotation',
        visible: true,
        strokeColor: MEASUREMENT_COLOR,
        textColor: MEASUREMENT_COLOR,
        primitives: compiled.primitives,
      });
    }),
  );
}
