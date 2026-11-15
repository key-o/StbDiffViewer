/** S形鋼の2D断面を mm の輪郭として正規化し、SVG/DXFで共有する。 */
const rect = (x, y, width, height) => ({ kind: 'rect', x, y, width, height });

export function steelSectionProfileParts(profile) {
  if (!profile) return null;
  const { family, A, B, D, t, t1, t2 } = profile;
  if (family === 'H' && A > 0 && B > 0 && t1 > 0 && t2 > 0 && t1 < B && t2 * 2 < A) {
    return {
      width: B,
      height: A,
      parts: [rect(0, 0, B, t2), rect((B - t1) / 2, t2, t1, A - 2 * t2), rect(0, A - t2, B, t2)],
    };
  }
  if (family === 'BOX' && A > 0 && B > 0) {
    const tx = t || t1;
    const ty = t || t2;
    if (!(tx > 0 && ty > 0 && tx * 2 < B && ty * 2 < A)) return null;
    return {
      width: B,
      height: A,
      parts: [
        rect(0, 0, B, ty),
        rect(0, A - ty, B, ty),
        rect(0, ty, tx, A - 2 * ty),
        rect(B - tx, ty, tx, A - 2 * ty),
      ],
    };
  }
  if (family === 'PIPE' && D > 0 && t > 0 && t * 2 < D) {
    return {
      width: D,
      height: D,
      parts: [{ kind: 'ring', cx: D / 2, cy: D / 2, outer: D / 2, inner: D / 2 - t }],
    };
  }
  return null;
}

export function steelProfileSvg(profile, scaleDenominator = 40) {
  const geo = steelSectionProfileParts(profile);
  if (!geo) return '<div class="steel-section-unavailable">断面形状未対応（形状名を参照）</div>';
  const pad = Math.max(geo.width, geo.height) * 0.08;
  const mmToPx = 96 / 25.4 / Math.max(1, Number(scaleDenominator) || 40);
  const parts = geo.parts
    .map((part) =>
      part.kind === 'ring'
        ? `<circle cx="${part.cx}" cy="${part.cy}" r="${(part.outer + part.inner) / 2}" fill="none" stroke="currentColor" stroke-width="${part.outer - part.inner}"/>`
        : `<rect x="${part.x}" y="${part.y}" width="${part.width}" height="${part.height}" fill="currentColor"/>`,
    )
    .join('');
  return `<svg class="steel-section-profile" role="img" aria-label="鋼材断面形状" viewBox="${-pad} ${-pad} ${geo.width + 2 * pad} ${geo.height + 2 * pad}" width="${(geo.width + 2 * pad) * mmToPx}" height="${(geo.height + 2 * pad) * mmToPx}" preserveAspectRatio="xMidYMid meet">${parts}</svg>`;
}

/** DXF/ReferenceDrawingモデルmm座標へ投影する。リングは外周・内周とも円として保持。 */
export function appendSteelProfileEntities(geo, cx, cy, lines2D, circles2D, layer = 'CONCRETE') {
  if (!geo) return;
  const x0 = cx - geo.width / 2,
    y0 = cy - geo.height / 2;
  for (const p of geo.parts) {
    if (p.kind === 'ring') {
      circles2D.push({ center: { x: x0 + p.cx, y: y0 + p.cy }, radius: p.outer, layer });
      circles2D.push({ center: { x: x0 + p.cx, y: y0 + p.cy }, radius: p.inner, layer });
    } else {
      const x = x0 + p.x,
        y = y0 + p.y,
        w = p.width,
        h = p.height;
      lines2D.push(
        { start: { x, y }, end: { x: x + w, y }, layer },
        { start: { x: x + w, y }, end: { x: x + w, y: y + h }, layer },
        { start: { x: x + w, y: y + h }, end: { x, y: y + h }, layer },
        { start: { x, y: y + h }, end: { x, y }, layer },
      );
    }
  }
}
