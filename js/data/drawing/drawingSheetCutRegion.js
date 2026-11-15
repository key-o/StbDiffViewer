/**
 * #565: Model-mm member clipping for persisted ViewSpecs. The derived
 * DrawingModel is shared by SVG, PDF and DXF. Convex polygons and connected
 * polylines are clipped; ambiguous concave cuts and crossing openings fail closed.
 */
export function normalizeCutBoundsMm(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('切り出し範囲はmodel-mmの矩形で指定してください。');
  const keys = Object.keys(value);
  if (keys.length !== 4 || !['minX', 'minY', 'maxX', 'maxY'].every((key) => keys.includes(key)))
    throw new TypeError('切り出し範囲はminX/minY/maxX/maxYのみ指定できます。');
  const { minX, minY, maxX, maxY } = value;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY)
    throw new RangeError('切り出し範囲のmm座標または大小関係が不正です。');
  return Object.freeze({ minX, minY, maxX, maxY });
}

const EPS = 1e-8;
const eq = (a, b) => Math.abs(a - b) <= EPS;
const same = (a, b) => eq(a[0], b[0]) && eq(a[1], b[1]);
const inside = ([x, y], b) =>
  x >= b.minX - EPS && x <= b.maxX + EPS && y >= b.minY - EPS && y <= b.maxY + EPS;
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function normalizePoints(input, closed) {
  if (
    !Array.isArray(input) ||
    input.length < 2 ||
    input.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
  )
    throw new TypeError('切り出し対象の図形座標が不正です。');
  const points = input.filter((p, i) => i === 0 || !same(p, input[i - 1]));
  if (closed && points.length > 2 && same(points[0], points.at(-1))) points.pop();
  if (points.length < (closed ? 3 : 2)) throw new Error('退化した部材外形は切り出せません。');
  return points;
}

function convex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const turn = cross(points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]);
    if (Math.abs(turn) <= EPS) continue;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  // A self-intersecting star may turn in one direction at every vertex.
  // Reject any nonadjacent intersecting edges before polygon clipping.
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j],
        d = points[(j + 1) % points.length];
      const t1 = cross(a, b, c),
        t2 = cross(a, b, d);
      const t3 = cross(c, d, a),
        t4 = cross(c, d, b);
      if (t1 * t2 < -EPS && t3 * t4 < -EPS) return false;
    }
  }
  return sign !== 0;
}

/** Sutherland-Hodgman rectangle clipping for convex closed member outlines. */
function clipPolygon(points, bounds) {
  const planes = [
    { axis: 0, edge: bounds.minX, direction: 1 },
    { axis: 0, edge: bounds.maxX, direction: -1 },
    { axis: 1, edge: bounds.minY, direction: 1 },
    { axis: 1, edge: bounds.maxY, direction: -1 },
  ];
  let current = points;
  for (const { axis, edge, direction } of planes) {
    if (!current.length) break;
    const next = [];
    const accepts = (point) => direction * (point[axis] - edge) >= -EPS;
    const intersect = (a, b) => {
      const d = b[axis] - a[axis];
      if (Math.abs(d) <= EPS) throw new Error('切り出し交点を一意に決定できません。');
      const t = Math.max(0, Math.min(1, (edge - a[axis]) / d));
      const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      p[axis] = edge;
      return p;
    };
    for (let i = 0; i < current.length; i++) {
      const a = current[(i + current.length - 1) % current.length];
      const b = current[i];
      const from = accepts(a),
        to = accepts(b);
      if (from !== to) next.push(intersect(a, b));
      if (to) next.push(b);
    }
    current = next.filter((p, i) => i === 0 || !same(p, next[i - 1]));
    if (current.length > 2 && same(current[0], current.at(-1))) current.pop();
  }
  if (current.length < 3) return null;
  const twiceArea = current.reduce((area, p, i) => {
    const q = current[(i + 1) % current.length];
    return area + p[0] * q[1] - q[0] * p[1];
  }, 0);
  return Math.abs(twiceArea) > EPS ? current : null;
}

/** Liang-Barsky segment clipping; a tangent alone is not a drawable segment. */
function clipSegment(a, z, bounds) {
  const dx = z[0] - a[0],
    dy = z[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - bounds.minX, bounds.maxX - a[0], a[1] - bounds.minY, bounds.maxY - a[1]];
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) <= EPS) {
      if (q[i] < -EPS) return null;
      continue;
    }
    const u = q[i] / p[i];
    if (p[i] < 0) lo = Math.max(lo, u);
    else hi = Math.min(hi, u);
    if (lo >= hi - EPS) return null;
  }
  return [
    [a[0] + lo * dx, a[1] + lo * dy],
    [a[0] + hi * dx, a[1] + hi * dy],
  ];
}

function clipOpen(points, bounds) {
  let result = [];
  for (let i = 1; i < points.length; i++) {
    const segment = clipSegment(points[i - 1], points[i], bounds);
    if (!segment) continue;
    if (!result.length) result = segment;
    else if (same(result.at(-1), segment[0])) result.push(segment[1]);
    else throw new Error('切り出しで線形部材が分断されます。');
  }
  return result.length < 2 ? null : result;
}

function cutPrimitive(primitive, bounds, record) {
  if (primitive?.kind !== 'polyline')
    throw new Error('切り出し未対応の部材図形です: ' + primitive?.kind);
  const closed = primitive.closed === true;
  const points = normalizePoints(primitive.points, closed);
  if (points.every((point) => inside(point, bounds))) return primitive;
  // A wholly disjoint figure cannot intersect the cut, irrespective of its
  // topology. In particular, remote openings and concave walls must not
  // invalidate an otherwise valid local view.
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  if (
    Math.max(...xs) < bounds.minX - EPS ||
    Math.min(...xs) > bounds.maxX + EPS ||
    Math.max(...ys) < bounds.minY - EPS ||
    Math.min(...ys) > bounds.maxY + EPS
  )
    return null;
  if (record.renderType === 'Open')
    throw new Error('開口を横断する切り出しは未対応です: ' + record.key);
  if (closed && !convex(points))
    throw new Error('凹形状・自己交差する部材の境界切り出しは未対応です: ' + record.key);
  const clipped = closed ? clipPolygon(points, bounds) : clipOpen(points, bounds);
  if (!clipped) return null;
  if (!clipped.every((point) => inside(point, bounds)))
    throw new Error('切り出し範囲外に幾何が残りました: ' + record.key);
  return Object.freeze({
    ...primitive,
    points: Object.freeze(clipped.map((point) => Object.freeze([...point]))),
  });
}

/**
 * Rebuild only grid annotations backed by the original STB semantic axis
 * references. The paper position is derived from the cropped geometry, never
 * from old screen coordinates. Non-grid annotations remain excluded.
 */
function localizedGridAnnotations(drawing, geometryBounds, cutBounds) {
  const source = drawing.annotations ?? [];
  const hasGrid = source.some((item) => item.role === 'grid');
  if (!hasGrid) return { annotations: [], dimensionReferences: [], dimensionIntents: [] };
  const references = (drawing.dimensionReferences ?? []).filter((reference) => {
    if (reference.kind !== 'axis' || !Number.isFinite(reference.coordinateValue)) return false;
    const min =
      reference.coordinateKey === 'x'
        ? cutBounds.minX
        : reference.coordinateKey === 'y'
          ? cutBounds.minY
          : NaN;
    const max =
      reference.coordinateKey === 'x'
        ? cutBounds.maxX
        : reference.coordinateKey === 'y'
          ? cutBounds.maxY
          : NaN;
    return reference.coordinateValue >= min - EPS && reference.coordinateValue <= max + EPS;
  });
  const elevations = drawing.view?.type === 'elevation';
  const annotations = [];
  for (const reference of references) {
    const { coordinateKey, coordinateValue: value, name } = reference;
    const axisId = String(reference.sourceRef?.elementId ?? reference.id);
    if (elevations) {
      if (coordinateKey !== 'x') continue;
      const bottom = geometryBounds.minY - 2400;
      const stemBottom = bottom + 650;
      const key = 'elevation-grid-' + (drawing.view.axisDirection === 'X' ? 'Y-' : 'X-') + axisId;
      annotations.push(
        {
          id: key + '-line',
          kind: 'line',
          role: 'grid',
          axisName: name,
          points: [
            [value, stemBottom],
            [value, geometryBounds.maxY + 1200],
          ],
        },
        {
          id: key + '-bubble-bottom',
          kind: 'circle',
          role: 'grid-bubble',
          axisName: name,
          center: [value, bottom],
          radius: 650,
        },
        {
          id: key + '-label-bottom',
          kind: 'text',
          role: 'grid-label',
          axisName: name,
          point: [value, bottom],
          anchor: 'middle',
          text: name,
        },
      );
    } else if (coordinateKey === 'x') {
      const bottom = geometryBounds.minY - 6700;
      annotations.push(
        {
          id: 'grid-x-' + axisId,
          kind: 'line',
          role: 'grid',
          axisName: name,
          points: [
            [value, bottom + 650],
            [value, geometryBounds.maxY + 2500],
          ],
        },
        {
          id: 'grid-x-bubble-' + axisId,
          kind: 'circle',
          role: 'grid-bubble',
          axisName: name,
          center: [value, bottom],
          radius: 650,
        },
        {
          id: 'grid-x-label-bottom-' + axisId,
          kind: 'text',
          role: 'grid-label',
          axisName: name,
          point: [value, bottom],
          anchor: 'middle',
          text: name,
        },
      );
    } else if (coordinateKey === 'y') {
      const left = geometryBounds.minX - 6700;
      annotations.push(
        {
          id: 'grid-y-' + axisId,
          kind: 'line',
          role: 'grid',
          axisName: name,
          points: [
            [left + 650, value],
            [geometryBounds.maxX + 2500, value],
          ],
        },
        {
          id: 'grid-y-bubble-' + axisId,
          kind: 'circle',
          role: 'grid-bubble',
          axisName: name,
          center: [left, value],
          radius: 650,
        },
        {
          id: 'grid-y-label-left-' + axisId,
          kind: 'text',
          role: 'grid-label',
          axisName: name,
          point: [left, value],
          anchor: 'middle',
          text: name,
        },
      );
    }
  }
  if (elevations) {
    for (const item of source) {
      if (item.role !== 'level-label' || !Array.isArray(item.point)) continue;
      const y = item.point[1];
      if (!Number.isFinite(y) || y < cutBounds.minY - EPS || y > cutBounds.maxY + EPS) continue;
      annotations.push({ ...item, point: [geometryBounds.minX, y] });
    }
  }
  const dimensionIntents = elevations
    ? []
    : (drawing.dimensionIntents ?? []).flatMap((intent) => {
        const match = /^dim:([xy]):(chain|overall)$/.exec(intent.id ?? '');
        if (!match) return [];
        const axes = references.filter((reference) => reference.coordinateKey === match[1]);
        if (axes.length < 2) return [];
        const selected = match[2] === 'overall' ? [axes[0], axes.at(-1)] : axes;
        return [
          {
            ...intent,
            references: selected.map((reference) => ({ kind: 'axis', axisId: reference.id })),
          },
        ];
      });
  return { annotations, dimensionReferences: references, dimensionIntents };
}

/** Clip once, leaving the source DrawingModel untouched for other views. */
export function cutDrawingModelToBounds(drawing, rawBounds) {
  const bounds = normalizeCutBoundsMm(rawBounds);
  if (!bounds) return drawing;
  if (
    drawing?.schemaVersion !== 1 ||
    drawing.units !== 'mm' ||
    !Array.isArray(drawing.primitives) ||
    !Array.isArray(drawing.elements)
  )
    throw new TypeError('切り出しにはDrawingModel v1の部材図形が必要です。');
  const records = new Map(drawing.elements.map((record) => [record.key, record]));
  const selection = new Map();
  const keptKeys = new Set();
  const primitives = [];
  const actual = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const primitive of drawing.primitives) {
    const record = records.get(primitive.elementKey);
    if (!record) throw new Error('切り出し部材の参照がありません: ' + primitive.elementKey);
    const clipped = cutPrimitive(primitive, bounds, record);
    const included = Boolean(clipped);
    if (selection.has(record.key) && selection.get(record.key) !== included)
      throw new Error('同一部材の外形が部分選択されています: ' + record.key);
    selection.set(record.key, included);
    if (!included) continue;
    primitives.push(clipped);
    keptKeys.add(record.key);
    for (const [x, y] of clipped.points) {
      actual.minX = Math.min(actual.minX, x);
      actual.minY = Math.min(actual.minY, y);
      actual.maxX = Math.max(actual.maxX, x);
      actual.maxY = Math.max(actual.maxY, y);
    }
  }
  if (!primitives.length || actual.maxX < actual.minX || actual.maxY < actual.minY)
    throw new Error('切り出し範囲内に表示可能な部材がありません。');
  // A valid horizontal/vertical open member may have a zero-height/width
  // geometry bbox. The sheet composer needs non-degenerate layout bounds:
  // use the explicitly persisted cut viewport only for the collapsed axis.
  const layoutBounds = {
    minX: actual.maxX > actual.minX ? actual.minX : bounds.minX,
    minY: actual.maxY > actual.minY ? actual.minY : bounds.minY,
    maxX: actual.maxX > actual.minX ? actual.maxX : bounds.maxX,
    maxY: actual.maxY > actual.minY ? actual.maxY : bounds.maxY,
  };
  for (const record of drawing.elements) {
    if (
      keptKeys.has(record.key) &&
      record.parentElementKey &&
      !keptKeys.has(record.parentElementKey)
    )
      throw new Error('親部材を含まない開口部などを切り出せません: ' + record.key);
  }
  const elements = drawing.elements.filter((record) => keptKeys.has(record.key));
  const localGrid = localizedGridAnnotations(drawing, actual, bounds);
  const primaries = elements.filter((record) => record.renderType !== 'Open');
  const coverage = drawing.coverage
    ? Object.freeze({
        ...drawing.coverage,
        sourceMembers: primaries.length,
        drawn: primaries.filter((record) => record.state === 'drawn').length,
        outsideView: 0,
        referenceOnly: primaries.filter((record) => record.state === 'reference-only').length,
        failed: primaries.filter((record) => record.state === 'failed').length,
        openingsDrawn: elements.filter(
          (record) => record.renderType === 'Open' && record.state === 'drawn',
        ).length,
      })
    : undefined;
  return Object.freeze({
    ...drawing,
    primitives: Object.freeze(primitives),
    elements: Object.freeze(elements),
    diagnostics: Object.freeze(
      (drawing.diagnostics ?? []).filter(
        (item) => !item.elementKey || keptKeys.has(item.elementKey),
      ),
    ),
    annotations: Object.freeze(localGrid.annotations),
    dimensionReferences: Object.freeze(localGrid.dimensionReferences),
    dimensionIntents: Object.freeze(localGrid.dimensionIntents),
    ...(coverage ? { coverage } : {}),
    bounds: Object.freeze(layoutBounds),
    cutBoundsMm: bounds,
  });
}
