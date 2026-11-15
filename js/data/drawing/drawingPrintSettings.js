/**
 * #565: Project-level print settings for the CAD sheet PDF (line width, line pattern,
 * color mode, vector/raster output).
 *
 * The settings travel with the DrawingProject so a reopened ZIP prints the same way. They only
 * change how the already-compiled sheet SVG is styled for PDF; geometry and DXF are untouched.
 * `printSettings` is optional: a project without it behaves as before (the output tab's own
 * controls decide), so older projects round-trip unchanged. The page margin is the sheet frame's
 * `marginMm` (see drawingSheetFrame.js), not a print setting.
 */

export const PRINT_LINE_WIDTH_PRESETS = Object.freeze({
  svg: '画面の線幅のまま',
  thin: '細め（標準）',
  fine: 'さらに細く',
  legacy: '従来の線幅',
});
export const PRINT_LINE_PATTERNS = Object.freeze({
  svg: '図面の線種どおり',
  solid: 'すべて実線',
});
export const PRINT_COLOR_MODES = Object.freeze({
  color: 'カラー',
  monochrome: 'モノクロ（黒）',
});
export const PRINT_EXPORT_MODES = Object.freeze({
  vector: 'ベクター（推奨）',
  raster: 'ラスタ（互換）',
});

const FIELDS = Object.freeze({
  lineWidthPreset: PRINT_LINE_WIDTH_PRESETS,
  linePattern: PRINT_LINE_PATTERNS,
  colorMode: PRINT_COLOR_MODES,
  exportMode: PRINT_EXPORT_MODES,
});

function invalid(path, message) {
  const error = new Error(`DrawingProject schema error at ${path}: ${message}`);
  error.code = 'INVALID_PRINT_SETTINGS';
  error.path = path;
  throw error;
}

/** Returns undefined when absent or empty, so projects without settings round-trip unchanged. */
export function normalizePrintSettings(value, path = 'printSettings') {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'object required');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(FIELDS, key)) invalid(`${path}.${key}`, 'unknown field');
    if (!Object.hasOwn(FIELDS[key], entry))
      invalid(`${path}.${key}`, 'one of ' + Object.keys(FIELDS[key]).join(', '));
    result[key] = entry;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Effective options for one export. `fallback` is what the output tab's controls currently say;
 * saved project settings win field by field.
 */
export function resolveSheetPrintOptions(settings, fallback = {}) {
  const pick = (key, base) => settings?.[key] ?? fallback[key] ?? base;
  return {
    printOptions: {
      lineWidthPreset: pick('lineWidthPreset', 'thin'),
      linePattern: pick('linePattern', 'svg'),
      colorMode: pick('colorMode', 'color'),
    },
    mode: pick('exportMode', 'vector'),
  };
}
