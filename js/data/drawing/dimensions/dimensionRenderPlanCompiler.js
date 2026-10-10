/** @fileoverview DimensionIntent + DimensionFamily -> renderer非依存の寸法primitive compiler。 */
import {
  assertMatrix,
  assertPoint,
  invertAffine,
  isDirectSimilarity,
  transformPoint,
} from '../affine2d.js';
import { normalizeDimensionFamily } from './dimensionFamilyDefinition.js';
import { resolveTerminatorFamily as resolveBuiltinTerminatorFamily } from './dimensionFamilyRegistry.js';
import { normalizeDimensionIntent } from './dimensionIntentDefinition.js';
import { normalizeTerminatorFamily } from './terminatorFamilyDefinition.js';

export const DIMENSION_RENDER_PLAN_SCHEMA_VERSION = 1;
const EPSILON = 1e-9;

function resolveBuiltinTerminator(familyId) {
  return Object.freeze({
    family: resolveBuiltinTerminatorFamily(familyId),
    builtIn: true,
  });
}

function normalizeResolvedTerminator(result, expectedFamilyId) {
  let familyInput = result;
  let builtIn = false;
  if (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Object.hasOwn(result, 'family')
  ) {
    for (const key of Object.keys(result)) {
      if (!['family', 'builtIn'].includes(key))
        throw new TypeError(`TerminatorFamily resolver resultに未対応のfieldがあります: ${key}`);
    }
    if (typeof result.builtIn !== 'boolean')
      throw new TypeError('TerminatorFamily resolver resultのbuiltInが不正です。');
    familyInput = result.family;
    builtIn = result.builtIn;
  }
  const family = normalizeTerminatorFamily(familyInput, { builtIn });
  if (family.id !== expectedFamilyId)
    throw new TypeError(
      `TerminatorFamily resolverが要求IDと異なるfamilyを返しました: ${expectedFamilyId} -> ${family.id}`,
    );
  return family;
}

function freezePoint(point) {
  return Object.freeze([...assertPoint(point)]);
}

function vectorLength(vector) {
  return Math.hypot(vector[0], vector[1]);
}

function normalizeVector(vector, name) {
  const length = vectorLength(vector);
  if (!Number.isFinite(length) || length <= EPSILON) throw new RangeError(`${name}が不正です。`);
  return [vector[0] / length, vector[1] / length];
}

function transformVector(matrix, vector) {
  assertMatrix(matrix);
  assertPoint(vector);
  return [
    matrix[0] * vector[0] + matrix[2] * vector[1],
    matrix[1] * vector[0] + matrix[3] * vector[1],
  ];
}

function add(point, vector, scale = 1) {
  return [point[0] + vector[0] * scale, point[1] + vector[1] * scale];
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function angleDeg(vector) {
  return (Math.atan2(vector[1], vector[0]) * 180) / Math.PI;
}

function readableAngleDeg(value) {
  let angle = value % 360;
  if (angle <= -180) angle += 360;
  if (angle > 180) angle -= 360;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return angle;
}

function paperToModelAngle(paperToModel, paperAngleDeg) {
  const radians = (paperAngleDeg * Math.PI) / 180;
  const direction = transformVector(paperToModel, [Math.cos(radians), Math.sin(radians)]);
  return angleDeg(direction);
}

function scaleOfDirectSimilarity(matrix) {
  if (!isDirectSimilarity(matrix))
    throw new TypeError('Dimension compilerには向きを保存する相似modelToPaperが必要です。');
  const scale = Math.hypot(matrix[0], matrix[1]);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new TypeError('modelToPaper縮尺が不正です。');
  return scale;
}

function resolveReferencePoint(reference, resolveReference) {
  if (reference.kind === 'point') return [...reference.point];
  if (typeof resolveReference !== 'function')
    throw new Error(`DimensionReference ${reference.kind} にはresolverが必要です。`);
  const resolved = resolveReference(reference);
  const point = Array.isArray(resolved) ? resolved : resolved?.point;
  return [...assertPoint(point)];
}

function assertOrderedCollinear(points, direction) {
  const origin = points[0];
  const normal = [-direction[1], direction[0]];
  const span = Math.max(
    1,
    vectorLength([points.at(-1)[0] - origin[0], points.at(-1)[1] - origin[1]]),
  );
  const tolerance = Math.max(1e-6, span * 1e-9);
  let previousProjection = -Infinity;
  for (const point of points) {
    const delta = [point[0] - origin[0], point[1] - origin[1]];
    const distance = Math.abs(delta[0] * normal[0] + delta[1] * normal[1]);
    if (distance > tolerance)
      throw new RangeError('linear-chainの参照点は同一直線上に配置してください。');
    const projection = delta[0] * direction[0] + delta[1] * direction[1];
    if (projection <= previousProjection + tolerance)
      throw new RangeError('linear-chainの参照点は寸法方向へ重複なく昇順に配置してください。');
    previousProjection = projection;
  }
}

function linePrimitive({
  id,
  role,
  modelPoints,
  paperPoints,
  strokeWidthPaperMm,
  dashPatternPaperMm = null,
  extra = {},
}) {
  return Object.freeze({
    id,
    kind: 'line',
    role,
    points: Object.freeze({
      model: Object.freeze(modelPoints.map(freezePoint)),
      paper: Object.freeze(paperPoints.map(freezePoint)),
    }),
    style: Object.freeze({
      strokeWidthPaperMm,
      ...(dashPatternPaperMm ? { dashPatternPaperMm } : {}),
    }),
    ...extra,
  });
}

function circlePrimitive({
  id,
  centerPaper,
  radiusPaperMm,
  paperToModel,
  filled,
  strokeWidthPaperMm,
  extra = {},
}) {
  const centerModel = transformPoint(paperToModel, centerPaper);
  const modelScale = Math.hypot(paperToModel[0], paperToModel[1]);
  return Object.freeze({
    id,
    kind: 'circle',
    role: 'dimension-terminator',
    center: Object.freeze({ model: freezePoint(centerModel), paper: freezePoint(centerPaper) }),
    radius: Object.freeze({ model: radiusPaperMm * modelScale, paper: radiusPaperMm }),
    filled: filled === true,
    style: Object.freeze({ strokeWidthPaperMm }),
    ...extra,
  });
}

function polylinePrimitive({
  id,
  pointsPaper,
  paperToModel,
  filled,
  strokeWidthPaperMm,
  extra = {},
}) {
  const pointsModel = pointsPaper.map((point) => transformPoint(paperToModel, point));
  return Object.freeze({
    id,
    kind: 'polyline',
    role: 'dimension-terminator',
    closed: true,
    filled: filled === true,
    style: Object.freeze({ strokeWidthPaperMm }),
    points: Object.freeze({
      model: Object.freeze(pointsModel.map(freezePoint)),
      paper: Object.freeze(pointsPaper.map(freezePoint)),
    }),
    ...extra,
  });
}

function compileTerminator({
  idPrefix,
  centerPaper,
  dimensionUnitPaper,
  position,
  terminator,
  paperToModel,
  strokeWidthPaperMm,
}) {
  const common = Object.freeze({ terminatorKind: terminator.kind, terminatorPosition: position });
  if (terminator.kind === 'none') return [];

  if (terminator.kind === 'slash') {
    const angle = angleDeg(dimensionUnitPaper) + terminator.geometry.angleDeg;
    const radians = (angle * Math.PI) / 180;
    const half = terminator.geometry.lengthPaperMm / 2;
    const vector = [Math.cos(radians), Math.sin(radians)];
    const a = add(centerPaper, vector, -half);
    const b = add(centerPaper, vector, half);
    return [
      linePrimitive({
        id: `${idPrefix}:slash`,
        role: 'dimension-terminator',
        modelPoints: [transformPoint(paperToModel, a), transformPoint(paperToModel, b)],
        paperPoints: [a, b],
        strokeWidthPaperMm,
        extra: common,
      }),
    ];
  }

  if (terminator.kind === 'circle' || terminator.kind === 'dot') {
    return [
      circlePrimitive({
        id: `${idPrefix}:${terminator.kind}`,
        centerPaper,
        radiusPaperMm: terminator.geometry.diameterPaperMm / 2,
        paperToModel,
        filled: terminator.kind === 'dot',
        strokeWidthPaperMm,
        extra: common,
      }),
    ];
  }

  const inwardSign = position === 'end' ? -1 : 1;
  const inward = [dimensionUnitPaper[0] * inwardSign, dimensionUnitPaper[1] * inwardSign];
  const normal = [-inward[1], inward[0]];
  const tail = add(centerPaper, inward, terminator.geometry.lengthPaperMm);
  const halfWidth = terminator.geometry.widthPaperMm / 2;
  const wingA = add(tail, normal, halfWidth);
  const wingB = add(tail, normal, -halfWidth);

  if (terminator.kind === 'open-arrow') {
    return [
      linePrimitive({
        id: `${idPrefix}:open-a`,
        role: 'dimension-terminator',
        modelPoints: [
          transformPoint(paperToModel, centerPaper),
          transformPoint(paperToModel, wingA),
        ],
        paperPoints: [centerPaper, wingA],
        strokeWidthPaperMm,
        extra: common,
      }),
      linePrimitive({
        id: `${idPrefix}:open-b`,
        role: 'dimension-terminator',
        modelPoints: [
          transformPoint(paperToModel, centerPaper),
          transformPoint(paperToModel, wingB),
        ],
        paperPoints: [centerPaper, wingB],
        strokeWidthPaperMm,
        extra: common,
      }),
    ];
  }

  return [
    polylinePrimitive({
      id: `${idPrefix}:filled`,
      pointsPaper: [centerPaper, wingA, wingB],
      paperToModel,
      filled: true,
      strokeWidthPaperMm,
      extra: common,
    }),
  ];
}

function defaultFormatValue(valueModelMm) {
  return String(Math.round(Math.abs(valueModelMm)));
}

/**
 * DimensionIntentをmodel/paper両座標を持つrenderer非依存primitiveへcompileする。
 * paper-mmの線幅・文字・terminator寸法はmodelToPaper縮尺で変化させない。
 */
export function compileDimensionIntent({
  intent: intentInput,
  family: familyInput,
  modelToPaper: modelToPaperInput,
  familyBuiltIn = false,
  resolveReference = null,
  resolveTerminatorFamily = resolveBuiltinTerminator,
  formatValue = defaultFormatValue,
} = {}) {
  const intent = normalizeDimensionIntent(intentInput);
  const family = normalizeDimensionFamily(familyInput, { builtIn: familyBuiltIn });
  if (intent.familyId !== family.id)
    throw new TypeError(
      `DimensionIntent familyIdとDimensionFamilyが一致しません: ${intent.familyId}`,
    );
  if (typeof resolveTerminatorFamily !== 'function')
    throw new TypeError('TerminatorFamily resolverが必要です。');
  if (typeof formatValue !== 'function')
    throw new TypeError('dimension value formatterが不正です。');

  const modelToPaper = [...assertMatrix(modelToPaperInput)];
  scaleOfDirectSimilarity(modelToPaper);
  const paperToModel = invertAffine(modelToPaper);
  const referencePointsModel = intent.references.map((reference) =>
    resolveReferencePoint(reference, resolveReference),
  );
  const dimensionDirectionModel = normalizeVector(
    [
      referencePointsModel.at(-1)[0] - referencePointsModel[0][0],
      referencePointsModel.at(-1)[1] - referencePointsModel[0][1],
    ],
    'DimensionIntent参照方向',
  );
  assertOrderedCollinear(referencePointsModel, dimensionDirectionModel);
  const normalModel = [-dimensionDirectionModel[1], dimensionDirectionModel[0]];
  const dimensionPointsModel = referencePointsModel.map((point) =>
    add(point, normalModel, intent.placement.offsetModelMm),
  );
  const referencePointsPaper = referencePointsModel.map((point) =>
    transformPoint(modelToPaper, point),
  );
  const dimensionPointsPaper = dimensionPointsModel.map((point) =>
    transformPoint(modelToPaper, point),
  );
  const dimensionUnitPaper = normalizeVector(
    [
      dimensionPointsPaper.at(-1)[0] - dimensionPointsPaper[0][0],
      dimensionPointsPaper.at(-1)[1] - dimensionPointsPaper[0][1],
    ],
    'paper寸法方向',
  );
  const normalPaperBase = normalizeVector(
    transformVector(modelToPaper, normalModel),
    'paper法線方向',
  );
  const witnessUnitPaper =
    intent.placement.offsetModelMm < 0
      ? [-normalPaperBase[0], -normalPaperBase[1]]
      : normalPaperBase;

  const primitives = [];
  primitives.push(
    linePrimitive({
      id: `${intent.id}:dimension-line`,
      role: 'dimension-line',
      modelPoints: [dimensionPointsModel[0], dimensionPointsModel.at(-1)],
      paperPoints: [dimensionPointsPaper[0], dimensionPointsPaper.at(-1)],
      strokeWidthPaperMm: family.line.strokeWidthPaperMm,
      dashPatternPaperMm: family.line.dashPatternPaperMm ?? null,
    }),
  );

  for (let index = 0; index < referencePointsPaper.length; index += 1) {
    const referencePaper = referencePointsPaper[index];
    const dimensionPaper = dimensionPointsPaper[index];
    const endPaper = add(dimensionPaper, witnessUnitPaper, family.witnessLine.overshootPaperMm);
    const startPaper =
      family.witnessLine.fixedLengthPaperMm == null
        ? add(referencePaper, witnessUnitPaper, family.witnessLine.gapPaperMm)
        : add(endPaper, witnessUnitPaper, -family.witnessLine.fixedLengthPaperMm);
    primitives.push(
      linePrimitive({
        id: `${intent.id}:witness:${index}`,
        role: 'dimension-witness',
        modelPoints: [
          transformPoint(paperToModel, startPaper),
          transformPoint(paperToModel, endPaper),
        ],
        paperPoints: [startPaper, endPaper],
        strokeWidthPaperMm: family.witnessLine.strokeWidthPaperMm,
        dashPatternPaperMm: family.witnessLine.dashPatternPaperMm ?? null,
        extra: Object.freeze({ referenceIndex: index }),
      }),
    );

    const position =
      index === 0 ? 'start' : index === referencePointsPaper.length - 1 ? 'end' : 'intermediate';
    const terminatorId = family.terminators[position];
    const terminator = normalizeResolvedTerminator(
      resolveTerminatorFamily(terminatorId),
      terminatorId,
    );
    primitives.push(
      ...compileTerminator({
        idPrefix: `${intent.id}:terminator:${index}`,
        centerPaper: dimensionPaper,
        dimensionUnitPaper,
        position,
        terminator,
        paperToModel,
        strokeWidthPaperMm: family.line.strokeWidthPaperMm,
      }),
    );
  }

  for (let index = 0; index < dimensionPointsPaper.length - 1; index += 1) {
    const paperPoint = add(
      midpoint(dimensionPointsPaper[index], dimensionPointsPaper[index + 1]),
      witnessUnitPaper,
      family.text.gapPaperMm,
    );
    const valueModelMm = vectorLength([
      referencePointsModel[index + 1][0] - referencePointsModel[index][0],
      referencePointsModel[index + 1][1] - referencePointsModel[index][1],
    ]);
    const text = String(formatValue(valueModelMm, { intent, index }));
    const rotationPaper =
      family.text.orientation === 'horizontal-on-paper'
        ? 0
        : readableAngleDeg(angleDeg(dimensionUnitPaper));
    primitives.push(
      Object.freeze({
        id: `${intent.id}:text:${index}`,
        kind: 'text',
        role: 'dimension-text',
        text,
        valueModelMm,
        point: Object.freeze({
          model: freezePoint(transformPoint(paperToModel, paperPoint)),
          paper: freezePoint(paperPoint),
        }),
        rotationDeg: Object.freeze({
          model: paperToModelAngle(paperToModel, rotationPaper),
          paper: rotationPaper,
        }),
        style: Object.freeze({ heightPaperMm: family.text.heightPaperMm }),
        segmentIndex: index,
      }),
    );
  }

  return Object.freeze({
    schemaVersion: DIMENSION_RENDER_PLAN_SCHEMA_VERSION,
    kind: 'DimensionRenderPlan',
    units: Object.freeze({ model: 'mm', paper: 'mm', angle: 'degree' }),
    intent,
    familyId: family.id,
    primitives: Object.freeze(primitives),
  });
}
