import { multiplyAffine, transformPoint } from '../../data/drawing/affine2d.js';

function positiveScaleDenominator(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1)
    throw new RangeError('縮尺分母は1以上の有限値にしてください。');
  return number;
}

/**
 * 現在の画面上の model→CSS 変換を、PDF user-space を正本とする手動配置へ固定する。
 * これによりPDF表示倍率(view zoom)が変わっても同じ配置を再現できる。
 */
export function createManualPlacementFromDisplay({ modelToCss, cssToPdf, scaleDenominator } = {}) {
  return Object.freeze({
    mode: 'manual',
    scaleDenominator: positiveScaleDenominator(scaleDenominator),
    matrix: Object.freeze([...multiplyAffine(cssToPdf, modelToCss)]),
  });
}

/** ギズモのCSS移動をPDF user-spaceの手動配置へ確定する。 */
export function translateManualPlacementFromDisplay({
  modelToCss,
  cssToPdf,
  dx,
  dy,
  scaleDenominator,
} = {}) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy))
    throw new TypeError('表示位置の移動量には有限値が必要です。');
  const movedModelToCss = multiplyAffine([1, 0, 0, 1, dx, dy], modelToCss);
  return createManualPlacementFromDisplay({
    modelToCss: movedModelToCss,
    cssToPdf,
    scaleDenominator,
  });
}

/**
 * 手動配置の縮尺だけを変更し、指定したSTB座標のPDF上の位置は固定する。
 * scaleDenominatorが大きくなるほど図形は小さくなる。
 */
export function rescaleManualPlacement(placement, nextScaleDenominator, modelAnchor) {
  if (placement?.mode !== 'manual' || !Array.isArray(placement.matrix))
    throw new TypeError('手動配置が必要です。');
  if (
    !Array.isArray(modelAnchor) ||
    modelAnchor.length !== 2 ||
    !modelAnchor.every(Number.isFinite)
  )
    throw new TypeError('縮尺変更の基準点には有限の座標2個が必要です。');
  const previous = positiveScaleDenominator(placement.scaleDenominator);
  const next = positiveScaleDenominator(nextScaleDenominator);
  if (previous === next) return placement;
  const factor = previous / next;
  const [a, b, c, d] = placement.matrix;
  const fixed = transformPoint(placement.matrix, modelAnchor);
  const na = a * factor;
  const nb = b * factor;
  const nc = c * factor;
  const nd = d * factor;
  const [x, y] = modelAnchor;
  return Object.freeze({
    mode: 'manual',
    scaleDenominator: next,
    matrix: Object.freeze([na, nb, nc, nd, fixed[0] - na * x - nc * y, fixed[1] - nb * x - nd * y]),
  });
}
