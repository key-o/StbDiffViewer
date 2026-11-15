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
  {
    onDragStart = null,
    onDragMove = null,
    onDragEnd = null,
    onDragCancel = null,
    axisDirections = null,
  } = {},
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

  // Existing PDF gizmo keeps its screen-aligned axes. CAD passes model-axis directions
  // so X/Y handles still represent STB axes on rotated / mirrored drawing sheets.
  const normalize = (direction) => {
    const values = Array.isArray(direction) ? direction.map(Number) : [];
    const norm = Math.hypot(...values);
    return values.length === 2 && Number.isFinite(norm) && norm > 1e-12
      ? values.map((v) => v / norm)
      : null;
  };
  const xAxis = normalize(axisDirections?.[0]) || [1, 0];
  const yAxis = normalize(axisDirections?.[1]) || [0, -1];
  const xAngle = (Math.atan2(xAxis[1], xAxis[0]) * 180) / Math.PI;
  const yAngle = (Math.atan2(yAxis[1], yAxis[0]) * 180) / Math.PI + 90;
  for (const node of [xLine, xHead]) node.setAttribute('transform', `rotate(${xAngle})`);
  for (const node of [yLine, yHead]) node.setAttribute('transform', `rotate(${yAngle})`);
  for (const node of [origin, xLine, xHead, yLine, yHead]) group.append(node);
  svg.append(group);

  const start = (event) => {
    if (event.button !== 0) return;
    const axis = event.currentTarget.getAttribute('data-axis') || 'xy';
    event.preventDefault();
    event.stopPropagation();
    const sx = event.clientX;
    const sy = event.clientY;
    const pointerId = event.pointerId;
    const eventTarget = svg.ownerDocument?.defaultView || globalThis;
    const constrain = (e) => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (axis === 'xy') return { dx, dy };
      const basis = axis === 'x' ? xAxis : yAxis;
      const component = dx * basis[0] + dy * basis[1];
      return { dx: component * basis[0], dy: component * basis[1] };
    };
    let ended = false;
    const cleanup = () => {
      eventTarget.removeEventListener('pointermove', move);
      eventTarget.removeEventListener('pointerup', end);
      eventTarget.removeEventListener('pointercancel', cancel);
      eventTarget.removeEventListener('keydown', keydown, true);
      eventTarget.removeEventListener('blur', cancel);
    };
    const matchPointer = (e) =>
      pointerId == null || e?.pointerId == null || e.pointerId === pointerId;
    const move = (e) => {
      if (ended || !matchPointer(e)) return;
      onDragMove?.({ axis, ...constrain(e), event: e });
    };
    const end = (e) => {
      if (ended || !matchPointer(e)) return;
      ended = true;
      cleanup();
      onDragEnd?.({ axis, ...constrain(e), event: e });
    };
    const cancel = (e) => {
      if (ended || (e?.type === 'pointercancel' && !matchPointer(e))) return;
      ended = true;
      cleanup();
      onDragCancel?.({ axis, event: e });
    };
    const keydown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel(e);
    };
    onDragStart?.({ axis, event });
    eventTarget.addEventListener('pointermove', move);
    eventTarget.addEventListener('pointerup', end);
    eventTarget.addEventListener('pointercancel', cancel);
    eventTarget.addEventListener('keydown', keydown, true);
    eventTarget.addEventListener('blur', cancel);
  };

  // A completed gizmo gesture must not trigger the CAD canvas click tools.
  group.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  for (const node of [origin, xLine, xHead, yLine, yHead])
    node.addEventListener('pointerdown', start);
  return group;
}
