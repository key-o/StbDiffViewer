/** @fileoverview Canvas/SVG順序の2D変換。PDF viewportと登録変換を分離する。 */
export function assertPoint(point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
    throw new TypeError('座標には有限の数値2個が必要です。');
  }
  return point;
}

export function assertMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)) {
    throw new TypeError('変換行列には有限の数値6個が必要です。');
  }
  return matrix;
}

export function transformPoint(matrix, point) {
  const [a, b, c, d, e, f] = assertMatrix(matrix);
  const [x, y] = assertPoint(point);
  return assertPoint([a * x + c * y + e, b * x + d * y + f]);
}

/** rightを先に適用する。DPRはこの表示座標行列に混ぜない。 */
export function multiplyAffine(left, right) {
  const [a, b, c, d, e, f] = assertMatrix(left);
  const [g, h, i, j, k, l] = assertMatrix(right);
  return assertMatrix([
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ]);
}

export function invertAffine(matrix) {
  const [a, b, c, d, e, f] = assertMatrix(matrix);
  const size = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const det = a * d - b * c;
  if (!Number.isFinite(det) || size === 0 || Math.abs(det) <= size * size * 1e-12) {
    throw new RangeError('逆変換できない行列です。');
  }
  return assertMatrix([
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ]);
}

export function pointDistance(a, b) {
  assertPoint(a);
  assertPoint(b);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 向きを保存する相似変換のみ許可。PDF表示のY反転はviewport側の責務。 */
export function isDirectSimilarity(matrix) {
  try {
    assertMatrix(matrix);
    const scale = Math.hypot(matrix[0], matrix[1]);
    return (
      Number.isFinite(scale) &&
      scale > 0 &&
      Math.abs(matrix[2] + matrix[1]) <= scale * 1e-10 &&
      Math.abs(matrix[3] - matrix[0]) <= scale * 1e-10
    );
  } catch {
    return false;
  }
}

export function solveSimilarity(modelA, modelB, pdfA, pdfB) {
  [modelA, modelB, pdfA, pdfB].forEach(assertPoint);
  const modelLength = pointDistance(modelA, modelB);
  const pdfLength = pointDistance(pdfA, pdfB);
  if (
    !Number.isFinite(modelLength) ||
    !Number.isFinite(pdfLength) ||
    modelLength < 1e-6 ||
    pdfLength < 1e-9
  ) {
    throw new RangeError('異なる基準点A・Bを指定してください。');
  }
  const ux = (modelB[0] - modelA[0]) / modelLength;
  const uy = (modelB[1] - modelA[1]) / modelLength;
  const dx = (pdfB[0] - pdfA[0]) / modelLength;
  const dy = (pdfB[1] - pdfA[1]) / modelLength;
  const a = ux * dx + uy * dy;
  const b = ux * dy - uy * dx;
  const matrix = assertMatrix([
    a,
    b,
    -b,
    a,
    pdfA[0] - a * modelA[0] + b * modelA[1],
    pdfA[1] - b * modelA[0] - a * modelA[1],
  ]);
  if (!isDirectSimilarity(matrix)) throw new RangeError('相似変換を解けません。');
  return matrix;
}
