/** IFC swept surface boundaries -> STB polygon coordinates in millimetres. */
import * as WebIFC from 'web-ifc';
import {
  buildMatrixFromAxis2Placement,
  multiplyMatrices,
  transformPoint,
} from '../util/CoordinateHelper.js';

const deref = (ref) => ref?.value ?? ref;
const value = (ref) => ref?.value ?? ref;

/**
 * Reproduce measured IFCRECTANGLEPROFILEDEF or closed polyline boundaries.
 * No bounding-box fallback or invented geometry for BRep/curves/voids.
 * @returns {Array<{x:number,y:number,z:number}>|null}
 */
export function extractSlabFaceNodes(api, modelID, unitFactor, representationRef, worldMatrix) {
  const productShape = representationRef && api.GetLine(modelID, deref(representationRef));
  if (!productShape?.Representations || !Number.isFinite(unitFactor) || unitFactor <= 0)
    return null;

  for (const repRef of productShape.Representations) {
    const representation = api.GetLine(modelID, deref(repRef));
    for (const itemRef of representation?.Items || []) {
      const item = api.GetLine(modelID, deref(itemRef));
      if (item?.type !== WebIFC.IFCEXTRUDEDAREASOLID) continue;
      const profile = api.GetLine(modelID, deref(item.SweptArea));
      let localPoints;
      if (profile?.type === WebIFC.IFCRECTANGLEPROFILEDEF) {
        const x = Number(value(profile.XDim));
        const y = Number(value(profile.YDim));
        if (!(x > 0) || !(y > 0)) continue;
        localPoints = [
          { x: -x / 2, y: -y / 2, z: 0 },
          { x: x / 2, y: -y / 2, z: 0 },
          { x: x / 2, y: y / 2, z: 0 },
          { x: -x / 2, y: y / 2, z: 0 },
        ];
      } else if (profile?.type === WebIFC.IFCARBITRARYCLOSEDPROFILEDEF) {
        const curve = profile.OuterCurve ? api.GetLine(modelID, deref(profile.OuterCurve)) : null;
        if (curve?.type !== WebIFC.IFCPOLYLINE) continue;
        localPoints = (curve.Points || []).map((ref) => {
          const point = api.GetLine(modelID, deref(ref));
          const coordinates = point?.Coordinates || [];
          if (coordinates.length !== 2) return null;
          const x = Number(value(coordinates[0]));
          const y = Number(value(coordinates[1]));
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y, z: 0 } : null;
        });
        if (localPoints.some((p) => !p)) continue;
        if (localPoints.length > 1) {
          const first = localPoints[0];
          const last = localPoints[localPoints.length - 1];
          if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-7) localPoints.pop();
        }
        if (localPoints.length < 3) continue;
        const area2 = localPoints.reduce((sum, point, index) => {
          const next = localPoints[(index + 1) % localPoints.length];
          return sum + point.x * next.y - next.x * point.y;
        }, 0);
        if (Math.abs(area2) < 1e-8) continue;
      } else continue;
      // ProductObjectPlacement × Solid.Position × SweptArea.Position.
      const solid = item.Position
        ? buildMatrixFromAxis2Placement(api, modelID, deref(item.Position))
        : null;
      const shape = profile.Position
        ? buildMatrixFromAxis2Placement(api, modelID, deref(profile.Position))
        : null;
      let matrix = worldMatrix;
      if (solid) matrix = multiplyMatrices(matrix, solid);
      if (shape) matrix = multiplyMatrices(matrix, shape);
      const corners = localPoints.map((p) => {
        const w = transformPoint(p, matrix);
        return { x: w.x * unitFactor, y: w.y * unitFactor, z: w.z * unitFactor };
      });
      const sig = new Set(
        corners.map((p) => [p.x, p.y, p.z].map((v) => Math.round(v * 1000)).join(',')),
      );
      if (
        sig.size === corners.length &&
        corners.length >= 3 &&
        corners.every((p) => [p.x, p.y, p.z].every(Number.isFinite))
      )
        return corners;
    }
  }
  return null;
}

/** Legacy API alias. */
export const extractRectangularSlabNodes = extractSlabFaceNodes;

/** Measured normal extrusion depth (mm) of a supported swept slab profile. */
export function extractSlabExtrusionDepth(api, modelID, unitFactor, representationRef) {
  if (!(unitFactor > 0)) return null;
  const shape = representationRef && api.GetLine(modelID, deref(representationRef));
  if (!shape?.Representations) return null;
  const depths = [];
  for (const repRef of shape.Representations) {
    const rep = api.GetLine(modelID, deref(repRef));
    for (const itemRef of rep?.Items || []) {
      const item = api.GetLine(modelID, deref(itemRef));
      if (item?.type !== WebIFC.IFCEXTRUDEDAREASOLID) continue;
      const profile = api.GetLine(modelID, deref(item.SweptArea));
      if (
        ![WebIFC.IFCRECTANGLEPROFILEDEF, WebIFC.IFCARBITRARYCLOSEDPROFILEDEF].includes(
          profile?.type,
        )
      )
        continue;
      const depth = Number(value(item.Depth)) * unitFactor;
      if (!Number.isFinite(depth) || depth <= 0) continue;
      depths.push(depth);
    }
  }
  if (!depths.length || depths.some((depth) => Math.abs(depth - depths[0]) > 1e-6)) return null;
  return depths[0];
}
