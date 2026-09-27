/** @fileoverview PDF/STB位置合わせ用の2Dギズモ起点候補。STB原本を変更しない。 */

const COORDINATE_TOLERANCE_MM = 0.1;
const GEOMETRY_EPSILON = 1e-8;

function finitePoint(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
}

function finiteAttribute(element, attribute) {
  const rawValue = element?.getAttribute?.(attribute);
  if (rawValue === null || rawValue === undefined || rawValue.trim() === '') return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function elementsByLocalName(document, localName) {
  return [...document.getElementsByTagName('*')].filter(
    (element) => (element.localName || element.tagName) === localName,
  );
}

function childElementsByLocalName(parent, localName) {
  return [...(parent?.childNodes || [])].filter(
    (element) => element.nodeType === 1 && (element.localName || element.tagName) === localName,
  );
}

function pointKey(point) {
  return `${Math.round(point[0] / COORDINATE_TOLERANCE_MM)}:${Math.round(
    point[1] / COORDINATE_TOLERANCE_MM,
  )}`;
}

function pushUnique(map, candidate) {
  if (!finitePoint(candidate.point)) return;
  // Deduplicate only within a candidate type. An STB node can share coordinates with a
  // real axis intersection without inheriting that intersection's provenance.
  const key = `${candidate.type}:${pointKey(candidate.point)}`;
  if (!map.has(key)) map.set(key, Object.freeze(candidate));
}

function axisIdentity(element, kind, groupName, index) {
  const id = element.getAttribute('id');
  const name = element.getAttribute('name');
  const identity = id || name || `${kind}-${index}`;
  return {
    id: `${kind}:${groupName || ''}:${identity}:${index}`,
    name: name || `${kind} ${identity}`,
  };
}

function readArcRange(element) {
  const startRaw = element.getAttribute('start_angle');
  const endRaw = element.getAttribute('end_angle');
  if (startRaw === null && endRaw === null) {
    return { fullCircle: true, startAngle: null, endAngle: null };
  }
  if (startRaw === null || endRaw === null) return null;
  const startAngle = finiteAttribute(element, 'start_angle');
  const endAngle = finiteAttribute(element, 'end_angle');
  if (startAngle === null || endAngle === null) return null;
  return { fullCircle: false, startAngle, endAngle };
}

function readParallelAxes(group, result, indexRef) {
  const originX = finiteAttribute(group, 'X');
  const originY = finiteAttribute(group, 'Y');
  const angle = finiteAttribute(group, 'angle');
  if (originX === null || originY === null || angle === null) return;

  const radians = (angle * Math.PI) / 180;
  const normalRadians = radians + Math.PI / 2;
  for (const element of childElementsByLocalName(group, 'StbParallelAxis')) {
    const distance = finiteAttribute(element, 'distance');
    if (distance === null) continue;
    const identity = axisIdentity(
      element,
      'parallel',
      group.getAttribute('group_name'),
      indexRef.value++,
    );
    result.push({
      ...identity,
      shape: 'line',
      point: [
        originX + distance * Math.cos(normalRadians),
        originY + distance * Math.sin(normalRadians),
      ],
      direction: [Math.cos(radians), Math.sin(radians)],
      minParameter: -Infinity,
      maxParameter: Infinity,
    });
  }
}

function readRadialAxes(group, result, indexRef) {
  const originX = finiteAttribute(group, 'X');
  const originY = finiteAttribute(group, 'Y');
  if (originX === null || originY === null) return;

  for (const element of childElementsByLocalName(group, 'StbRadialAxis')) {
    const angle = finiteAttribute(element, 'angle');
    if (angle === null) continue;
    const identity = axisIdentity(
      element,
      'radial',
      group.getAttribute('group_name'),
      indexRef.value++,
    );
    const radians = (angle * Math.PI) / 180;
    result.push({
      ...identity,
      shape: 'line',
      point: [originX, originY],
      direction: [Math.cos(radians), Math.sin(radians)],
      minParameter: 0,
      maxParameter: Infinity,
    });
  }
}

function readArcAxes(group, result, indexRef) {
  const centerX = finiteAttribute(group, 'X');
  const centerY = finiteAttribute(group, 'Y');
  const arcRange = readArcRange(group);
  if (centerX === null || centerY === null || !arcRange) return;

  for (const element of childElementsByLocalName(group, 'StbArcAxis')) {
    const radius = finiteAttribute(element, 'radius');
    if (radius === null || !(radius > 0)) continue;
    const identity = axisIdentity(
      element,
      'arc',
      group.getAttribute('group_name'),
      indexRef.value++,
    );
    result.push({
      ...identity,
      shape: 'arc',
      center: [centerX, centerY],
      radius,
      ...arcRange,
    });
  }
}

function readDrawingLineAxes(group, result, indexRef) {
  for (const element of childElementsByLocalName(group, 'StbDrawingLineAxis')) {
    const start = [finiteAttribute(element, 'start_X'), finiteAttribute(element, 'start_Y')];
    const end = [finiteAttribute(element, 'end_X'), finiteAttribute(element, 'end_Y')];
    if (![...start, ...end].every(Number.isFinite)) continue;
    const direction = [end[0] - start[0], end[1] - start[1]];
    if (Math.hypot(...direction) <= GEOMETRY_EPSILON) continue;
    const identity = axisIdentity(
      element,
      'drawingLine',
      element.getAttribute('group_name'),
      indexRef.value++,
    );
    result.push({
      ...identity,
      shape: 'line',
      point: start,
      direction,
      minParameter: 0,
      maxParameter: 1,
    });
  }
}

function readDrawingArcAxes(group, result, indexRef) {
  for (const element of childElementsByLocalName(group, 'StbDrawingArcAxis')) {
    const centerX = finiteAttribute(element, 'X');
    const centerY = finiteAttribute(element, 'Y');
    const radius = finiteAttribute(element, 'radius');
    const arcRange = readArcRange(element);
    if ([centerX, centerY, radius].some((value) => value === null) || !arcRange || !(radius > 0)) {
      continue;
    }
    const identity = axisIdentity(
      element,
      'drawingArc',
      element.getAttribute('group_name'),
      indexRef.value++,
    );
    result.push({
      ...identity,
      shape: 'arc',
      center: [centerX, centerY],
      radius,
      ...arcRange,
    });
  }
}

function collectGridAxes(document) {
  const axes = [];
  const indexRef = { value: 0 };

  for (const axesElement of elementsByLocalName(document, 'StbAxes')) {
    for (const group of childElementsByLocalName(axesElement, 'StbParallelAxes')) {
      readParallelAxes(group, axes, indexRef);
    }
    for (const group of childElementsByLocalName(axesElement, 'StbArcAxes')) {
      readArcAxes(group, axes, indexRef);
    }
    for (const group of childElementsByLocalName(axesElement, 'StbRadialAxes')) {
      readRadialAxes(group, axes, indexRef);
    }
    for (const group of childElementsByLocalName(axesElement, 'StbDrawingAxes')) {
      readDrawingLineAxes(group, axes, indexRef);
      readDrawingArcAxes(group, axes, indexRef);
    }
  }

  return axes;
}

function cross(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function addScaled(point, direction, scale) {
  return [point[0] + direction[0] * scale, point[1] + direction[1] * scale];
}

function parameterIsAllowed(axis, parameter) {
  return (
    parameter >= axis.minParameter - GEOMETRY_EPSILON &&
    parameter <= axis.maxParameter + GEOMETRY_EPSILON
  );
}

function normalizeDegrees(angle) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function angleIsWithinArc(angle, startAngle, endAngle) {
  if (startAngle === null && endAngle === null) return true;
  if (Math.abs(endAngle - startAngle) >= 360 - GEOMETRY_EPSILON) return true;
  const sweep = endAngle - startAngle;
  const distance =
    sweep >= 0 ? normalizeDegrees(angle - startAngle) : normalizeDegrees(startAngle - angle);
  return distance <= Math.abs(sweep) + GEOMETRY_EPSILON;
}

function pointIsOnArc(point, arc) {
  const angle = (Math.atan2(point[1] - arc.center[1], point[0] - arc.center[0]) * 180) / Math.PI;
  return angleIsWithinArc(angle, arc.startAngle, arc.endAngle);
}

function lineLineIntersections(first, second) {
  const denominator = cross(first.direction, second.direction);
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) return [];
  const difference = subtract(second.point, first.point);
  const firstParameter = cross(difference, second.direction) / denominator;
  const secondParameter = cross(difference, first.direction) / denominator;
  if (!parameterIsAllowed(first, firstParameter) || !parameterIsAllowed(second, secondParameter)) {
    return [];
  }
  return [addScaled(first.point, first.direction, firstParameter)];
}

function lineArcIntersections(line, arc) {
  const directionLengthSquared = line.direction[0] ** 2 + line.direction[1] ** 2;
  if (!(directionLengthSquared > GEOMETRY_EPSILON)) return [];
  const toCenter = subtract(arc.center, line.point);
  const centerParameter =
    (toCenter[0] * line.direction[0] + toCenter[1] * line.direction[1]) / directionLengthSquared;
  const closestPoint = addScaled(line.point, line.direction, centerParameter);
  const offsetFromCenter = subtract(closestPoint, arc.center);
  const remainingRadiusSquared =
    arc.radius ** 2 - (offsetFromCenter[0] ** 2 + offsetFromCenter[1] ** 2);
  if (remainingRadiusSquared < -GEOMETRY_EPSILON) return [];

  const offsetParameter = Math.sqrt(Math.max(0, remainingRadiusSquared) / directionLengthSquared);
  const parameters =
    offsetParameter <= GEOMETRY_EPSILON
      ? [centerParameter]
      : [centerParameter - offsetParameter, centerParameter + offsetParameter];
  return parameters
    .filter(parameterIsAllowed.bind(null, line))
    .map((parameter) => addScaled(line.point, line.direction, parameter))
    .filter((point) => pointIsOnArc(point, arc));
}

function arcArcIntersections(first, second) {
  const centersDelta = subtract(second.center, first.center);
  const centerDistance = Math.hypot(...centersDelta);
  if (centerDistance <= GEOMETRY_EPSILON) return [];
  if (
    centerDistance > first.radius + second.radius + GEOMETRY_EPSILON ||
    centerDistance < Math.abs(first.radius - second.radius) - GEOMETRY_EPSILON
  ) {
    return [];
  }

  const along =
    (first.radius ** 2 - second.radius ** 2 + centerDistance ** 2) / (2 * centerDistance);
  const heightSquared = first.radius ** 2 - along ** 2;
  if (heightSquared < -GEOMETRY_EPSILON) return [];
  const unit = [centersDelta[0] / centerDistance, centersDelta[1] / centerDistance];
  const base = addScaled(first.center, unit, along);
  const height = Math.sqrt(Math.max(0, heightSquared));
  const offsets = height <= GEOMETRY_EPSILON ? [0] : [-height, height];
  return offsets
    .map((offset) => [base[0] - unit[1] * offset, base[1] + unit[0] * offset])
    .filter((point) => pointIsOnArc(point, first) && pointIsOnArc(point, second));
}

function intersectAxes(first, second) {
  if (first.shape === 'line' && second.shape === 'line') {
    return lineLineIntersections(first, second);
  }
  if (first.shape === 'line') return lineArcIntersections(first, second);
  if (second.shape === 'line') return lineArcIntersections(second, first);
  return arcArcIntersections(first, second);
}

function collectGridIntersectionCandidates(document, candidates) {
  const axes = collectGridAxes(document);
  for (let firstIndex = 0; firstIndex < axes.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < axes.length; secondIndex++) {
      const first = axes[firstIndex];
      const second = axes[secondIndex];
      const intersections = intersectAxes(first, second);
      for (const [intersectionIndex, point] of intersections.entries()) {
        pushUnique(candidates, {
          type: 'grid',
          point,
          id: `${first.id}&${second.id}:intersection-${intersectionIndex + 1}`,
          label: `通り交点 / ${first.name} × ${second.name}`,
        });
      }
    }
  }
}

export function collectAlignmentCandidates({ document, drawing } = {}) {
  if (document?.nodeType !== 9) throw new TypeError('STB Documentが必要です。');
  if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm')
    throw new TypeError('DrawingModel v1 (mm)が必要です。');

  const candidates = new Map();
  for (const node of elementsByLocalName(document, 'StbNode')) {
    const id = node.getAttribute('id');
    const point = [finiteAttribute(node, 'X'), finiteAttribute(node, 'Y')];
    if (!id || !finitePoint(point)) continue;
    const kind = node.getAttribute('kind') || '';
    pushUnique(candidates, {
      type: 'node',
      point,
      id,
      label: `${kind === 'ON_GRID' ? 'ON_GRID節点' : '節点'} / Node #${id}${kind ? ` / ${kind}` : ''}`,
    });
  }

  collectGridIntersectionCandidates(document, candidates);

  const elementPoints = new Map();
  for (const primitive of drawing.primitives || []) {
    if (!Array.isArray(primitive.points)) continue;
    const list = elementPoints.get(primitive.elementKey) || [];
    for (const point of primitive.points) {
      if (!finitePoint(point)) continue;
      list.push(point);
      pushUnique(candidates, {
        type: 'vertex',
        point: [...point],
        id: primitive.elementKey,
        label: '部材輪郭の交点',
      });
    }
    elementPoints.set(primitive.elementKey, list);
  }

  for (const [elementKey, points] of elementPoints) {
    if (!points.length) continue;
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const point = [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
    ];
    pushUnique(candidates, {
      type: 'center',
      point,
      id: elementKey,
      label: '部材中心',
    });
  }

  return Object.freeze([...candidates.values()]);
}

export function filterAlignmentCandidates(candidates, type = 'all') {
  if (!Array.isArray(candidates)) return [];
  if (type === 'all') return candidates;
  return candidates.filter((candidate) => candidate.type === type);
}
