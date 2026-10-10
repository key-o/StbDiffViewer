/**
 * @fileoverview 構造平面図DXF用の閉ポリライン対応Writer
 *
 * 既存DxfFormatWriterのR12互換HEADER/TABLES/BLOCKS/LINE/TEXT/CIRCLEを再利用し、
 * 平面断面輪郭だけPOLYLINE/VERTEX/SEQENDで閉ループとして追加する。
 */

import {
  generateHeader,
  generateTables,
  generateBlocks,
  generateLine,
  generateCircle,
  generateArc,
  generateText,
  downloadDxf,
} from './DxfFormatWriter.js';

function formatCode(code) {
  return String(code).padStart(3, ' ');
}

function encodeR12String(value) {
  const source = String(value);
  let encoded = '';
  for (let index = 0; index < source.length; index++) {
    const codeUnit = source.charCodeAt(index);
    encoded +=
      codeUnit <= 0x7f
        ? source[index]
        : `\\U+${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

function dxfPair(code, value) {
  return `${formatCode(code)}\n${typeof value === 'string' ? encodeR12String(value) : value}`;
}

function addPairs(arr, ...pairs) {
  for (const [code, value] of pairs) {
    arr.push(dxfPair(code, value));
  }
}

/**
 * AutoCAD R12互換の2D POLYLINEを生成する。
 * @param {{points:Array<{x:number,y:number}>,layer:string,closed?:boolean}} polyline
 * @returns {string}
 */
export function generatePolyline(polyline) {
  const points = polyline?.points || [];
  if (points.length < 2) return '';

  const layer = polyline.layer || '0';
  const lines = [];
  addPairs(lines, [0, 'POLYLINE'], [8, layer]);
  if (polyline.lineType && polyline.lineType !== 'CONTINUOUS')
    addPairs(lines, [6, polyline.lineType]);
  addPairs(
    lines,
    [66, 1],
    [10, '0.0'],
    [20, '0.0'],
    [30, '0.0'],
    [70, polyline.closed === false ? 0 : 1],
  );

  for (const [index, point] of points.entries()) {
    addPairs(
      lines,
      [0, 'VERTEX'],
      [8, layer],
      [10, Number(point.x).toFixed(6)],
      [20, Number(point.y).toFixed(6)],
      [30, '0.0'],
      [70, 0],
    );
    const bulge = Number(polyline.bulges?.[index] || 0);
    if (Number.isFinite(bulge) && Math.abs(bulge) > 1e-12) addPairs(lines, [42, bulge.toFixed(12)]);
  }

  addPairs(lines, [0, 'SEQEND'], [8, layer]);
  return lines.join('\n');
}

/**
 * 閉ポリラインを含むENTITIESセクションを生成する。
 * @param {Array} lines2D
 * @param {Array} polylines2D
 * @param {Array} texts2D
 * @param {Array} circles2D
 * @returns {string}
 */
export function generatePlanEntities(
  lines2D = [],
  polylines2D = [],
  texts2D = [],
  circles2D = [],
  arcs2D = [],
) {
  const entities = [];
  addPairs(entities, [0, 'SECTION'], [2, 'ENTITIES']);

  for (const line of lines2D) entities.push(generateLine(line));
  for (const polyline of polylines2D) {
    const entity = generatePolyline(polyline);
    if (entity) entities.push(entity);
  }
  for (const circle of circles2D) entities.push(generateCircle(circle));
  for (const arc of arcs2D) entities.push(generateArc(arc));
  for (const text of texts2D) entities.push(generateText(text));

  addPairs(entities, [0, 'ENDSEC']);
  return entities.join('\n');
}

/**
 * R12互換の構造平面図DXF全体を生成する。
 * @param {Object} bounds
 * @param {Array<string>} layers
 * @param {Array} lines2D
 * @param {Array} polylines2D
 * @param {Array} texts2D
 * @param {Array} circles2D
 * @returns {string}
 */
export function generatePlanDxfContent(
  bounds,
  layers,
  lines2D = [],
  polylines2D = [],
  texts2D = [],
  circles2D = [],
  lineTypes = [],
  arcs2D = [],
  options = {},
) {
  return [
    generateHeader(bounds),
    generateTables(layers, texts2D.length > 0, bounds, lineTypes, options.textStyle),
    generateBlocks(),
    generatePlanEntities(lines2D, polylines2D, texts2D, circles2D, arcs2D),
    dxfPair(0, 'EOF'),
  ].join('\n');
}

export { downloadDxf };
