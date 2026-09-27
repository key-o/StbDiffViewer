/** @fileoverview DrawingModelを選択可能なSVGへ変換。PDF Canvasとは別レイヤ。 */
import {
  assertMatrix,
  isDirectSimilarity,
  multiplyAffine,
  transformPoint,
} from '../../data/drawing/affine2d.js';
import { elementRefKey } from '../../data/drawing/drawingModel.js';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** PDF.jsのCSS viewportを受け取る。DPRを掛けた行列を渡さないこと。 */
export function renderDrawingSvg({
  drawing,
  registration,
  pdfToCss,
  width,
  height,
  document: domDocument = globalThis.document,
  onSelect = null,
  showLabels = true,
  labelFontSize = 12,
  labelStrokeWidth = 3,
} = {}) {
  if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm')
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  if (!isDirectSimilarity(registration))
    throw new TypeError('位置合わせには反転のない相似変換を指定してください。');
  assertMatrix(pdfToCss);
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    throw new RangeError('SVG表示寸法が不正です。');
  if (typeof domDocument?.createElementNS !== 'function')
    throw new TypeError('SVG生成用Documentが必要です。');
  if (onSelect != null && typeof onSelect !== 'function')
    throw new TypeError('部材選択callbackが不正です。');
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
  const modelToCss = multiplyAffine(pdfToCss, registration);

  const annotationGroup = create('g', {
    class: 'stb-drawing-annotations',
    'pointer-events': 'none',
  });
  const annotationStyle = (role) => {
    if (role === 'grid') return { stroke: '#607d8b', width: 0.8, dash: '6 4' };
    if (role === 'grid-label') return { fill: '#455a64', fontSize: labelFontSize };
    if (role === 'dimension-text') return { fill: '#424242', fontSize: Math.max(2.5, labelFontSize * 0.85) };
    if (role === 'dimension-overall') return { stroke: '#424242', width: 1.2 };
    if (role === 'dimension' || role === 'dimension-extension' || role === 'dimension-tick')
      return { stroke: '#616161', width: 0.9 };
    return { stroke: '#616161', width: 0.9, fill: '#424242', fontSize: 9 };
  };
  for (const annotation of drawing.annotations || []) {
    const style = annotationStyle(annotation.role);
    if (annotation.kind === 'line') {
      if (!Array.isArray(annotation.points) || annotation.points.length !== 2)
        throw new TypeError('注記lineの点列が不正です。');
      const [a, b] = annotation.points.map((point) => transformPoint(modelToCss, point));
      const attrs = {
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: style.stroke,
        'stroke-width': style.width,
        'vector-effect': 'non-scaling-stroke',
      };
      if (style.dash) attrs['stroke-dasharray'] = style.dash;
      annotationGroup.append(create('line', attrs));
      continue;
    }
    if (annotation.kind === 'text') {
      if (!Array.isArray(annotation.point) || annotation.point.length !== 2)
        throw new TypeError('注記textの位置が不正です。');
      const [x, y] = transformPoint(modelToCss, annotation.point);
      const node = create('text', {
        x, y,
        'text-anchor': annotation.anchor || 'middle',
        'dominant-baseline': 'central',
        'font-size': style.fontSize || Math.max(2.5, labelFontSize * 0.85),
        fill: style.fill || '#424242',
        'paint-order': 'stroke',
        stroke: 'white',
        'stroke-width': Math.max(0.6, labelStrokeWidth * 0.75),
        'stroke-linejoin': 'round',
        'pointer-events': 'none',
      });
      if (Number.isFinite(annotation.rotationDeg))
        node.setAttribute('transform', `rotate(${annotation.rotationDeg} ${x} ${y})`);
      node.textContent = annotation.text || '';
      annotationGroup.append(node);
      continue;
    }
    throw new TypeError(`未対応の注記図形です: ${annotation.kind}`);
  }
  if (annotationGroup.childNodes.length) svg.insertBefore(annotationGroup, svg.firstChild);

  const records = new Map(drawing.elements.map((record) => [record.key, record]));
  const groups = new Map();
  for (const primitive of drawing.primitives) {
    if (
      primitive.kind !== 'polyline' ||
      !Array.isArray(primitive.points) ||
      primitive.points.length < 2
    )
      throw new TypeError('未対応の図形です。');
    const record = records.get(primitive.elementKey);
    if (!record || record.state !== 'drawn' || elementRefKey(primitive.ref) !== record.key)
      throw new Error('図形から元部材への参照が不正です。');
    let entry = groups.get(record.key);
    if (!entry) {
      const group = create('g', {
        'data-element-key': record.key,
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
      entry = { group, record, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      groups.set(record.key, entry);
      svg.append(group);
    }
    const points = primitive.points.map((point) => transformPoint(modelToCss, point));
    for (const [x, y] of points) {
      entry.minX = Math.min(entry.minX, x);
      entry.minY = Math.min(entry.minY, y);
      entry.maxX = Math.max(entry.maxX, x);
      entry.maxY = Math.max(entry.maxY, y);
    }
    const path = create('path', {
      d:
        points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ') +
        (primitive.closed ? ' Z' : ''),
      fill: 'none',
      stroke: '#087f8c',
      'stroke-width': 1.5,
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'all',
    });
    entry.group.append(path);
  }
  if (showLabels) {
    for (const entry of groups.values()) {
      const label = create('text', {
        x: (entry.minX + entry.maxX) / 2,
        y: (entry.minY + entry.maxY) / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': labelFontSize,
        fill: '#075963',
        'paint-order': 'stroke',
        stroke: 'white',
        'stroke-width': labelStrokeWidth,
        'stroke-linejoin': 'round',
        'pointer-events': 'none',
      });
      // 原本の符号はHTMLとして解釈しない。表示座標で文字を置きY反転しない。
      label.textContent =
        entry.record.mark || `${entry.record.ref.elementType} ${entry.record.ref.elementId}`;
      entry.group.append(label);
    }
  }
  return svg;
}
