/** @fileoverview DrawingModelを選択可能なSVGへ変換。PDF Canvasとは別レイヤ。 */
import {
  assertMatrix,
  isDirectSimilarity,
  invertAffine,
  multiplyAffine,
  transformPoint,
} from '../../data/drawing/affine2d.js';
import { elementRefKey } from '../../data/drawing/drawingModel.js';
import { assertDrawingRenderPlan } from '../../data/drawing/drawingRenderPlan.js';
import {
  DEFAULT_DRAWING_TAG_ORIENTATION_MODE,
  DRAWING_TAG_ORIENTATION_MODES,
  normalizeDrawingTagOrientationMode,
} from '../../config/drawingTagTemplates.js';
import {
  buildSelectedDrawingTagPlan,
  familyIdFromSelection,
} from '../../data/drawing/tags/tagFamilyRegistry.js';
import { renderTagSvg } from './svgTagRenderer.js';
import {
  computeDefaultTagOriginCss,
  describeLineMember,
  estimateTagExtent,
} from './tagDefaultPlacement.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
const TAG_MODES = new Set(['hidden', 'mark', 'detail']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_MEMBER_COLOR = '#087f8c';
const DEFAULT_TAG_COLOR = '#075963';
const DEFAULT_CUT_SURFACE_FILL_OPACITY = 0.18;
const CUT_SURFACE_ELEMENT_TYPES = new Set(['Column', 'Post', 'Wall']);
const LINE_ALIGNED_TAG_ELEMENT_TYPES = new Set(['Girder', 'Beam', 'Brace', 'Wall']);

function normalizeAngleRadians(value) {
  let angle = value % (Math.PI * 2);
  if (angle < 0) angle += Math.PI * 2;
  return angle;
}

function referencePolylinePath(points, bulges = [], closed = false) {
  if (!Array.isArray(points) || points.length < 2) return '';
  let path = `M ${points[0][0]} ${points[0][1]}`;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const bulge = Number(bulges[index] || 0);
    if (!Number.isFinite(bulge) || Math.abs(bulge) <= 1e-12) {
      path += ` L ${end[0]} ${end[1]}`;
      continue;
    }
    const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const included = 4 * Math.atan(Math.abs(bulge));
    const largeArc = included > Math.PI ? 1 : 0;
    // DXF bulge正=CCW。SVG/CSSはY下向きなので視覚上のCCWはsweep=0。
    const sweep = bulge < 0 ? 1 : 0;
    path += ` A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end[0]} ${end[1]}`;
  }
  if (closed) path += ' Z';
  return path;
}

function referenceArcFlags(primitive, space = 'paper') {
  const center = primitive.center?.[space];
  const start = primitive.startPoint?.[space];
  const end = primitive.endPoint?.[space];
  if (![center, start, end].every((point) => Array.isArray(point) && point.length === 2))
    throw new TypeError('ReferenceDrawing arc座標が不正です。');
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const sweepAngle = primitive.clockwise
    ? normalizeAngleRadians(startAngle - endAngle)
    : normalizeAngleRadians(endAngle - startAngle);
  return { largeArc: sweepAngle > Math.PI ? 1 : 0, sweep: primitive.clockwise ? 1 : 0 };
}

function referenceTextAnchor(anchor = {}) {
  const horizontal = { left: 'start', middle: 'middle', center: 'middle', right: 'end' }[
    anchor.horizontal || 'left'
  ];
  const vertical = {
    baseline: 'alphabetic',
    bottom: 'text-after-edge',
    middle: 'central',
    center: 'central',
    top: 'text-before-edge',
  }[anchor.vertical || 'baseline'];
  return { horizontal: horizontal || 'start', vertical: vertical || 'alphabetic' };
}

function isCutSurfaceRecord(record) {
  return CUT_SURFACE_ELEMENT_TYPES.has(record?.ref?.elementType);
}

function primitiveSectionPartKey(primitive, primitiveIndex) {
  if (Number.isInteger(primitive?.sectionPart) && primitive.sectionPart >= 0)
    return `part:${primitive.sectionPart}`;
  if (typeof primitive?.id === 'string' && primitive.id) return `primitive:${primitive.id}`;
  return `primitive-index:${primitiveIndex}`;
}

function cutSurfaceFillEnabled(displaySettings) {
  return displaySettings?.cutSurfaceFill !== false;
}

function cutSurfaceFillOpacity(displaySettings) {
  const value = Number(displaySettings?.cutSurfaceFillOpacity);
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_CUT_SURFACE_FILL_OPACITY;
}

function recordDisplayType(record) {
  return record?.renderType || record?.ref?.elementType;
}

function isDrawingElementVisible(displaySettings, elementType) {
  return displaySettings?.visibility?.[elementType] !== false;
}

function drawingElementColor(displaySettings, elementType, fallback = null) {
  const color = displaySettings?.colors?.[elementType];
  if (typeof color !== 'string') return fallback;
  const normalized = color.trim();
  return HEX_COLOR.test(normalized) ? normalized : fallback;
}

function annotationLayer(role) {
  return role === 'grid' || role === 'grid-label' || role === 'grid-bubble' ? 'Axis' : 'Annotation';
}

function drawingTagMode(displaySettings, elementType, showLabels) {
  if (!showLabels) return 'hidden';
  const mode = displaySettings?.tagModes?.[elementType] ?? 'mark';
  return TAG_MODES.has(mode) || familyIdFromSelection(mode) ? mode : 'mark';
}

function annotationVisible(annotation, displaySettings) {
  const role = String(annotation?.role || '');
  if (
    role === 'grid' ||
    role === 'grid-label' ||
    role === 'grid-bubble' ||
    role.startsWith('dimension')
  )
    return isDrawingElementVisible(displaySettings, 'Axis');
  return true;
}

function renderPlanDimensionAnnotations(dimensions) {
  return (dimensions || []).flatMap((dimension) =>
    (dimension.primitives || []).map((primitive) => {
      const strokeColor = dimension.strokeColor || '#616161';
      const textColor = dimension.textColor || '#424242';
      return Object.freeze({
        ...primitive,
        ...(dimension.measurementId ? { measurementId: String(dimension.measurementId) } : {}),
        layerId: dimension.layerId,
        visibilitySource: dimension.visibilitySource,
        visible: dimension.visible !== false,
        coordinateSpace: 'paper',
        paperStyle: true,
        style: Object.freeze({
          strokeColor: primitive.kind === 'text' ? null : strokeColor,
          strokeWidthMm: primitive.style?.strokeWidthPaperMm ?? 0.25,
          dashPatternMm: primitive.style?.dashPatternPaperMm ?? null,
          textColor: primitive.kind === 'text' ? textColor : null,
          textHeightMm: primitive.style?.heightPaperMm ?? null,
          fillColor: primitive.filled === true ? strokeColor : 'none',
        }),
      });
    }),
  );
}

function renderPlanElementRecord(element) {
  if (!element?.sourceRef || element.sourceRef.key !== element.key)
    throw new Error('DrawingRenderPlanの部材sourceRefが不正です。');
  return {
    key: element.key,
    ref: element.sourceRef,
    renderType: element.renderType || element.sourceRef.elementType,
    layerId: element.layerId,
    visibilitySource:
      element.visibilitySource || element.renderType || element.sourceRef.elementType,
    visible: element.visible !== false,
    mark: element.mark || '',
    sectionId: element.sectionId,
    state: element.state,
  };
}

/** PDF.jsのCSS viewportを受け取る。DPRを掛けた行列を渡さないこと。 */
export function renderDrawingSvg({
  drawing,
  renderPlan = null,
  dimensionGroups = null,
  dimensionPaperToCss = null,
  registration,
  pdfToCss,
  width,
  height,
  document: domDocument = globalThis.document,
  onSelect = null,
  showLabels = true,
  labelFontSize = 12,
  labelStrokeWidth = 3,
  displaySettings = null,
  tagFamilyState = null,
  resolveTagFacts = null,
  resolveTagPlacement = null,
  tagOffsetToCss = null,
  tagOrientationMode = DEFAULT_DRAWING_TAG_ORIENTATION_MODE,
  onTagPointerDown = null,
  onReferenceSelect = null,
  paperMmToCss = null,
} = {}) {
  const sharedPlan = renderPlan == null ? null : assertDrawingRenderPlan(renderPlan);
  if (sharedPlan && dimensionGroups != null)
    throw new TypeError('shared RenderPlanとdetached dimensionGroupsは同時に指定できません。');
  if (dimensionGroups != null && !Array.isArray(dimensionGroups))
    throw new TypeError('dimensionGroupsは配列で指定してください。');
  if (dimensionGroups != null) assertMatrix(dimensionPaperToCss);
  if (!sharedPlan && (drawing?.schemaVersion !== 1 || drawing.units !== 'mm'))
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  if (sharedPlan && drawing != null && (drawing?.schemaVersion !== 1 || drawing.units !== 'mm'))
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  const sharedLayerById = new Map((sharedPlan?.layers || []).map((layer) => [layer.id, layer]));
  if (!sharedPlan && !isDirectSimilarity(registration)) {
    throw new TypeError('位置合わせには反転のない相似変換を指定してください。');
  }
  assertMatrix(pdfToCss);
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    throw new RangeError('SVG表示寸法が不正です。');
  if (typeof domDocument?.createElementNS !== 'function')
    throw new TypeError('SVG生成用Documentが必要です。');
  if (onSelect != null && typeof onSelect !== 'function')
    throw new TypeError('部材選択callbackが不正です。');
  const normalizedTagOrientationMode = normalizeDrawingTagOrientationMode(tagOrientationMode);
  const create = (tag, attrs = {}) => {
    const node = domDocument.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  };
  const svg = create('svg', {
    xmlns: SVG_NS,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    'aria-label': 'STB図形（目視照合用・自動判定ではありません）',
  });
  const modelToCss = multiplyAffine(
    pdfToCss,
    sharedPlan ? sharedPlan.profile.modelToPaper : registration,
  );

  if (Array.isArray(sharedPlan?.referencePrimitives) && sharedPlan.referencePrimitives.length) {
    const referenceGroup = create('g', { class: 'reference-drawing-layer' });
    for (const primitive of sharedPlan.referencePrimitives) {
      const layer = sharedLayerById.get(primitive.layerId);
      if (!layer || layer.visible === false || primitive.visible === false) continue;
      const stroke = primitive.style?.strokeColor || layer.style?.strokeColor || '#6c757d';
      const opacity = Number.isFinite(layer.opacity)
        ? layer.opacity
        : Number.isFinite(primitive.opacity)
          ? primitive.opacity
          : 1;
      const dashPatternMm = primitive.style?.dashPatternMm;
      const dashScale = Math.hypot(pdfToCss[0], pdfToCss[1]);
      const strokeDasharray =
        Array.isArray(dashPatternMm) && dashPatternMm.length
          ? dashPatternMm.map((value) => value * dashScale).join(' ')
          : null;
      const selectAttrs = {
        'data-reference-document-id': primitive.referenceDocumentId,
        'data-reference-layer': layer.sourceLayerId || '',
        'data-reference-primitive-id': primitive.id,
        'data-reference-source-key': primitive.sourceRef?.entityId || primitive.id,
      };
      const nodeGroup = create('g', {
        class: 'reference-drawing-primitive',
        ...selectAttrs,
        opacity,
      });
      if (typeof onReferenceSelect === 'function') {
        nodeGroup.setAttribute('tabindex', '0');
        nodeGroup.setAttribute('role', 'button');
        const select = () =>
          onReferenceSelect({ ...primitive.sourceRef, primitiveId: primitive.id });
        nodeGroup.addEventListener('click', select);
        nodeGroup.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        });
      } else {
        nodeGroup.setAttribute('pointer-events', 'none');
      }

      if (primitive.kind === 'line' || primitive.kind === 'polyline') {
        const points = primitive.points?.paper?.map((point) => transformPoint(pdfToCss, point));
        if (!Array.isArray(points) || points.length < 2)
          throw new TypeError('ReferenceDrawingの線点列が不正です。');
        const d =
          primitive.kind === 'line'
            ? `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`
            : referencePolylinePath(points, primitive.bulges, primitive.closed);
        nodeGroup.append(
          create('path', {
            d,
            fill: 'none',
            stroke,
            'stroke-width': 1,
            ...(strokeDasharray ? { 'stroke-dasharray': strokeDasharray } : {}),
            'vector-effect': 'non-scaling-stroke',
            'data-drawing-layer': primitive.layerId,
          }),
        );
      } else if (primitive.kind === 'circle') {
        const center = transformPoint(pdfToCss, primitive.center.paper);
        const radiusScale = Math.hypot(pdfToCss[0], pdfToCss[1]);
        nodeGroup.append(
          create('circle', {
            cx: center[0],
            cy: center[1],
            r: primitive.radius.paper * radiusScale,
            fill: 'none',
            stroke,
            'stroke-width': 1,
            ...(strokeDasharray ? { 'stroke-dasharray': strokeDasharray } : {}),
            'vector-effect': 'non-scaling-stroke',
            'data-drawing-layer': primitive.layerId,
          }),
        );
      } else if (primitive.kind === 'arc') {
        const start = transformPoint(pdfToCss, primitive.startPoint.paper);
        const end = transformPoint(pdfToCss, primitive.endPoint.paper);
        const radiusScale = Math.hypot(pdfToCss[0], pdfToCss[1]);
        const radius = primitive.radius.paper * radiusScale;
        const flags = referenceArcFlags(primitive, 'paper');
        nodeGroup.append(
          create('path', {
            d: `M ${start[0]} ${start[1]} A ${radius} ${radius} 0 ${flags.largeArc} ${flags.sweep} ${end[0]} ${end[1]}`,
            fill: 'none',
            stroke,
            'stroke-width': 1,
            ...(strokeDasharray ? { 'stroke-dasharray': strokeDasharray } : {}),
            'vector-effect': 'non-scaling-stroke',
            'data-drawing-layer': primitive.layerId,
          }),
        );
      } else if (primitive.kind === 'text') {
        const point = transformPoint(pdfToCss, primitive.point.paper);
        const textScale = Math.hypot(pdfToCss[0], pdfToCss[1]);
        const anchor = referenceTextAnchor(primitive.anchor);
        const textNode = create('text', {
          x: point[0],
          y: point[1],
          'text-anchor': anchor.horizontal,
          'dominant-baseline': anchor.vertical,
          'font-size': primitive.textHeight.paper * textScale,
          fill: stroke,
          'data-drawing-layer': primitive.layerId,
        });
        const rotationDeg = Number(primitive.rotationDeg?.paper || 0);
        const widthFactor =
          Number.isFinite(primitive.widthFactor) && primitive.widthFactor > 0
            ? primitive.widthFactor
            : 1;
        const scaleX = (primitive.mirrorX === true ? -1 : 1) * widthFactor;
        const scaleY = primitive.mirrorY === true ? -1 : 1;
        const obliqueDeg = Number.isFinite(primitive.obliqueDeg) ? primitive.obliqueDeg : 0;
        if (
          Math.abs(rotationDeg) > 1e-12 ||
          Math.abs(scaleX - 1) > 1e-12 ||
          Math.abs(scaleY - 1) > 1e-12 ||
          Math.abs(obliqueDeg) > 1e-12
        ) {
          textNode.setAttribute(
            'transform',
            `translate(${point[0]} ${point[1]}) rotate(${rotationDeg}) scale(${scaleX} ${scaleY}) skewX(${-obliqueDeg}) translate(${-point[0]} ${-point[1]})`,
          );
        }
        const lines = String(primitive.text || '').split(/\r?\n/);
        if (lines.length <= 1) {
          textNode.textContent = lines[0] || '';
        } else {
          lines.forEach((line, index) => {
            const tspan = create('tspan', {
              x: point[0],
              dy: index === 0 ? 0 : primitive.textHeight.paper * textScale * 1.2,
            });
            tspan.textContent = line;
            textNode.append(tspan);
          });
        }
        nodeGroup.append(textNode);
      } else {
        throw new TypeError(`未対応のReferenceDrawing primitiveです: ${primitive.kind}`);
      }
      referenceGroup.append(nodeGroup);
    }
    if (referenceGroup.childNodes.length) svg.append(referenceGroup);
  }

  const annotationGroup = create('g', {
    class: 'stb-drawing-annotations',
    'pointer-events': 'none',
  });
  const annotationStyle = (role) => {
    const axisColor = drawingElementColor(displaySettings, 'Axis');
    if (role === 'grid') return { stroke: axisColor || '#607d8b', width: 0.8, dash: '6 4' };
    if (role === 'grid-label') return { fill: axisColor || '#455a64', fontSize: labelFontSize };
    if (role === 'grid-bubble')
      return { stroke: axisColor || '#607d8b', width: 0.8, fill: '#ffffff' };
    if (role === 'dimension-text')
      return { fill: '#424242', fontSize: Math.max(2.5, labelFontSize * 0.85) };
    if (role === 'dimension-overall') return { stroke: '#424242', width: 1.2 };
    if (role === 'dimension' || role === 'dimension-extension' || role === 'dimension-tick')
      return { stroke: '#616161', width: 0.9 };
    return { stroke: '#616161', width: 0.9, fill: '#424242', fontSize: 9 };
  };
  const measurementGroups = new Map();
  const measurementLayer = create('g', { class: 'stb-drawing-measurement-results' });
  const compiledDimensions = sharedPlan ? sharedPlan.dimensions || [] : dimensionGroups || [];
  const sourceAnnotations = [
    ...(sharedPlan ? sharedPlan.annotations : drawing.annotations || []),
    ...renderPlanDimensionAnnotations(compiledDimensions),
  ];
  for (const annotation of sourceAnnotations) {
    if (sharedPlan ? annotation.visible === false : !annotationVisible(annotation, displaySettings))
      continue;
    const paperSpace = sharedPlan || annotation.coordinateSpace === 'paper';
    const annotationToCss = paperSpace ? (sharedPlan ? pdfToCss : dimensionPaperToCss) : modelToCss;
    const paperStyleScale =
      annotation.paperStyle === true ? Math.hypot(annotationToCss[0], annotationToCss[1]) : 1;
    const style =
      sharedPlan || annotation.coordinateSpace === 'paper'
        ? {
            stroke: annotation.style?.strokeColor,
            width:
              annotation.style?.strokeWidthMm == null
                ? null
                : annotation.style.strokeWidthMm * paperStyleScale,
            dash: annotation.style?.dashPatternMm
              ?.map((value) => value * paperStyleScale)
              .join(' '),
            fill: annotation.style?.textColor || annotation.style?.fillColor,
            fontSize:
              annotation.style?.textHeightMm == null
                ? null
                : annotation.style.textHeightMm * paperStyleScale,
          }
        : annotationStyle(annotation.role);
    const layerId = sharedPlan ? annotation.layerId : annotationLayer(annotation.role);
    let annotationParent = annotationGroup;
    const measurementId = annotation.measurementId;
    if (measurementId) {
      if (!measurementGroups.has(measurementId)) {
        const group = create('g', {
          class: 'pdf-overlay-measurement-draggable is-inactive',
          'data-measurement-id': measurementId,
        });
        measurementGroups.set(measurementId, group);
        measurementLayer.append(group);
      }
      annotationParent = measurementGroups.get(measurementId);
    }
    if (annotation.kind === 'polyline') {
      const sourcePoints = paperSpace ? annotation.points?.paper : annotation.points;
      if (!Array.isArray(sourcePoints) || sourcePoints.length < 2)
        throw new TypeError('注記polylineの点列が不正です。');
      const points = sourcePoints.map((point) => transformPoint(annotationToCss, point));
      annotationParent.append(
        create(annotation.closed === true ? 'polygon' : 'polyline', {
          points: points.map((point) => point.join(',')).join(' '),
          fill: annotation.filled === true ? style.fill || style.stroke || '#616161' : 'none',
          stroke: style.stroke || '#616161',
          'stroke-width': style.width || 0.25,
          ...(annotation.paperStyle === true ? {} : { 'vector-effect': 'non-scaling-stroke' }),
          'pointer-events': 'none',
          'data-drawing-layer': layerId,
        }),
      );
      continue;
    }
    if (annotation.kind === 'line') {
      const sourcePoints = paperSpace ? annotation.points?.paper : annotation.points;
      if (!Array.isArray(sourcePoints) || sourcePoints.length !== 2)
        throw new TypeError('注記lineの点列が不正です。');
      const [a, b] = sourcePoints.map((point) => transformPoint(annotationToCss, point));
      const attrs = {
        x1: a[0],
        y1: a[1],
        x2: b[0],
        y2: b[1],
        stroke: style.stroke,
        'stroke-width': style.width,
        ...(annotation.paperStyle === true ? {} : { 'vector-effect': 'non-scaling-stroke' }),
        'data-drawing-layer': layerId,
      };
      if (style.dash) attrs['stroke-dasharray'] = style.dash;
      const node = create('line', attrs);
      if (measurementId) {
        node.setAttribute(
          'class',
          annotation.role === 'dimension-witness' || annotation.role.endsWith('extension')
            ? 'pdf-overlay-measurement-extension'
            : 'pdf-overlay-measurement-dimension',
        );
        node.style.stroke = style.stroke;
        node.style.strokeWidth = String(style.width);
        node.style.strokeDasharray = style.dash || 'none';
      }
      annotationParent.append(node);
      continue;
    }
    if (annotation.kind === 'circle') {
      const sourceCenter = paperSpace ? annotation.center?.paper : annotation.center;
      if (!Array.isArray(sourceCenter) || sourceCenter.length !== 2)
        throw new TypeError('注記circleの中心が不正です。');
      const [cx, cy] = transformPoint(annotationToCss, sourceCenter);
      const radiusSource = paperSpace ? annotation.radius?.paper : annotation.radius;
      if (!Number.isFinite(radiusSource) || radiusSource <= 0)
        throw new TypeError('注記circleの半径が不正です。');
      const radiusScale = Math.hypot(annotationToCss[0], annotationToCss[1]);
      annotationParent.append(
        create('circle', {
          cx,
          cy,
          r: radiusSource * radiusScale,
          fill: style.fill || '#ffffff',
          stroke: style.stroke || '#607d8b',
          'stroke-width': style.width || 0.8,
          ...(annotation.paperStyle === true ? {} : { 'vector-effect': 'non-scaling-stroke' }),
          'pointer-events': 'none',
          'data-drawing-layer': layerId,
        }),
      );
      continue;
    }
    if (annotation.kind === 'text') {
      const sourcePoint = paperSpace ? annotation.point?.paper : annotation.point;
      if (!Array.isArray(sourcePoint) || sourcePoint.length !== 2)
        throw new TypeError('注記textの位置が不正です。');
      const [x, y] = transformPoint(annotationToCss, sourcePoint);
      const node = create('text', {
        x,
        y,
        'text-anchor': annotation.anchor || 'middle',
        'dominant-baseline': 'central',
        'font-size': style.fontSize || Math.max(2.5, labelFontSize * 0.85),
        fill: style.fill || '#424242',
        'paint-order': 'stroke',
        stroke: 'white',
        'stroke-width':
          annotation.paperStyle === true
            ? 0.6 * paperStyleScale
            : Math.max(0.6, labelStrokeWidth * 0.75),
        'stroke-linejoin': 'round',
        'pointer-events': 'none',
        'data-drawing-layer': layerId,
      });
      const rotationDeg = paperSpace
        ? (() => {
            const paperRotationDeg = Number(annotation.rotationDeg?.paper || 0);
            const radians = (paperRotationDeg * Math.PI) / 180;
            const xDirection = Math.cos(radians);
            const yDirection = Math.sin(radians);
            const xCss = annotationToCss[0] * xDirection + annotationToCss[2] * yDirection;
            const yCss = annotationToCss[1] * xDirection + annotationToCss[3] * yDirection;
            return (Math.atan2(yCss, xCss) * 180) / Math.PI;
          })()
        : annotation.rotationDeg;
      if (Number.isFinite(rotationDeg))
        node.setAttribute('transform', `rotate(${rotationDeg} ${x} ${y})`);
      node.textContent = annotation.text || '';
      if (measurementId) {
        node.setAttribute('class', 'pdf-overlay-measurement-label');
        node.setAttribute('data-measurement-id', measurementId);
        node.style.fontSize = style.fontSize + 'px';
        node.style.fill = style.fill;
        node.style.stroke = 'white';
        node.style.strokeWidth = '0.6';
      }
      annotationParent.append(node);
      continue;
    }
    throw new TypeError(`未対応の注記図形です: ${annotation.kind}`);
  }
  if (annotationGroup.childNodes.length) svg.insertBefore(annotationGroup, svg.firstChild);

  const records = new Map(
    (sharedPlan ? sharedPlan.elements.map(renderPlanElementRecord) : drawing.elements).map(
      (record) => [record.key, record],
    ),
  );
  const groups = new Map();
  const sourcePrimitives = sharedPlan ? sharedPlan.primitives : drawing.primitives;
  for (const [primitiveIndex, primitive] of sourcePrimitives.entries()) {
    const modelPoints = sharedPlan ? primitive.points?.model : primitive.points;
    if (primitive.kind !== 'polyline' || !Array.isArray(modelPoints) || modelPoints.length < 2)
      throw new TypeError('未対応の図形です。');
    const record = records.get(primitive.elementKey);
    const sourceRefMatches = sharedPlan
      ? primitive.sourceRef?.key === record?.key
      : record && elementRefKey(primitive.ref) === record.key;
    if (!record || record.state !== 'drawn' || !sourceRefMatches)
      throw new Error('図形から元部材への参照が不正です。');
    const displayType = recordDisplayType(record);
    if (
      sharedPlan ? record.visible === false : !isDrawingElementVisible(displaySettings, displayType)
    )
      continue;
    let entry = groups.get(record.key);
    if (!entry) {
      const group = create('g', {
        'data-element-key': record.key,
        ...(displayType
          ? { 'data-element-type': displayType, 'data-drawing-layer': displayType }
          : {}),
        class: 'stb-drawing-member',
        tabindex: 0,
        role: 'button',
        'aria-label': `${record.ref.elementType} ${record.ref.elementId} ${record.mark}`,
      });
      const select = () => {
        if (onSelect) onSelect({ ...record.ref });
      };
      group.addEventListener('click', select);
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select();
        }
      });
      entry = {
        group,
        record,
        modelMinX: Infinity,
        modelMinY: Infinity,
        modelMaxX: -Infinity,
        modelMaxY: -Infinity,
        cssMinX: Infinity,
        cssMinY: Infinity,
        cssMaxX: -Infinity,
        cssMaxY: -Infinity,
        cssPoints: [],
        cutFillSubpathsByPart: new Map(),
      };
      groups.set(record.key, entry);
      svg.append(group);
    }
    for (const [x, y] of modelPoints) {
      entry.modelMinX = Math.min(entry.modelMinX, x);
      entry.modelMinY = Math.min(entry.modelMinY, y);
      entry.modelMaxX = Math.max(entry.modelMaxX, x);
      entry.modelMaxY = Math.max(entry.modelMaxY, y);
    }
    const points = sharedPlan
      ? primitive.points.paper.map((point) => transformPoint(pdfToCss, point))
      : modelPoints.map((point) => transformPoint(modelToCss, point));
    entry.cssPoints.push(...points);
    for (const [x, y] of points) {
      entry.cssMinX = Math.min(entry.cssMinX, x);
      entry.cssMinY = Math.min(entry.cssMinY, y);
      entry.cssMaxX = Math.max(entry.cssMaxX, x);
      entry.cssMaxY = Math.max(entry.cssMaxY, y);
    }
    const pathData =
      points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ') +
      (primitive.closed ? ' Z' : '');
    if (primitive.closed && isCutSurfaceRecord(record)) {
      const partKey = primitiveSectionPartKey(primitive, primitiveIndex);
      const subpaths = entry.cutFillSubpathsByPart.get(partKey) || [];
      subpaths.push(pathData);
      entry.cutFillSubpathsByPart.set(partKey, subpaths);
    }
    const drawingLayerId = sharedPlan ? primitive.layerId : displayType;
    const strokeColor = sharedPlan
      ? sharedLayerById.get(primitive.layerId)?.style?.strokeColor || DEFAULT_MEMBER_COLOR
      : drawingElementColor(displaySettings, displayType, DEFAULT_MEMBER_COLOR);
    const path = create('path', {
      class: 'stb-drawing-member-outline',
      d: pathData,
      fill: 'none',
      stroke: strokeColor,
      'stroke-width': 1.5,
      ...(drawingLayerId ? { 'data-drawing-layer': drawingLayerId } : {}),
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'all',
    });
    entry.group.append(path);
  }

  // 平面図で実際に切断される鉛直部材だけを淡く塗る。
  // 同じsectionPart由来の複数ループはeven-oddでまとめ、角形鋼管などの中空部を保持する。
  for (const entry of groups.values()) {
    // タグ配置から独立した部材本体bbox中心を引出線・選択ズームの共通基準にする。
    entry.centerCss = transformPoint(modelToCss, [
      (entry.modelMinX + entry.modelMaxX) / 2,
      (entry.modelMinY + entry.modelMaxY) / 2,
    ]);
    entry.group.setAttribute('data-member-center-x', String(entry.centerCss[0]));
    entry.group.setAttribute('data-member-center-y', String(entry.centerCss[1]));
    if (!isCutSurfaceRecord(entry.record)) continue;
    const displayType = recordDisplayType(entry.record);
    const planLayerStyle = sharedPlan ? sharedLayerById.get(entry.record.layerId)?.style : null;
    if (sharedPlan ? !planLayerStyle?.fillColor : !cutSurfaceFillEnabled(displaySettings)) continue;
    const fill = sharedPlan
      ? planLayerStyle.fillColor
      : drawingElementColor(displaySettings, displayType, DEFAULT_MEMBER_COLOR);
    const fillOpacity = sharedPlan
      ? planLayerStyle.fillOpacity
      : cutSurfaceFillOpacity(displaySettings);
    const firstOutline = entry.group.firstChild;
    for (const subpaths of entry.cutFillSubpathsByPart.values()) {
      if (subpaths.length === 0) continue;
      entry.group.insertBefore(
        create('path', {
          class: 'stb-drawing-cut-fill',
          d: subpaths.join(' '),
          fill,
          'fill-opacity': fillOpacity,
          'fill-rule': 'evenodd',
          'clip-rule': 'evenodd',
          stroke: 'none',
          ...(displayType ? { 'data-drawing-layer': displayType } : {}),
          'pointer-events': 'none',
        }),
        firstOutline,
      );
    }
  }

  // 編集可能タグは全部材の上に置き、重なった他部材のSVGにポインタを奪われないようにする。
  let editableTagLayer = null;
  if (Array.isArray(sharedPlan?.tags)) {
    for (const tag of sharedPlan.tags) {
      const entry = groups.get(tag.elementKey);
      if (!entry) continue;
      const displayType = recordDisplayType(entry.record);
      const originCss = transformPoint(pdfToCss, tag.origin.paper);
      const leader = tag.primitives.find((primitive) => primitive.role === 'tag-leader');
      if (leader) {
        const [startPoint, endPoint] = leader.points.map((point) =>
          transformPoint(pdfToCss, point.paper),
        );
        entry.group.append(
          create('line', {
            class: 'stb-drawing-tag-leader',
            x1: startPoint[0],
            y1: startPoint[1],
            x2: endPoint[0],
            y2: endPoint[1],
            stroke: tag.color || DEFAULT_TAG_COLOR,
            'stroke-width': leader.strokeWidth.paper * (paperMmToCss || 1),
            ...(displayType ? { 'data-drawing-layer': displayType } : {}),
            'pointer-events': 'none',
          }),
        );
      }

      const tagNodes = renderTagSvg({
        plan: tag.renderPlan,
        originCss,
        fontSize: tag.genericTextHeightPaperMm,
        strokeWidth: tag.genericStrokeWidthPaperMm,
        paperMmToCss,
        document: domDocument,
        color: tag.color || DEFAULT_TAG_COLOR,
      });
      const rotationCssDeg = Number(tag.rotationDeg?.display || 0);
      const placementContext = Object.freeze({
        ref: Object.freeze({ ...tag.sourceRef }),
        elementKey: tag.elementKey,
        template: tag.template,
        defaultAnchorModel: Object.freeze([...tag.defaultAnchorModel]),
      });
      const editable = typeof onTagPointerDown === 'function';
      if (Math.abs(rotationCssDeg) > 1e-12 || editable) {
        const tagGroup = create('g', {
          class: 'stb-drawing-tag',
          'data-tag-element-key': tag.elementKey,
          'data-tag-template-id': tag.template.id,
          'data-tag-template-version': tag.template.version,
          'data-tag-orientation-mode': tag.orientationMode,
          ...(displayType ? { 'data-drawing-layer': displayType } : {}),
          ...(editable ? { 'data-tag-editable': 'true' } : {}),
        });
        if (Math.abs(rotationCssDeg) > 1e-12)
          tagGroup.setAttribute(
            'transform',
            `rotate(${rotationCssDeg} ${originCss[0]} ${originCss[1]})`,
          );
        tagGroup.append(...tagNodes);
        if (editable) {
          const setInteractive = (node) => {
            if (typeof node?.setAttribute === 'function')
              node.setAttribute('pointer-events', 'all');
            for (const child of node?.children || []) setInteractive(child);
          };
          tagNodes.forEach(setInteractive);
          tagGroup.addEventListener('pointerdown', (event) => {
            if (event.button != null && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            onTagPointerDown(event, {
              ...placementContext,
              placement: tag.placement,
              originCss: [...originCss],
            });
          });
          tagGroup.addEventListener('click', (event) => event.stopPropagation());
        }
        if (editable) {
          if (!editableTagLayer) {
            editableTagLayer = create('g', { class: 'stb-drawing-tag-layer' });
            svg.append(editableTagLayer);
          }
          editableTagLayer.append(tagGroup);
        } else {
          entry.group.append(tagGroup);
        }
      } else {
        entry.group.append(...tagNodes);
      }
    }
  } else {
    for (const entry of groups.values()) {
      const displayType = recordDisplayType(entry.record);
      const elementColor = drawingElementColor(displaySettings, displayType);
      const requestedMode = drawingTagMode(displaySettings, displayType, showLabels);
      if (requestedMode === 'hidden') continue;

      const plan = buildSelectedDrawingTagPlan({
        record: entry.record,
        source: drawing.source,
        selection: requestedMode,
        tagFamilyState,
        resolveTagFacts,
      });
      // 保存角度はSTB model XYを基準に「時計回り」を正とする。
      // 未配置タグの既定角度0°も含め、model→display変換で一度だけ写像する。
      // 図面追従時だけmodel→display変換へ写像し、「画面下へ補正」では保存角度をそのまま使う。
      const cssRotationFor = (rotationDeg) => {
        if (
          ![
            DRAWING_TAG_ORIENTATION_MODES.FOLLOW_DRAWING,
            DRAWING_TAG_ORIENTATION_MODES.FOLLOW_MEMBER,
          ].includes(normalizedTagOrientationMode) ||
          typeof tagOffsetToCss !== 'function'
        )
          return rotationDeg;
        const radians = (rotationDeg * Math.PI) / 180;
        const directionCss = tagOffsetToCss([Math.cos(radians), -Math.sin(radians)]);
        if (
          !Array.isArray(directionCss) ||
          directionCss.length !== 2 ||
          !directionCss.every(Number.isFinite) ||
          Math.hypot(directionCss[0], directionCss[1]) <= 1e-12
        )
          throw new TypeError('タグ向きのCSS変換結果が不正です。');
        return (Math.atan2(directionCss[1], directionCss[0]) * 180) / Math.PI;
      };
      // 初期位置は部材種別ごとに部材bboxの外側へ逃がし、タグが部材を隠さないようにする。
      // 保存・ドラッグの基準(defaultAnchorModel)も同じ位置のSTB model座標にそろえる。
      const defaultOriginCss = computeDefaultTagOriginCss({
        elementType: entry.record.ref.elementType,
        points: entry.cssPoints,
        centerCss: entry.centerCss,
        bbox: {
          minX: entry.cssMinX,
          minY: entry.cssMinY,
          maxX: entry.cssMaxX,
          maxY: entry.cssMaxY,
        },
        // 符号方向モードで初期位置・保存アンカーが変わらないよう、回転前の範囲で見積もる。
        extent: estimateTagExtent(plan, {
          fontSize: labelFontSize,
          paperMmToCss: Number.isFinite(paperMmToCss) && paperMmToCss > 0 ? paperMmToCss : 1,
        }),
        fontSize: labelFontSize,
      });
      const defaultAnchorModel = transformPoint(invertAffine(modelToCss), defaultOriginCss);
      const placementContext = Object.freeze({
        ref: Object.freeze({ ...entry.record.ref }),
        elementKey: entry.record.key,
        template: plan.template,
        defaultAnchorModel: Object.freeze([...defaultAnchorModel]),
      });
      const placement =
        typeof resolveTagPlacement === 'function' ? resolveTagPlacement(placementContext) : null;
      const anchorModel = placement?.anchorModel || defaultAnchorModel;
      const anchorCss = placement ? transformPoint(modelToCss, anchorModel) : defaultOriginCss;
      const offsetCss =
        placement && typeof tagOffsetToCss === 'function'
          ? tagOffsetToCss(placement.offsetModel || [0, 0])
          : [0, 0];
      if (!Array.isArray(offsetCss) || offsetCss.length !== 2 || !offsetCss.every(Number.isFinite))
        throw new TypeError('タグ配置オフセットのCSS変換結果が不正です。');
      const originCss = [anchorCss[0] + offsetCss[0], anchorCss[1] + offsetCss[1]];

      if (
        placement?.leader &&
        Math.hypot(originCss[0] - entry.centerCss[0], originCss[1] - entry.centerCss[1]) > 1e-9
      ) {
        const leaderScale = Number.isFinite(paperMmToCss) && paperMmToCss > 0 ? paperMmToCss : 1;
        entry.group.append(
          create('line', {
            class: 'stb-drawing-tag-leader',
            x1: entry.centerCss[0],
            y1: entry.centerCss[1],
            x2: originCss[0],
            y2: originCss[1],
            stroke: elementColor || DEFAULT_TAG_COLOR,
            'stroke-width': 0.35 * leaderScale,
            ...(displayType ? { 'data-drawing-layer': displayType } : {}),
            'pointer-events': 'none',
          }),
        );
      }

      const tagNodes = renderTagSvg({
        plan,
        originCss,
        fontSize: labelFontSize,
        strokeWidth: labelStrokeWidth,
        paperMmToCss,
        document: domDocument,
        ...(elementColor ? { color: elementColor } : {}),
      });
      const rotationDeg = Number(placement?.rotationDeg || 0);
      const memberRotationCssDeg =
        normalizedTagOrientationMode === DRAWING_TAG_ORIENTATION_MODES.FOLLOW_MEMBER &&
        LINE_ALIGNED_TAG_ELEMENT_TYPES.has(String(entry.record.ref.elementType))
          ? (() => {
              const direction = describeLineMember(entry.cssPoints).direction;
              return (Math.atan2(direction[1], direction[0]) * 180) / Math.PI;
            })()
          : null;
      const rotationCssDeg =
        memberRotationCssDeg == null
          ? cssRotationFor(rotationDeg)
          : memberRotationCssDeg + rotationDeg;
      const editable = typeof onTagPointerDown === 'function';
      if (Math.abs(rotationCssDeg) > 1e-12 || editable) {
        const tagGroup = create('g', {
          class: 'stb-drawing-tag',
          'data-tag-element-key': entry.record.key,
          'data-tag-template-id': plan.template.id,
          'data-tag-template-version': plan.template.version,
          'data-tag-orientation-mode': normalizedTagOrientationMode,
          ...(displayType ? { 'data-drawing-layer': displayType } : {}),
          ...(editable ? { 'data-tag-editable': 'true' } : {}),
        });
        if (Math.abs(rotationCssDeg) > 1e-12)
          tagGroup.setAttribute(
            'transform',
            `rotate(${rotationCssDeg} ${originCss[0]} ${originCss[1]})`,
          );
        tagGroup.append(...tagNodes);
        if (editable) {
          const setInteractive = (node) => {
            if (typeof node?.setAttribute === 'function')
              node.setAttribute('pointer-events', 'all');
            for (const child of node?.children || []) setInteractive(child);
          };
          tagNodes.forEach(setInteractive);
          tagGroup.addEventListener('pointerdown', (event) => {
            if (event.button != null && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            onTagPointerDown(event, {
              ...placementContext,
              placement,
              originCss: [...originCss],
            });
          });
          tagGroup.addEventListener('click', (event) => event.stopPropagation());
        }
        if (editable) {
          if (!editableTagLayer) {
            editableTagLayer = create('g', { class: 'stb-drawing-tag-layer' });
            svg.append(editableTagLayer);
          }
          editableTagLayer.append(tagGroup);
        } else {
          entry.group.append(tagGroup);
        }
      } else {
        entry.group.append(...tagNodes);
      }
    }
  }
  if (measurementLayer.childNodes.length) svg.append(measurementLayer);
  return svg;
}
