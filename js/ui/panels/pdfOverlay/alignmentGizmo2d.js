/** @fileoverview PDF上のSTB位置合わせ用2D translate gizmo。表示変換のみを操作する。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function create(svg, tag, attrs = {}) {
  const node = svg.ownerDocument.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

export function appendAlignmentCandidateMarkers(
  svg,
  candidates,
  modelToCss,
  { maxMarkers = 400 } = {},
) {
  if (!svg || !Array.isArray(candidates) || !Array.isArray(modelToCss)) return null;
  const group = create(svg, 'g', {
    class: 'pdf-overlay-candidate-markers',
    'pointer-events': 'none',
  });
  let count = 0;
  for (const candidate of candidates) {
    if (count >= maxMarkers) break;
    const [x, y] = candidate.point;
    const px = modelToCss[0] * x + modelToCss[2] * y + modelToCss[4];
    const py = modelToCss[1] * x + modelToCss[3] * y + modelToCss[5];
    const marker = create(svg, 'circle', {
      cx: px,
      cy: py,
      r: candidate.type === 'grid' ? 4.5 : 3,
      class: `pdf-overlay-candidate pdf-overlay-candidate-${candidate.type}`,
    });
    group.append(marker);
    count++;
  }
  svg.append(group);
  return group;
}

export function appendAlignmentGizmo(
  svg,
  originCss,
  { onDragStart = null, onDragMove = null, onDragEnd = null } = {},
) {
  if (
    !svg ||
    !Array.isArray(originCss) ||
    originCss.length !== 2 ||
    !originCss.every(Number.isFinite)
  )
    return null;
  const [x, y] = originCss;
  const group = create(svg, 'g', {
    class: 'pdf-overlay-gizmo',
    transform: `translate(${x} ${y})`,
  });

  const origin = create(svg, 'circle', {
    cx: 0,
    cy: 0,
    r: 7,
    class: 'pdf-overlay-gizmo-origin',
    'data-axis': 'xy',
  });
  const xLine = create(svg, 'line', {
    x1: 8,
    y1: 0,
    x2: 48,
    y2: 0,
    class: 'pdf-overlay-gizmo-axis pdf-overlay-gizmo-axis-x',
    'data-axis': 'x',
  });
  const xHead = create(svg, 'polygon', {
    points: '48,0 38,-6 38,6',
    class: 'pdf-overlay-gizmo-axis pdf-overlay-gizmo-axis-x',
    'data-axis': 'x',
  });
  const yLine = create(svg, 'line', {
    x1: 0,
    y1: -8,
    x2: 0,
    y2: -48,
    class: 'pdf-overlay-gizmo-axis pdf-overlay-gizmo-axis-y',
    'data-axis': 'y',
  });
  const yHead = create(svg, 'polygon', {
    points: '0,-48 -6,-38 6,-38',
    class: 'pdf-overlay-gizmo-axis pdf-overlay-gizmo-axis-y',
    'data-axis': 'y',
  });

  for (const node of [origin, xLine, xHead, yLine, yHead]) group.append(node);
  svg.append(group);

  const start = (event) => {
    if (event.button !== 0) return;
    const axis = event.currentTarget.getAttribute('data-axis') || 'xy';
    event.preventDefault();
    event.stopPropagation();
    const sx = event.clientX;
    const sy = event.clientY;
    const eventTarget = svg.ownerDocument?.defaultView || globalThis;
    onDragStart?.({ axis, event });

    const move = (e) => {
      let dx = e.clientX - sx;
      let dy = e.clientY - sy;
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      onDragMove?.({ axis, dx, dy, event: e });
    };
    const end = (e) => {
      eventTarget.removeEventListener('pointermove', move);
      eventTarget.removeEventListener('pointerup', end);
      let dx = e.clientX - sx;
      let dy = e.clientY - sy;
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      onDragEnd?.({ axis, dx, dy, event: e });
    };
    eventTarget.addEventListener('pointermove', move);
    eventTarget.addEventListener('pointerup', end, { once: true });
  };

  for (const node of [origin, xLine, xHead, yLine, yHead])
    node.addEventListener('pointerdown', start);
  return group;
}
