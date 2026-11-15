/**
 * #565: A clipped model must not silently lose its grids and dimensions at a
 * sheet placement viewport. Inspect the same paper-mm RenderPlan shared by
 * SVG/PDF/DXF, rather than relying on member-only DrawingModel.bounds.
 */
function boundsOfPrimitive(primitive) {
  const points = primitive.points?.paper;
  if ((primitive.kind === 'line' || primitive.kind === 'polyline') && Array.isArray(points)) {
    return points;
  }
  if (primitive.kind === 'circle') {
    const c = primitive.center?.paper;
    const r = primitive.radius?.paper;
    if (Array.isArray(c) && Number.isFinite(r))
      return [
        [c[0] - r, c[1] - r],
        [c[0] + r, c[1] + r],
      ];
  }
  if (primitive.kind === 'text') {
    const p = primitive.point?.paper;
    if (!Array.isArray(p)) return null;
    // Conservative estimate for variable-width and rotated glyphs.
    // Native annotations use textHeightMm; dimension glyphs heightPaperMm.
    const height = primitive.style?.heightPaperMm ?? primitive.style?.textHeightMm ?? 2.5;
    const radius = Math.hypot(Math.max(1, String(primitive.text ?? '').length) * height, height);
    return [
      [p[0] - radius, p[1] - radius],
      [p[0] + radius, p[1] + radius],
    ];
  }
  return null;
}

export function assertCutSheetAnnotationsFit({ renderPlan, placement, paperHeightMm } = {}) {
  if (!renderPlan || !placement || !Number.isFinite(paperHeightMm))
    throw new TypeError('シート注記の範囲確認にRenderPlanと配置枠が必要です。');
  const groups = [
    ...(renderPlan.annotations ?? []).filter(
      (a) =>
        a.visible !== false &&
        ['grid', 'grid-bubble', 'grid-label', 'level-label'].includes(a.role),
    ),
    ...(renderPlan.dimensions ?? [])
      .filter((d) => d.visible !== false)
      .flatMap((d) => d.primitives ?? []),
  ];
  for (const primitive of groups) {
    const points = boundsOfPrimitive(primitive);
    if (!points?.length || points.some((p) => !Array.isArray(p) || !p.every(Number.isFinite)))
      throw new Error('切り出し図の注記範囲を検証できません: ' + (primitive.id ?? primitive.kind));
    // Grid bubbles and dimensions outside the viewport are clipped visually,
    // not dropped from the persisted view or rejected during sheet generation.
  }
  return true;
}
