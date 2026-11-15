/**
 * @fileoverview 配置行列の分解・座標変換ユーティリティ
 *
 * IFCのIFCLOCALPLACEMENT chain を解決してワールド座標を取得し、
 * 要素の始点・終点を抽出する。
 *
 * @module CoordinateHelper
 */

import * as WebIFC from 'web-ifc';

/**
 * column-major 4x4行列から位置を抽出
 * @param {number[]} m - 16要素のcolumn-major行列
 * @returns {{x: number, y: number, z: number}}
 */
export function extractPosition(m) {
  return { x: m[12], y: m[13], z: m[14] };
}

/**
 * column-major 4x4行列で点を変換
 * @param {{x: number, y: number, z: number}} p
 * @param {number[]} m - 16要素のcolumn-major行列
 * @returns {{x: number, y: number, z: number}}
 */
export function transformPoint(p, m) {
  return {
    x: p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12],
    y: p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13],
    z: p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14],
  };
}

/**
 * 2つの4x4 column-major行列を乗算
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]} a * b
 */
export function multiplyMatrices(a, b) {
  const result = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      result[col * 4 + row] = sum;
    }
  }
  return result;
}

/** 単位行列 */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * IFC CartesianTransformationOperator から4x4変換行列を構築
 * @param {Object} api
 * @param {number} modelID
 * @param {number|Object} operatorRef
 * @returns {number[]} column-major変換行列
 */
export function buildMatrixFromCartesianTransformationOperator(api, modelID, operatorRef) {
  const operatorId = operatorRef?.value ?? operatorRef;
  const operator = operatorId ? api.GetLine(modelID, operatorId) : null;
  if (!operator) throw new Error('IFC mapping target transformation operator was not found');

  const xAxis = operator.Axis1
    ? resolveMappingDirection(api, modelID, operator.Axis1)
    : { x: 1, y: 0, z: 0 };
  const yAxis = operator.Axis2
    ? resolveMappingDirection(api, modelID, operator.Axis2)
    : normalizeDirection(
        Math.abs(xAxis.z) < 0.9
          ? { x: -xAxis.y, y: xAxis.x, z: 0 }
          : { x: xAxis.z, y: 0, z: -xAxis.x },
      );
  const zAxis = normalizeDirection(
    operator.Axis3
      ? resolveMappingDirection(api, modelID, operator.Axis3)
      : {
          x: xAxis.y * yAxis.z - xAxis.z * yAxis.y,
          y: xAxis.z * yAxis.x - xAxis.x * yAxis.z,
          z: xAxis.x * yAxis.y - xAxis.y * yAxis.x,
        },
  );
  const originId = operator.LocalOrigin?.value ?? operator.LocalOrigin;
  const originEntity = originId ? api.GetLine(modelID, originId) : null;
  if (!originEntity?.Coordinates) {
    throw new Error('IFC mapping target has no valid LocalOrigin');
  }
  const origin = resolveCartesianPoint(api, modelID, originId);
  const scale = getNumericValue(operator.Scale, 1);
  const scale2 = getNumericValue(operator.Scale2, scale);
  const scale3 = getNumericValue(operator.Scale3, scale);

  if (
    ![scale, scale2, scale3].every((value) => Number.isFinite(value) && Math.abs(value) > 1e-12)
  ) {
    throw new Error('IFC mapping target contains an invalid scale');
  }

  return [
    xAxis.x * scale,
    xAxis.y * scale,
    xAxis.z * scale,
    0,
    yAxis.x * scale2,
    yAxis.y * scale2,
    yAxis.z * scale2,
    0,
    zAxis.x * scale3,
    zAxis.y * scale3,
    zAxis.z * scale3,
    0,
    origin.x,
    origin.y,
    origin.z,
    1,
  ];
}

/**
 * MappingTarget と MappingOrigin の逆変換を合成
 * @param {Object} api
 * @param {number} modelID
 * @param {Object} mappedItem - IFCMAPPEDITEM
 * @returns {number[]} MappingTarget * inverse(MappingOrigin)
 */
export function resolveMappedItemTransform(api, modelID, mappedItem) {
  const sourceId = mappedItem?.MappingSource?.value ?? mappedItem?.MappingSource;
  const source = sourceId ? api.GetLine(modelID, sourceId) : null;
  if (!source?.MappingOrigin) throw new Error('IFC mapped item has no valid MappingOrigin');
  const originId = source.MappingOrigin.value ?? source.MappingOrigin;
  if (!originId || !api.GetLine(modelID, originId)) {
    throw new Error('IFC mapped item MappingOrigin placement was not found');
  }

  const targetMatrix = buildMatrixFromCartesianTransformationOperator(
    api,
    modelID,
    mappedItem.MappingTarget,
  );
  const originMatrix = buildMatrixFromAxis2Placement(api, modelID, originId);
  return multiplyMatrices(targetMatrix, invertMatrix4(originMatrix));
}

/**
 * IFC表現内のmapped itemとclippingをたどり、葉形状と合成変換を返す
 * @param {Object} api
 * @param {number} modelID
 * @param {number|Object} itemRef
 * @param {number[]} [parentTransform]
 * @param {Set<number>} [activePath]
 * @returns {Array<{item:Object, mappingTransform:number[]}>}
 */
export function collectMappedItemLeaves(
  api,
  modelID,
  itemRef,
  parentTransform = IDENTITY,
  activePath = new Set(),
) {
  const itemId = itemRef?.value ?? itemRef;
  if (!itemId) return [];
  if (activePath.has(itemId)) {
    throw new Error(`Cyclic IFC representation item reference: ${itemId}`);
  }

  const item = api.GetLine(modelID, itemId);
  if (!item) return [];

  const nextPath = new Set(activePath);
  nextPath.add(itemId);

  if (item.type === WebIFC.IFCMAPPEDITEM) {
    const sourceId = item.MappingSource?.value ?? item.MappingSource;
    const source = sourceId ? api.GetLine(modelID, sourceId) : null;
    const mappedRepresentationId =
      source?.MappedRepresentation?.value ?? source?.MappedRepresentation;
    const mappedRepresentation = mappedRepresentationId
      ? api.GetLine(modelID, mappedRepresentationId)
      : null;
    if (!mappedRepresentation?.Items) {
      throw new Error(`IFC mapped item ${itemId} has no mapped representation items`);
    }

    const mappingTransform = multiplyMatrices(
      parentTransform,
      resolveMappedItemTransform(api, modelID, item),
    );
    return mappedRepresentation.Items.flatMap((mappedItemRef) =>
      collectMappedItemLeaves(api, modelID, mappedItemRef, mappingTransform, nextPath),
    );
  }

  if (item.type === WebIFC.IFCBOOLEANCLIPPINGRESULT) {
    const firstOperand = item.FirstOperand?.value ?? item.FirstOperand;
    return firstOperand
      ? collectMappedItemLeaves(api, modelID, firstOperand, parentTransform, nextPath)
      : [];
  }

  return [{ item, mappingTransform: parentTransform }];
}

/**
 * 4x4行列を反転
 * @param {number[]} matrix - column-major行列
 * @returns {number[]} column-major逆行列
 */
export function invertMatrix4(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 16) {
    throw new TypeError('Expected a 16-element matrix');
  }

  const rows = Array.from({ length: 4 }, (_, row) => [
    matrix[row],
    matrix[4 + row],
    matrix[8 + row],
    matrix[12 + row],
    ...Array.from({ length: 4 }, (_, column) => (row === column ? 1 : 0)),
  ]);

  for (let column = 0; column < 4; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(rows[pivotRow][column]) < 1e-12) {
      throw new Error('Cannot invert a singular IFC placement matrix');
    }
    [rows[column], rows[pivotRow]] = [rows[pivotRow], rows[column]];

    const pivot = rows[column][column];
    for (let index = 0; index < 8; index++) rows[column][index] /= pivot;
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = 0; index < 8; index++) {
        rows[row][index] -= factor * rows[column][index];
      }
    }
  }

  return Array.from({ length: 16 }, (_, index) => rows[index % 4][4 + Math.floor(index / 4)]);
}

/**
 * 行列が一様スケールであることを確認し、スケールを返す
 * @param {number[]} matrix
 * @returns {number}
 */
export function getUniformScale(matrix) {
  const axes = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[4], matrix[5], matrix[6]],
    [matrix[8], matrix[9], matrix[10]],
  ];
  const scales = axes.map((axis) => Math.hypot(...axis));
  const referenceScale = scales[0];
  const tolerance = Math.max(referenceScale, 1) * 1e-8;
  const orthogonal = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (
    !Number.isFinite(referenceScale) ||
    referenceScale <= 1e-12 ||
    scales.some((scale) => Math.abs(scale - referenceScale) > tolerance) ||
    Math.abs(orthogonal(axes[0], axes[1])) > tolerance * referenceScale ||
    Math.abs(orthogonal(axes[0], axes[2])) > tolerance * referenceScale ||
    Math.abs(orthogonal(axes[1], axes[2])) > tolerance * referenceScale
  ) {
    throw new Error('Non-uniformly scaled or skewed IFC mapped profiles are not supported');
  }
  return referenceScale;
}

/**
 * IFCLOCALPLACEMENT chain を再帰的に解決してワールド変換行列を取得
 * @param {Object} api - web-ifc IfcAPI
 * @param {number} modelID
 * @param {number} placementId - IFCLOCALPLACEMENT の expressID
 * @param {Map} [cache] - 解決済みキャッシュ
 * @returns {number[]} 4x4 column-major ワールド変換行列
 */
export function resolvePlacement(api, modelID, placementId, cache = new Map()) {
  if (cache.has(placementId)) return cache.get(placementId);

  const placement = api.GetLine(modelID, placementId);
  if (!placement) {
    cache.set(placementId, IDENTITY);
    return IDENTITY;
  }

  // ローカル変換行列を構築
  let localMatrix = IDENTITY;
  const relativePlacement = placement.RelativePlacement;
  if (relativePlacement) {
    const axisId = relativePlacement.value ?? relativePlacement;
    localMatrix = buildMatrixFromAxis2Placement(api, modelID, axisId);
  }

  // 親プレースメントがある場合は再帰的に解決
  const parentRef = placement.PlacementRelTo;
  if (parentRef) {
    const parentId = parentRef.value ?? parentRef;
    if (parentId) {
      const parentMatrix = resolvePlacement(api, modelID, parentId, cache);
      const worldMatrix = multiplyMatrices(parentMatrix, localMatrix);
      cache.set(placementId, worldMatrix);
      return worldMatrix;
    }
  }

  cache.set(placementId, localMatrix);
  return localMatrix;
}

/**
 * IFCAXIS2PLACEMENT3D から4x4変換行列を構築
 * @param {Object} api
 * @param {number} modelID
 * @param {number} axisId
 * @returns {number[]}
 */
export function buildMatrixFromAxis2Placement(api, modelID, axisId) {
  const axis = api.GetLine(modelID, axisId);
  if (!axis) return IDENTITY;

  // 原点
  const loc = resolveCartesianPoint(api, modelID, axis.Location);
  const ox = loc.x;
  const oy = loc.y;
  const oz = loc.z;

  // Z軸 (Axis)
  let zx = 0,
    zy = 0,
    zz = 1;
  if (axis.Axis) {
    const dir = resolveDirection(api, modelID, axis.Axis);
    zx = dir.x;
    zy = dir.y;
    zz = dir.z;
  }

  // X軸 (RefDirection)
  let xx = 1,
    xy = 0,
    xz = 0;
  if (axis.RefDirection) {
    const dir = resolveDirection(api, modelID, axis.RefDirection);
    xx = dir.x;
    xy = dir.y;
    xz = dir.z;
  } else {
    // デフォルトX軸: Z軸と非平行なベクトルから導出
    const arbitrary = Math.abs(zx) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const yx2 = zy * arbitrary.z - zz * arbitrary.y;
    const yy2 = zz * arbitrary.x - zx * arbitrary.z;
    const yz2 = zx * arbitrary.y - zy * arbitrary.x;
    xx = yy2 * zz - yz2 * zy;
    xy = yz2 * zx - yx2 * zz;
    xz = yx2 * zy - yy2 * zx;
    const len = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= len;
    xy /= len;
    xz /= len;
  }

  // Y軸 = Z × X
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  // column-major
  return [xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, ox, oy, oz, 1];
}

/**
 * IFCCARTESIANPOINT を解決
 */
function resolveCartesianPoint(api, modelID, ref) {
  if (!ref) return { x: 0, y: 0, z: 0 };
  const id = ref.value ?? ref;
  const point = api.GetLine(modelID, id);
  if (!point || !point.Coordinates) return { x: 0, y: 0, z: 0 };
  const coords = point.Coordinates;
  return {
    x: coords[0]?.value ?? coords[0] ?? 0,
    y: coords[1]?.value ?? coords[1] ?? 0,
    z: coords[2]?.value ?? coords[2] ?? 0,
  };
}

/**
 * IFCDIRECTION を解決
 */
function resolveDirection(api, modelID, ref) {
  if (!ref) return { x: 0, y: 0, z: 1 };
  const id = ref.value ?? ref;
  const dir = api.GetLine(modelID, id);
  if (!dir || !dir.DirectionRatios) return { x: 0, y: 0, z: 1 };
  const ratios = dir.DirectionRatios;
  return {
    x: ratios[0]?.value ?? ratios[0] ?? 0,
    y: ratios[1]?.value ?? ratios[1] ?? 0,
    z: ratios[2]?.value ?? ratios[2] ?? 0,
  };
}

function normalizeDirection(direction) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new Error('IFC mapping target contains an invalid direction');
  }
  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}

function resolveMappingDirection(api, modelID, directionRef) {
  const directionId = directionRef?.value ?? directionRef;
  const direction = directionId ? api.GetLine(modelID, directionId) : null;
  if (!direction?.DirectionRatios) {
    throw new Error('IFC mapping target contains an invalid direction reference');
  }
  return normalizeDirection({
    x: direction.DirectionRatios[0]?.value ?? direction.DirectionRatios[0] ?? 0,
    y: direction.DirectionRatios[1]?.value ?? direction.DirectionRatios[1] ?? 0,
    z: direction.DirectionRatios[2]?.value ?? direction.DirectionRatios[2] ?? 0,
  });
}

function getNumericValue(value, fallback) {
  const numericValue = value?.value ?? value;
  return numericValue === undefined || numericValue === null ? fallback : numericValue;
}

/**
 * GetFlatMesh の変換行列からワールド座標の始点・終点を抽出
 * web-ifcの GetFlatMesh はすでにワールド変換済みなので、
 * その行列とローカルBBoxから始点・終点を推定
 *
 * @param {number[]} flatTransformation - 16要素の行列
 * @param {{min: Object, max: Object}} localBBox - ローカルバウンディングボックス
 * @param {number} unitFactor - mm変換係数
 * @returns {{start: Object, end: Object}} mm座標の始点・終点
 */
export function extractEndpoints(flatTransformation, localBBox, unitFactor) {
  const m = flatTransformation;

  // ローカル座標系でのバウンディングボックス中心
  const cx = (localBBox.min.x + localBBox.max.x) / 2;
  const cy = (localBBox.min.y + localBBox.max.y) / 2;

  // 押出方向はZ軸と仮定（IFCの一般的な表現）
  const startLocal = { x: cx, y: cy, z: localBBox.min.z };
  const endLocal = { x: cx, y: cy, z: localBBox.max.z };

  const start = transformPoint(startLocal, m);
  const end = transformPoint(endLocal, m);

  return {
    start: {
      x: Math.round(start.x * unitFactor * 100) / 100,
      y: Math.round(start.y * unitFactor * 100) / 100,
      z: Math.round(start.z * unitFactor * 100) / 100,
    },
    end: {
      x: Math.round(end.x * unitFactor * 100) / 100,
      y: Math.round(end.y * unitFactor * 100) / 100,
      z: Math.round(end.z * unitFactor * 100) / 100,
    },
  };
}
