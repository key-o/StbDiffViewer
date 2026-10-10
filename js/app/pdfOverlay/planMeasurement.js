/** @fileoverview PDF/STB平面図上の寸法測定用2Dスナップ・投影計算。 */
import { invertAffine, transformPoint } from '../../data/drawing/affine2d.js';

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

function distance2d(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function ccwAngleDelta(from, to) {
  const full = Math.PI * 2;
  let delta = (to - from) % full;
  if (delta < 0) delta += full;
  return delta;
}

function angleOnCircularArc(angle, startAngle, endAngle, clockwise) {
  const tolerance = 1e-10;
  const sweep = clockwise
    ? ccwAngleDelta(endAngle, startAngle)
    : ccwAngleDelta(startAngle, endAngle);
  if (sweep <= tolerance) return false;
  const progress = clockwise ? ccwAngleDelta(angle, startAngle) : ccwAngleDelta(startAngle, angle);
  return progress <= sweep + tolerance;
}

function tangentPreviewSegment(point, tangent, radius) {
  const halfLength = Math.max(10, Math.min(100, Number(radius) * 0.5));
  return {
    start: [point[0] - tangent[0] * halfLength, point[1] - tangent[1] * halfLength],
    end: [point[0] + tangent[0] * halfLength, point[1] + tangent[1] * halfLength],
  };
}

function nearestPointOnCircularGeometry({
  modelPoint,
  center,
  radius,
  startPoint = null,
  endPoint = null,
  clockwise = false,
  parallelToTangent = null,
  modelToCss = null,
  cssPoint = null,
  tolerancePx = 14,
} = {}) {
  if (![modelPoint, center].every(finitePoint) || !(Number.isFinite(radius) && radius > EPSILON))
    return null;

  const radialVector = [modelPoint[0] - center[0], modelPoint[1] - center[1]];
  let radial = normalize(radialVector);
  if (!radial) {
    if (finitePoint(startPoint))
      radial = normalize([startPoint[0] - center[0], startPoint[1] - center[1]]);
    if (!radial) radial = [1, 0];
  }

  const parallel = parallelToTangent && normalize(parallelToTangent);
  if (parallel) {
    const candidates = [
      [-parallel[1], parallel[0]],
      [parallel[1], -parallel[0]],
    ]
      .map((direction) => ({
        direction,
        point: [center[0] + direction[0] * radius, center[1] + direction[1] * radius],
      }))
      .filter(({ point }) => {
        if (
          finitePoint(startPoint) &&
          finitePoint(endPoint) &&
          !angleOnCircularArc(
            Math.atan2(point[1] - center[1], point[0] - center[0]),
            Math.atan2(startPoint[1] - center[1], startPoint[0] - center[0]),
            Math.atan2(endPoint[1] - center[1], endPoint[0] - center[0]),
            clockwise,
          )
        )
          return false;
        return distance2d(transformPoint(modelToCss, point), cssPoint) <= tolerancePx;
      })
      .sort((a, b) => distance2d(a.point, modelPoint) - distance2d(b.point, modelPoint));
    // Keep exact tangency; do not relax the parallel test for oblique lines.
    if (candidates.length) radial = candidates[0].direction;
  }

  let point = [center[0] + radial[0] * radius, center[1] + radial[1] * radius];
  if (finitePoint(startPoint) && finitePoint(endPoint)) {
    const angle = Math.atan2(point[1] - center[1], point[0] - center[0]);
    const startAngle = Math.atan2(startPoint[1] - center[1], startPoint[0] - center[0]);
    const endAngle = Math.atan2(endPoint[1] - center[1], endPoint[0] - center[0]);
    if (!angleOnCircularArc(angle, startAngle, endAngle, clockwise)) {
      point =
        distance2d(modelPoint, startPoint) <= distance2d(modelPoint, endPoint)
          ? [...startPoint]
          : [...endPoint];
      radial = normalize([point[0] - center[0], point[1] - center[1]]);
      if (!radial) return null;
    }
  }

  const tangent = clockwise ? [radial[1], -radial[0]] : [-radial[1], radial[0]];
  const segment = tangentPreviewSegment(point, tangent, radius);
  return {
    point,
    tangent,
    normal: [-tangent[1], tangent[0]],
    segment,
  };
}

function bulgeArcGeometry(start, end, bulge) {
  if (![start, end].every(finitePoint) || !Number.isFinite(bulge) || Math.abs(bulge) <= EPSILON)
    return null;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const chord = Math.hypot(dx, dy);
  if (!(chord > EPSILON)) return null;

  const sweep = 4 * Math.atan(bulge);
  const sineHalf = Math.sin(Math.abs(sweep) / 2);
  const tangentHalf = Math.tan(sweep / 2);
  if (Math.abs(sineHalf) <= EPSILON || Math.abs(tangentHalf) <= EPSILON) return null;

  const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const left = [-dy / chord, dx / chord];
  const centerOffset = chord / (2 * tangentHalf);
  const center = [midpoint[0] + left[0] * centerOffset, midpoint[1] + left[1] * centerOffset];
  const radius = chord / (2 * sineHalf);
  return { center, radius, clockwise: sweep < 0 };
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
 * ReferenceDrawingのLINE / polyline / bulge / ARC / CIRCLEから、
 * 画面クリックに最も近い図形点と局所接線を取得する。
 *
 * 曲線はクリック位置の局所接線をsegmentとして返すため、
 * 寸法測定では「平行な接線間の直交距離」として扱う。
 * parallelToTangent指定時は、画面許容距離内にある厳密な平行接点を優先する。
 */
export function findNearestReferenceDrawingSegment({
  referenceDrawings = [],
  referenceDisplaySettings = {},
  modelToCss,
  cssPoint,
  tolerancePx = 14,
  parallelToTangent = null,
} = {}) {
  if (!Array.isArray(referenceDrawings))
    throw new TypeError('ReferenceDrawing一覧は配列で指定してください。');
  if (!finitePoint(cssPoint)) throw new TypeError('クリック座標が不正です。');
  if (!Number.isFinite(tolerancePx) || tolerancePx <= 0)
    throw new RangeError('スナップ許容距離が不正です。');
  if (
    parallelToTangent != null &&
    (!finitePoint(parallelToTangent) || !normalize(parallelToTangent))
  )
    throw new TypeError('平行接線の方向が不正です。');

  const cssToModel = invertAffine(modelToCss);
  const modelPoint = transformPoint(cssToModel, cssPoint);
  const curveSnap = { parallelToTangent, modelToCss, cssPoint, tolerancePx };
  let best = null;

  const consider = ({
    referenceDrawing,
    primitive,
    index,
    geometryKind,
    point,
    tangent,
    normal,
    segment,
  }) => {
    if (![point, tangent, normal, segment?.start, segment?.end].every(finitePoint)) return;
    const pointCss = transformPoint(modelToCss, point);
    const cssDistance = distance2d(cssPoint, pointCss);
    if (cssDistance > tolerancePx) return;
    if (best && cssDistance >= best.cssDistance) return;

    best = {
      elementKey: JSON.stringify([
        'dxf',
        referenceDrawing.source.documentId,
        primitive.sourceRef?.entityId || primitive.id,
        geometryKind,
        index,
      ]),
      ref: { ...primitive.sourceRef },
      mark: referenceDrawing.source.filename || referenceDrawing.source.documentId,
      point: [...point],
      tangent: [...tangent],
      normal: [...normal],
      segment: {
        start: [...segment.start],
        end: [...segment.end],
        index,
      },
      cssDistance,
      sourceKind: 'dxf',
      geometryKind,
      referenceDocumentId: referenceDrawing.source.documentId,
      referencePrimitiveId: primitive.id,
    };
  };

  for (const referenceDrawing of referenceDrawings) {
    if (referenceDrawing?.kind !== 'ReferenceDrawing' || referenceDrawing.units !== 'mm') continue;
    const documentId = referenceDrawing.source?.documentId;
    const displaySettings = documentId ? referenceDisplaySettings?.[documentId] || {} : {};
    if (displaySettings.visible === false) continue;
    const displayOpacity = Number(displaySettings.opacity);
    if (Number.isFinite(displayOpacity) && displayOpacity <= 0) continue;
    const sourceLayers = new Map(
      (referenceDrawing.layers || []).map((layer) => [String(layer.id), layer]),
    );

    for (const primitive of referenceDrawing.primitives || []) {
      const layerId = String(primitive.layerId || primitive.sourceRef?.layer || '0');
      const sourceLayer = sourceLayers.get(layerId);
      if (sourceLayer?.visible === false || sourceLayer?.frozen === true) continue;
      if (displaySettings.layers?.[layerId] === false) continue;

      if (primitive.kind === 'line' || primitive.kind === 'polyline') {
        const points = primitive.points;
        const closed = primitive.kind === 'polyline' && primitive.closed === true;
        const bulges =
          primitive.kind === 'polyline'
            ? primitive.bulges || points?.map(() => 0)
            : points?.map(() => 0);
        if (!Array.isArray(points) || points.length < 2) continue;

        const segmentCount = closed ? points.length : points.length - 1;
        for (let index = 0; index < segmentCount; index++) {
          const start = points[index];
          const end = points[(index + 1) % points.length];
          if (![start, end].every(finitePoint)) continue;
          const bulge = Number(bulges?.[index] || 0);

          if (Math.abs(bulge) > EPSILON) {
            const arc = bulgeArcGeometry(start, end, bulge);
            if (!arc) continue;
            const curved = nearestPointOnCircularGeometry({
              ...curveSnap,
              modelPoint,
              center: arc.center,
              radius: arc.radius,
              startPoint: start,
              endPoint: end,
              clockwise: arc.clockwise,
            });
            if (!curved) continue;
            consider({
              referenceDrawing,
              primitive,
              index,
              geometryKind: 'bulge',
              ...curved,
            });
            continue;
          }

          const tangent = normalize([end[0] - start[0], end[1] - start[1]]);
          if (!tangent) continue;
          const startCss = transformPoint(modelToCss, start);
          const endCss = transformPoint(modelToCss, end);
          const closestCss = closestPointOnSegment2d(cssPoint, startCss, endCss);
          if (!closestCss) continue;
          const t = closestCss.t;
          const point = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
          consider({
            referenceDrawing,
            primitive,
            index,
            geometryKind: primitive.kind,
            point,
            tangent,
            normal: [-tangent[1], tangent[0]],
            segment: { start, end },
          });
        }
        continue;
      }

      if (primitive.kind === 'circle') {
        const curved = nearestPointOnCircularGeometry({
          ...curveSnap,
          modelPoint,
          center: primitive.center,
          radius: Number(primitive.radius),
        });
        if (!curved) continue;
        consider({
          referenceDrawing,
          primitive,
          index: 0,
          geometryKind: 'circle',
          ...curved,
        });
        continue;
      }

      if (primitive.kind === 'arc') {
        const curved = nearestPointOnCircularGeometry({
          ...curveSnap,
          modelPoint,
          center: primitive.center,
          radius: Number(primitive.radius),
          startPoint: primitive.startPoint,
          endPoint: primitive.endPoint,
          clockwise: primitive.clockwise === true,
        });
        if (!curved) continue;
        consider({
          referenceDrawing,
          primitive,
          index: 0,
          geometryKind: 'arc',
          ...curved,
        });
      }
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

  // 直線は線分始点、曲線はsnap点の局所接線上の代表点を使う。
  // これにより直線はクリック位置に依存せず、曲線は局所接線間の距離として評価できる。
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
