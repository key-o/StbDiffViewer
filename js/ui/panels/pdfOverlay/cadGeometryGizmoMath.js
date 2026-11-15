/** @fileoverview CAD geometry gizmo: screen vectors -> STB model vectors (mm). */
/**
 * Affine transforms use [a, b, c, d, tx, ty].
 * X axis is model (a,b); Y axis is model (c,d), even when the sheet is rotated.
 */
export function cadGizmoAxisDirections(modelToCss) {
  if (!Array.isArray(modelToCss) || modelToCss.length !== 6 || !modelToCss.every(Number.isFinite)) {
    throw new TypeError('モデル座標変換が不正です。');
  }
  const [a, b, c, d] = modelToCss;
  if (Math.hypot(a, b) < 1e-12 || Math.hypot(c, d) < 1e-12)
    throw new RangeError('CADギズモの軸が退化しています。');
  return [
    [a, b],
    [c, d],
  ];
}

/** Account for zoom, scale, reflection and rotation; do not use px as mm. */
export function cadScreenDeltaToModelVector(modelToCss, screenDelta) {
  const [[a, b], [c, d]] = cadGizmoAxisDirections(modelToCss);
  const dx = Number(screenDelta?.dx);
  const dy = Number(screenDelta?.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('マウス移動量が不正です。');
  const determinant = a * d - b * c;
  const axisProduct = Math.hypot(a, b) * Math.hypot(c, d);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= axisProduct * 1e-10)
    throw new RangeError('CADギズモの座標変換を逆算できません。');
  // Round only sub-micrometre floating-point noise, not to the 1mm grid.
  const precision = (value) => Math.round(value * 1e6) / 1e6;
  return {
    x: precision((d * dx - c * dy) / determinant),
    y: precision((-b * dx + a * dy) / determinant),
    z: 0,
  };
}
