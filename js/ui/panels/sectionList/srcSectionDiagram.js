/**
 * SRC断面の共通2D投影。
 * 3Dビューの createSectionProfile と同じ断面経路を通し、
 * CROSS_H / SHAPE_T は3Dメッシュの配置記述をそのまま共有する。
 * STB寸法が不足する場合は寸法を推測して作図しない。
 */
import { createSectionProfile } from '../../../viewer/geometry/core/SectionProfileFactory.js';
import {
  describeCrossHSteelComponents, describeShapeTSteelComponents,
} from '../../../viewer/geometry/core/SrcSteelComponentDescriptors.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
// UI/SVG/DXF/シート計測で同一バリアントの断面を繰り返し生成しない。
const outlineCache = new WeakMap();
const valid = (n) => Number.isFinite(n) && n > 0;
const number = (n) => (n == null || n === '' ? null : Number(n));
const finite = (n) => Number.isFinite(n) ? n : 0;

function sectionDimensions(profile) {
  if (!profile) return null;
  const dims = {
    A: profile.A, H: profile.A, B: profile.B,
    t: profile.t, t1: profile.t1, t2: profile.t2,
    D: profile.D, diameter: profile.D,
    outer_diameter: profile.D,
  };
  return dims;
}

function isValidSteelProfile(type, p) {
  if (!p) return false;
  if (type === 'PIPE') return valid(p.D) && valid(p.t) && p.D > p.t * 2;
  if (type === 'BOX') return valid(p.A) && valid(p.B) && valid(p.t || p.t1) && valid(p.t || p.t2);
  if (type === 'H' || type === 'T')
    return valid(p.A) && valid(p.B) && valid(p.t1) && valid(p.t2);
  return false;
}

function steelDescriptors(variant) {
  const shapes = variant.shapes || [];
  const byAxis = new Map(shapes.map((s) => [s.axis, s]));
  const sectionMap = new Map(shapes.filter((s) => s.profile).map((s) => [
    s.name, { dimensions: sectionDimensions(s.profile) },
  ]));
  if (byAxis.has('H') && byAxis.has('T')) {
    const placement = variant.steelPlacement || {};
    return describeShapeTSteelComponents({
      shapeT_shapeH: byAxis.get('H').name, shapeT_shapeT: byAxis.get('T').name,
      shapeT_direction: placement.direction || byAxis.get('H').direction,
      shapeT_offsetHX: number(placement.offsetHX) ?? 0,
      shapeT_offsetHY: number(placement.offsetHY) ?? 0,
      shapeT_offsetT: number(placement.offsetT) ?? 0,
    }, sectionMap).map((item) => ({ ...item, profile: byAxis.get(item.arm)?.profile }));
  }
  if (byAxis.has('X') && byAxis.has('Y')) {
    return describeCrossHSteelComponents({
      crossH_shapeX: byAxis.get('X').name, crossH_shapeY: byAxis.get('Y').name,
    }, sectionMap).map((item) => ({ ...item, profile: byAxis.get(item.arm)?.profile }));
  }
  // 3D側と同様、I方向はHを90°回転。複合断面は上の専用配置を使う。
  return shapes.map((s) => ({
    profileType: s.profile?.family || null,
    shapeName: s.name, profile: s.profile, angle: s.direction === 'I' ? Math.PI / 2 : 0,
    x: 0, y: 0,
  }));
}

function makeProfile(type, dims) {
  try {
    const result = createSectionProfile({ section_type: type, dimensions: dims }, type, 'src-list', silentLog, {
      supportCircle: true,
    });
    return result?.shape || null;
  } catch {
    return null;
  }
}

function transformed(points, descriptor) {
  const angle = descriptor.angle || 0, cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = descriptor.x || 0, dy = descriptor.y || 0;
  return points.map((p) => ({
    x: p.x * cos - p.y * sin + dx,
    y: p.x * sin + p.y * cos + dy,
  }));
}

function outlines(shape, descriptor = {}) {
  if (!shape?.getPoints) return [];
  const pointSets = [shape.getPoints(32), ...(shape.holes || []).map((hole) => hole.getPoints(32))];
  return pointSets.filter((points) => points.length >= 3 && points.every((p) =>
    Number.isFinite(p.x) && Number.isFinite(p.y))).map((points) => transformed(points, descriptor));
}

function concreteOutlines(concrete) {
  if (!concrete) return [];
  const type = concrete.kind === 'circle' ? 'CIRCLE' : 'RECTANGLE';
  if (type === 'CIRCLE' && !valid(concrete.diameter)) return [];
  if (type === 'RECTANGLE' && !(valid(concrete.width) && valid(concrete.height))) return [];
  const dims = type === 'CIRCLE'
    ? { diameter: concrete.diameter, D: concrete.diameter, radius: concrete.diameter / 2 }
    : { width: concrete.width, height: concrete.height, outer_width: concrete.width, outer_height: concrete.height };
  return outlines(makeProfile(type, dims));
}

/** 3Dと同じ断面プロファイルおよび内蔵鉄骨の配置から2Dの輪郭を得る。 */
export function projectSrcSectionOutlines(variant) {
  if (outlineCache.has(variant)) return outlineCache.get(variant);
  const concrete = concreteOutlines(variant.concrete);
  const steel = [];
  for (const descriptor of steelDescriptors(variant)) {
    const type = descriptor.profileType;
    if (!isValidSteelProfile(type, descriptor.profile)) continue;
    const shape = makeProfile(type, descriptor.dimensions || sectionDimensions(descriptor.profile));
    steel.push(...outlines(shape, descriptor));
  }
  const result = { concrete, steel };
  outlineCache.set(variant, result);
  return result;
}

function boundsFor(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of [...geometry.concrete, ...geometry.steel]) {
    for (const p of polygon) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return Number.isFinite(minX)
    ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
}

export function srcDiagramExtent(variant) {
  return boundsFor(projectSrcSectionOutlines(variant));
}

function drawPolygons(polygons, cx, cy, lines2D, layer) {
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      if (a.x === b.x && a.y === b.y) continue;
      lines2D.push({
        start: { x: a.x + cx, y: a.y + cy },
        end: { x: b.x + cx, y: b.y + cy },
        layer,
      });
    }
  }
}

export function appendSrcSectionEntities(variant, cx, cy, lines2D, circles2D) {
  const geo = projectSrcSectionOutlines(variant);
  if (variant.concrete?.kind === 'circle' && valid(variant.concrete.diameter)) {
    circles2D.push({ center: { x: cx, y: cy }, radius: variant.concrete.diameter / 2, layer: 'CONCRETE' });
  } else drawPolygons(geo.concrete, cx, cy, lines2D, 'CONCRETE');
  drawPolygons(geo.steel, cx, cy, lines2D, 'STEEL');
}

function toSvgPath(polygons) {
  return polygons.map((points) => {
    const first = points[0];
    return 'M' + first.x + ',' + (-first.y) + points.slice(1).map((p) =>
      'L' + p.x + ',' + (-p.y)).join('') + 'Z';
  }).join('');
}

export function srcSectionDiagramSvg(variant, scaleDenominator = 40) {
  const geo = projectSrcSectionOutlines(variant);
  const bounds = boundsFor(geo);
  if (!bounds.width || !bounds.height)
    return '<div class="steel-section-unavailable">断面形状未定義（形状名を参照）</div>';
  const pad = Math.max(bounds.width, bounds.height) * 0.08;
  const px = 96 / 25.4 / Math.max(1, Number(scaleDenominator) || 40);
  // SVGはY下向き、3D断面座標系はY上向きのため符号を反転する。
  const vb = [
    bounds.minX - pad, -bounds.maxY - pad,
    bounds.width + pad * 2, bounds.height + pad * 2,
  ].join(' ');
  const concrete = '<path d="' + toSvgPath(geo.concrete) + '" fill="none" stroke="currentColor" stroke-width="8"/>';
  const steel = '<path d="' + toSvgPath(geo.steel) + '" fill="currentColor" fill-rule="evenodd"/>';
  return '<svg class="steel-section-profile src-section-profile" role="img" aria-label="SRCコンクリート・鉄骨断面（鉄筋詳細は文字表記）" viewBox="' + vb +
    '" width="' + (bounds.width + pad * 2) * px + '" height="' + (bounds.height + pad * 2) * px +
    '" preserveAspectRatio="xMidYMid meet">' + concrete + steel + '</svg>';
}

export function srcConcreteLabel(concrete) {
  if (!concrete) return 'コンクリート寸法未定義';
  return concrete.kind === 'circle' ? 'D' + concrete.diameter : concrete.width + '×' + concrete.height;
}
