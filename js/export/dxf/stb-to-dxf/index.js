/**
 * @fileoverview STB→DXFエクスポーター公開API
 *
 * stb-to-dxf ディレクトリ内のモジュールを統合し、外部向けAPIを提供します。
 */

// プロバイダー設定
export {
  setDxfExporterProviders,
  EXPORTABLE_ELEMENT_TYPES,
  ELEMENT_TYPE_COLORS,
} from './DxfProviders.js';

// メインエクスポート機能
export { canExportStbToDxf, exportStbToDxf, getStbExportStats } from './StbToDxfExporter.js';

// バッチエクスポート機能
export {
  canExportAllStoriesToDxf,
  exportAllStoriesToDxf,
  exportAlongAllAxesToDxf,
  exportAlongAllAxesBothDirections,
  getAvailableStories,
  getAvailableAxes,
} from './DxfBatchExporter.js';

// ジオメトリ収集機能（必要に応じて使用）
export {
  detectViewDirection,
  projectPointTo2D,
  isPointWithinClippingBounds,
  extractEdgesFromMesh,
  collectLabelSprites,
  collectAxisLines,
  generateAxisLinesAtClippingHeight,
  collectLevelLines,
} from './DxfGeometryCollector.js';

// DXFフォーマット書き込み機能（必要に応じて使用）
export {
  generateHeader,
  generateTables,
  generateBlocks,
  generateLine,
  generateCircle,
  generateText,
  generateEntities,
  generateDxfContent,
  createDxfBlob,
  decodeR12UnicodeEscapes,
  DXF_OUTPUT_PROFILES,
  normalizeDxfOutputProfile,
  downloadDxf,
} from './DxfFormatWriter.js';

// グローバル登録のためのインポート
import { canExportStbToDxf, exportStbToDxf, getStbExportStats } from './StbToDxfExporter.js';
import {
  canExportAllStoriesToDxf,
  exportAllStoriesToDxf,
  exportAlongAllAxesToDxf,
  exportAlongAllAxesBothDirections,
  getAvailableStories,
  getAvailableAxes,
} from './DxfBatchExporter.js';

// グローバルに登録
if (typeof window !== 'undefined') {
  window.canExportStbToDxf = canExportStbToDxf;
  window.exportStbToDxf = exportStbToDxf;
  window.getStbExportStats = getStbExportStats;
  window.canExportAllStoriesToDxf = canExportAllStoriesToDxf;
  window.exportAllStoriesToDxf = exportAllStoriesToDxf;
  window.exportAlongAllAxesToDxf = exportAlongAllAxesToDxf;
  window.exportAlongAllAxesBothDirections = exportAlongAllAxesBothDirections;
  window.getAvailableStories = getAvailableStories;
  window.getAvailableAxes = getAvailableAxes;
}
