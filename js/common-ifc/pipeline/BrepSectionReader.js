/**
 * Read geometrically *proven* rectangular IFC faceted BRep lofts with web-ifc.
 * No fake section material, steel profile, or STB switch semantics are inferred.
 * Returns explicit IFC-local axis endpoints in millimetres.
 */
import * as WebIFC from 'web-ifc';

const deref = (v) => v?.value ?? v;
const norm = (v) => Math.hypot(...v);
const minus = (a, b) => a.map((n, i) => n - b[i]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
const k = (p) => p.map((v) => Math.round(v * 1e5)).join('/');
const almost = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

export function readIfcRectangularBrepLoft(api, modelID, representationId, unitFactor = 1) {
  if (!Number.isFinite(unitFactor) || unitFactor <= 0) throw new Error('Invalid IFC length unit');
  const entity = (ref, type) => {
    const id = deref(ref);
    const result = api.GetLine(modelID, id);
    if (!result || (type != null && result.type !== type))
      throw new Error('Invalid IFC entity #' + id);
    return result;
  };
  const point = (ref) => {
    const p = entity(ref, WebIFC.IFCCARTESIANPOINT);
    const coords = p.Coordinates?.map((v) => Number(deref(v))) || [];
    if (![2, 3].includes(coords.length) || !coords.every(Number.isFinite))
      throw new Error('Invalid IFC Cartesian point');
    return [...coords, ...Array(3 - coords.length).fill(0)].map((v) => v * unitFactor);
  };
  const shape = entity(representationId, WebIFC.IFCPRODUCTDEFINITIONSHAPE);
  const reps = (shape.Representations || []).map((ref) =>
    entity(ref, WebIFC.IFCSHAPEREPRESENTATION),
  );
  const axisReps = reps.filter((r) => deref(r.RepresentationIdentifier) === 'Axis');
  const bodyReps = reps.filter(
    (r) => deref(r.RepresentationIdentifier) === 'Body' && deref(r.RepresentationType) === 'Brep',
  );
  if (axisReps.length !== 1 || bodyReps.length !== 1)
    throw new Error('Explicit single Axis and direct Brep Body required');
  if (axisReps[0].Items?.length !== 1 || bodyReps[0].Items?.length !== 1)
    throw new Error('Ambiguous IFC axis or BRep solids');
  const line = entity(axisReps[0].Items[0], WebIFC.IFCPOLYLINE);
  if (line.Points?.length !== 2) throw new Error('IFC Axis must be a 2-point polyline');
  const axisStart = point(line.Points[0]);
  const axisEnd = point(line.Points[1]);
  const delta = minus(axisEnd, axisStart);
  const axis = delta.findIndex((v) => Math.abs(v) > 1e-4);
  if (axis < 0 || delta.some((v, i) => i !== axis && Math.abs(v) > 1e-4))
    throw new Error('Non-axial IFC beam axis');
  const length = norm(delta);
  const direction = delta.map((v) => v / length);
  const brep = entity(bodyReps[0].Items[0], WebIFC.IFCFACETEDBREP);
  const shell = entity(brep.Outer, WebIFC.IFCCLOSEDSHELL);
  const faces = [];
  for (const faceRef of shell.CfsFaces || []) {
    const face = entity(faceRef, WebIFC.IFCFACE);
    if (face.Bounds?.length !== 1) throw new Error('Complex/holed BRep face');
    const bound = entity(face.Bounds[0], WebIFC.IFCFACEOUTERBOUND);
    const loop = entity(bound.Bound, WebIFC.IFCPOLYLOOP);
    let polygon = (loop.Polygon || []).map(point);
    if (polygon.length < 3 || new Set(polygon.map(k)).size !== polygon.length)
      throw new Error('Invalid BRep face polygon');
    if (bound.Orientation === false) polygon = polygon.reverse();
    if (typeof bound.Orientation !== 'boolean') throw new Error('Unknown BRep orientation');
    let normal;
    for (let i = 1; i < polygon.length - 1 && !normal; i++) {
      for (let j = i + 1; j < polygon.length; j++) {
        const n = cross(minus(polygon[i], polygon[0]), minus(polygon[j], polygon[0]));
        if (norm(n) > 1e-7) {
          normal = n;
          break;
        }
      }
    }
    if (!normal) throw new Error('Degenerate BRep face');
    for (const p of polygon) {
      if (Math.abs(dot(normal, minus(p, polygon[0]))) / norm(normal) > 1e-4)
        throw new Error('Nonplanar BRep face');
    }
    faces.push(polygon);
  }
  if (faces.length < 6) throw new Error('Insufficient BRep shell faces');
  const directedEdges = new Map();
  const anchor = faces[0][0];
  let signedVolume = 0;
  for (const polygon of faces) {
    for (let j = 0; j < polygon.length; j++) {
      const a = k(polygon[j]);
      const b = k(polygon[(j + 1) % polygon.length]);
      if (a === b) throw new Error('Zero-length BRep edge');
      const edge = [a, b].sort().join('~');
      const count = directedEdges.get(edge) || [0, 0];
      count[a < b ? 0 : 1]++;
      directedEdges.set(edge, count);
    }
    for (let j = 1; j < polygon.length - 1; j++)
      signedVolume +=
        dot(
          minus(polygon[0], anchor),
          cross(minus(polygon[j], anchor), minus(polygon[j + 1], anchor)),
        ) / 6;
  }
  if ([...directedEdges.values()].some(([a, b]) => a !== 1 || b !== 1))
    throw new Error('Open/nonmanifold/inconsistently oriented BRep');
  const volume = Math.abs(signedVolume);
  if (!(volume > 1e-6)) throw new Error('Zero BRep volume');
  const vertices = [...new Map(faces.flat().map((p) => [k(p), p])).values()];
  const crossAxes = [0, 1, 2].filter((i) => i !== axis);
  const stations = new Map();
  for (const xyz of vertices) {
    const station = Math.round(xyz[axis] * 1e5) / 1e5;
    const uv = crossAxes.map((i) => xyz[i]);
    if (!stations.has(station)) stations.set(station, new Map());
    stations.get(station).set(k(uv), uv);
  }
  const sections = [...stations]
    .sort((a, b) => a[0] - b[0])
    .map(([station, values]) => {
      const pts = [...values.values()];
      if (pts.length !== 4) throw new Error('Nonrectangular/partial BRep station');
      const min = [0, 1].map((i) => Math.min(...pts.map((p) => p[i])));
      const max = [0, 1].map((i) => Math.max(...pts.map((p) => p[i])));
      if (!max.every((n, i) => n - min[i] > 1e-5)) throw new Error('Degenerate BRep station');
      for (const u of [min[0], max[0]])
        for (const v of [min[1], max[1]])
          if (!pts.some((p) => almost(p[0], u) && almost(p[1], v)))
            throw new Error('Nonrectangular BRep station corners');
      return { station, min, max, widths: max.map((v, i) => v - min[i]) };
    });
  if (
    sections.length < 2 ||
    !almost(sections[0].station, Math.min(axisStart[axis], axisEnd[axis])) ||
    !almost(sections.at(-1).station, Math.max(axisStart[axis], axisEnd[axis]))
  )
    throw new Error('IFC Axis endpoints differ from BRep stations');
  let integratedVolume = 0;
  for (let i = 1; i < sections.length; i++) {
    const l = sections[i].station - sections[i - 1].station;
    const [a, b] = sections[i - 1].widths;
    const [c, d] = sections[i].widths;
    integratedVolume += (l * (2 * a * b + a * d + c * b + 2 * c * d)) / 6;
  }
  if (Math.abs(integratedVolume - volume) > Math.max(0.01, volume * 1e-6))
    throw new Error('BRep mesh and rectangular loft volume disagree');
  return {
    length,
    direction: { x: direction[0], y: direction[1], z: direction[2] },
    localAxisStart: axisStart,
    localAxisEnd: axisEnd,
    sections,
    faceCount: faces.length,
    volume,
  };
}
