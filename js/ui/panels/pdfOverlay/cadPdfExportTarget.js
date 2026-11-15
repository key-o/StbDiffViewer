/**
 * #510: Save the surface explicitly selected in the CAD workspace.
 * Merely having a PDF loaded must never turn an STB elevation export into
 * a capture of the source PDF (nor should a missing SVG silently fall back).
 */
export function resolveCadPdfExportTarget({ displayMode, pdfPageReady, sheetReady } = {}) {
  if (displayMode === 'stb') return sheetReady ? 'sheet' : null;
  if (displayMode === 'pdf') return pdfPageReady ? 'annotated' : null;
  return null;
}

function samePhysicalSheetLayout(expected, actual) {
  if (!expected || !actual) return false;
  const keys = [
    'paper',
    'orientation',
    'scaleDenominator',
    'drawingRotationDeg',
    'widthMm',
    'heightMm',
  ];
  if (keys.some((key) => expected[key] !== actual[key])) return false;
  const a = expected.modelToPaper;
  const b = actual.modelToPaper;
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}

/**
 * Fail closed if the user replaced the preview while SHA-256 was checked.
 * Layout identity is checked as well as DrawingModel identity because the
 * sheet's scale/rotation can be changed without replacing the drawing.
 */
export function assertCadSheetPdfExportUnchanged({
  expectedDrawing,
  expectedLayout,
  expectedReferenceDrawings,
  expectedSvg,
  drawing,
  layout,
  referenceDrawings,
  svg,
  displayMode,
  allowEquivalentLayout = false,
} = {}) {
  const layoutChanged =
    layout !== expectedLayout &&
    !(allowEquivalentLayout && samePhysicalSheetLayout(expectedLayout, layout));
  const referencesChanged =
    expectedReferenceDrawings != null &&
    (!Array.isArray(referenceDrawings) ||
      referenceDrawings.length !== expectedReferenceDrawings.length ||
      expectedReferenceDrawings.some((reference, index) => reference !== referenceDrawings[index]));
  // SVG elements are real DOM nodes in production; test doubles may only model querySelector.
  const svgChanged = expectedSvg?.nodeType === 1 && svg !== expectedSvg;
  if (
    displayMode !== 'stb' ||
    drawing !== expectedDrawing ||
    layoutChanged ||
    referencesChanged ||
    svgChanged
  ) {
    throw new Error(
      'PDF保存中にビューまたは用紙配置が変更されました。現在のビューで再保存してください。',
    );
  }
}
