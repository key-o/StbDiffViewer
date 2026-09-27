/** @fileoverview PDF/STB平面図上の寸法測定用2Dスナップ・投影計算。 */
import { transformPoint } from '../../data/drawing/affine2d.js';

const EPSILON = 1e-9;

function finitePoint(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  if (!(length > EPSILON)) return null;
  return [vector[0] / length, vector[1] / length];
}

function cross2d(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

/**
 * 2方向が数値誤差の範囲で平行（逆向きを含む）か判定する。
 * DrawingModel座標から得た線分方向なので、画面上の角度許容は持たせない。
 */
export function areParallelDirections(firstTangent, secondTangent, { crossTolerance = 1e-8 } = {}) {
  if (!finitePoint(firstTangent) || !finitePoint(secondTangent))
    throw new TypeError('線分方向が不正です。');
  if (!Number.isFinite(crossTolerance) || crossTolerance < 0 || crossTolerance >= 1)
    throw new RangeError('平行判定許容値が不正です。');

  const first = normalize(firstTangent);
  const second = normalize(secondTangent);
  if (!first || !second) throw new TypeError('線分方向が不正です。');

  return Math.abs(cross2d(first, second)) <= crossTolerance;
}

/**
 * 2D線分上の最近傍点を返す。
 * @returns {{point:number[], t:number, distance:number}|null}
 */
export function closestPointOnSegment2d(point, start, end) {
  if (![point, start, end].every(finitePoint)) throw new TypeError('2D点が不正です。');
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > EPSILON)) return null;
  const rawT = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, rawT));
  const snapped = [start[0] + dx * t, start[1] + dy * t];
  return {
    point: snapped,
    t,
    distance: Math.hypot(point[0] - snapped[0], point[1] - snapped[1]),
  };
}

/**
 * DrawingModelの部材輪郭線から、画面クリックに最も近い線分を取得する。
 * スナップ点・法線はDrawingModel座標(mm)で返す。
 */
export function findNearestDrawingSegment({
  drawing,
  modelToCss,
  cssPoint,
  tolerancePx = 14,
} = {}) {
  if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm')
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  if (!finitePoint(cssPoint)) throw new TypeError('クリック座標が不正です。');
  if (!Number.isFinite(tolerancePx) || tolerancePx <= 0)
    throw new RangeError('スナップ許容距離が不正です。');

  const records = new Map((drawing.elements || []).map((record) => [record.key, record]));
  let best = null;

  for (const primitive of drawing.primitives || []) {
    if (
      primitive?.kind !== 'polyline' ||
      !Array.isArray(primitive.points) ||
      primitive.points.length < 2
    )
      continue;

    const record = records.get(primitive.elementKey);
    if (!record || record.state !== 'drawn') continue;

    const segments = [];
    for (let index = 0; index < primitive.points.length - 1; index++)
      segments.push([primitive.points[index], primitive.points[index + 1], index]);
    if (primitive.closed && primitive.points.length > 2)
      segments.push([
        primitive.points[primitive.points.length - 1],
        primitive.points[0],
        primitive.points.length - 1,
      ]);

    for (const [start, end, segmentIndex] of segments) {
      if (![start, end].every(finitePoint)) continue;
      const tangent = normalize([end[0] - start[0], end[1] - start[1]]);
      if (!tangent) continue;

      const startCss = transformPoint(modelToCss, start);
      const endCss = transformPoint(modelToCss, end);
      const closestCss = closestPointOnSegment2d(cssPoint, startCss, endCss);
      if (!closestCss || closestCss.distance > tolerancePx) continue;
      if (best && closestCss.distance >= best.cssDistance) continue;

      const t = closestCss.t;
      const modelPoint = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
      best = {
        elementKey: record.key,
        ref: { ...record.ref },
        mark: record.mark || '',
        point: modelPoint,
        tangent,
        normal: [-tangent[1], tangent[0]],
        segment: {
          start: [...start],
          end: [...end],
          index: segmentIndex,
        },
        cssDistance: closestCss.distance,
      };
    }
  }
  return best;
}

/**
 * 第1線分の法線と第2線分の直線との交点から、平行線間の直交距離を作る。
 * 第2線のクリック位置には依存せず、非平行線は確定対象にしない。
 */
export function createProjectedPlanMeasurement(
  first,
  second,
  { minDistanceMm = 1, parallelTolerance = 1e-8 } = {},
) {
  if (
    !finitePoint(first?.point) ||
    !finitePoint(second?.point) ||
    !finitePoint(first?.normal) ||
    !finitePoint(first?.tangent) ||
    !finitePoint(second?.tangent)
  )
    throw new TypeError('測定点・法線または線分方向が不正です。');
  if (!Number.isFinite(minDistanceMm) || minDistanceMm < 0)
    throw new RangeError('最小測定距離が不正です。');
  if (
    !areParallelDirections(first.tangent, second.tangent, {
      crossTolerance: parallelTolerance,
    })
  )
    return null;

  const normal = normalize(first.normal);
  const secondTangent = normalize(second.tangent);
  if (!normal || !secondTangent) throw new TypeError('線分方向が不正です。');

  // 第2線のクリック位置ではなく線分始点を直線上の代表点に使う。
  // これにより同じ線上のどこをクリックしても算定値が変わらない。
  const secondLinePoint = finitePoint(second?.segment?.start) ? second.segment.start : second.point;
  const offset = [secondLinePoint[0] - first.point[0], secondLinePoint[1] - first.point[1]];
  const denominator = cross2d(normal, secondTangent);
  if (Math.abs(denominator) <= EPSILON) return null;

  const signedDistance = cross2d(offset, secondTangent) / denominator;
  const distance = Math.abs(signedDistance);
  if (distance < minDistanceMm) return null;

  const p2 = [
    first.point[0] + normal[0] * signedDistance,
    first.point[1] + normal[1] * signedDistance,
  ];

  return {
    p1: [...first.point],
    p2,
    secondPick: [...second.point],
    normal,
    distance,
    sign: signedDistance < 0 ? -1 : 1,
    firstElementKey: first.elementKey,
    secondElementKey: second.elementKey,
  };
}
