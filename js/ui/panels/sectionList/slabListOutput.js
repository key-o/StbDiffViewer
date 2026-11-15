/**
 * #530 RC slab schedule: a single, validated source snapshot and paper-mm plan
 * shared by CSV, SVG, PDF and DXF. None of these derived objects is persisted.
 */
import { zipSync, strToU8 } from 'fflate';
import { generateDxfContent, downloadDxf } from '../../../export/dxf/stb-to-dxf/index.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { slabDisplayField, slabCell, slabProjectionCell } from './slabListViewModel.js';

export const SLAB_OUTPUT_HEADERS = Object.freeze([
  '断面ID',
  '符号',
  '厚さ(mm)',
  '備考',
  '位置',
  '短辺上',
  '短辺下',
  '長辺上',
  '長辺下',
  '照合',
  '出典',
  '診断',
]);
const PAPER = Object.freeze({ width: 420, height: 297, margin: 12 });
// The snapshot keeps four independent reinforcement values for lossless validation.
// All human-facing outputs present those values as the two stacked faces used by the UI.
const PRESENTATION_HEADERS = Object.freeze([
  '断面ID',
  '符号',
  '厚さ(mm)',
  '備考',
  '位置',
  '短辺方向',
  '長辺方向',
  '照合',
  '出典',
  '診断',
]);
const WIDTHS = Object.freeze([27, 31, 25, 42, 24, 76, 76, 32, 30, 33]);
const FACE_COLUMNS = Object.freeze([4, 5, 6]);
const SHARED_COLUMNS = Object.freeze([0, 1, 2, 3, 7, 8, 9]);

function faceValues(row, face) {
  const values = row.values;
  const bottom = face === 'BOTTOM';
  return [
    values[0],
    values[1],
    values[2],
    values[3],
    bottom ? '下' : '上',
    values[bottom ? 6 : 5],
    values[bottom ? 8 : 7],
    values[9],
    values[10],
    values[11],
  ];
}
const HEADER_H = 13;
const LINE_H = 4.5;
const FONT_H = 3.1;

function cellText(value) {
  return value == null ? '' : String(value);
}

function joinedDiagnostics(row) {
  const result = [...(row.diagnostics || []), ...(row.sourceDiagnostics || [])];
  return result
    .map((value) => (typeof value === 'string' ? value : value?.code || ''))
    .filter(Boolean)
    .join(';');
}

/** Reject an unconfirmed source; blank cells are preserved and marked, not guessed. */
export function buildSlabOutputSnapshot(rows, { side, revision, zone = 'END' } = {}) {
  if (!['A', 'B'].includes(side) || !/^[a-f0-9]{64}$/i.test(revision || ''))
    throw new Error('出力するSTBモデルとSHA-256改訂が確定していません。');
  if (!['END', 'CENTER'].includes(zone) || !Array.isArray(rows) || !rows.length)
    throw new Error('スラブリストの出力対象または配筋表示位置が不正です。');
  const data = rows.map((row) => {
    if (row.modelSide !== side || (row.stbRevision && row.stbRevision !== revision))
      throw new Error('スラブ断面のモデル側またはSTB改訂が一致しません。');
    if (!row.auxiliary && row.section && row.stbRevision !== revision)
      throw new Error('スラブ断面のSTB改訂が未検証です。');
    if (['STALE', 'NEEDS_REVIEW'].includes(row.mapping?.state))
      throw new Error('未解決のスラブ照合があります: ' + (row.sectionId || row.id));
    if (
      row.resolvedFields &&
      Object.values(row.resolvedFields).some(
        (field) =>
          field?.status === 'CONFLICT' || (field?.conflict && field?.source !== 'OVERRIDE'),
      )
    )
      throw new Error('未解決の出典競合があります: ' + (row.sectionId || row.id));
    if (
      joinedDiagnostics(row)
        .split(';')
        .some((item) =>
          /^(?:SECTION_ID_MISSING|SECTION_ID_DUPLICATE|SECTION_ID_MISSING_OR_DUPLICATE|AUXILIARY_SYMBOL_DUPLICATE|STALE)/.test(
            item,
          ),
        )
    )
      throw new Error('確定できない断面または重複符号があります: ' + (row.id || ''));
    const unzoned =
      row.auxiliary?.barLayout === '2WAY_202' ||
      (row.section?.barPattern === '2WAY' &&
        String(row.section?.version || '').startsWith('2.0.2'));
    const oneWay = ['1WAY1', '1WAY2'].includes(row.auxiliary?.barLayout || row.section?.barPattern);
    const position = unzoned
      ? '帯区分なし'
      : oneWay
        ? '主筋方向未確定'
        : zone === 'END'
          ? '端部'
          : '中央';
    const barSources = [];
    const barStatuses = [];
    const bars = ['SHORT', 'LONG'].flatMap((direction) =>
      ['TOP', 'BOTTOM'].map((face) => {
        const result =
          unzoned && !row.auxiliary
            ? slabProjectionCell(row, row.projection?.extraCells?.[direction + '_' + face])
            : slabCell(row, direction, face, zone);
        const status = result?.state || result?.status || 'MISSING';
        barStatuses.push(status);
        if (status === 'AMBIGUOUS') return '要確認';
        if (status === 'NOT_APPLICABLE') return '対象外';
        if (status !== 'VALID') return '';
        barSources.push('配筋:' + (row.auxiliary ? 'AUXILIARY' : 'STB/OVERRIDE'));
        return cellText(result?.value ?? result?.display);
      }),
    );
    const fields = ['symbol', 'thicknessMm', 'notes'].map((field) => slabDisplayField(row, field));
    const sources = [
      ...new Set([...fields.map((field) => field.source).filter(Boolean), ...barSources]),
    ].join('/');
    const values = [
      row.sectionId || (row.auxiliary ? '補助:' + row.auxiliary.id : 'XMLのみ'),
      row.resolvedFields?.symbol ? fields[0].value : (row.symbol ?? ''),
      fields[1].value,
      fields[2].value,
      position,
      ...bars,
      row.mapping?.state || 'STB_ONLY',
      sources,
      joinedDiagnostics(row),
    ].map(cellText);
    return Object.freeze({
      id: cellText(row.id),
      sectionId: cellText(row.sectionId),
      sourceRevision: revision,
      values: Object.freeze(values),
      sources,
      diagnostics: values[11],
      fieldStatuses: Object.freeze([
        fields[0].status,
        fields[1].status,
        fields[2].status,
        ...barStatuses,
      ]),
      fieldSources: Object.freeze(fields.map((field) => field.source)),
    });
  });
  return Object.freeze({
    kind: 'slab-list',
    side,
    revision,
    zone,
    headers: SLAB_OUTPUT_HEADERS,
    rows: Object.freeze(data),
  });
}

/** Resolve a saved slab-list ViewSpec against the current, validated STB rows. */
export function produceSlabListView(rows, viewSpec, { side, revision } = {}) {
  if (
    viewSpec?.type !== 'slab-list' ||
    !['END', 'CENTER'].includes(viewSpec?.zone) ||
    !Array.isArray(viewSpec.rowIds) ||
    viewSpec.rowIds.length === 0
  )
    throw new Error('保存されたスラブリストViewSpecが不正です。');
  const requested = new Set(viewSpec.rowIds);
  if (
    requested.size !== viewSpec.rowIds.length ||
    viewSpec.rowIds.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('ViewSpecに不正または重複したスラブ行IDがあります。');
  const indexed = new Map();
  for (const row of rows) {
    if (!requested.has(row.id)) continue;
    if (indexed.has(row.id)) throw new Error('現行STBに同じスラブ行IDが重複しています: ' + row.id);
    indexed.set(row.id, row);
  }
  const selected = viewSpec.rowIds.map((id) => {
    if (!indexed.has(id)) throw new Error('保存シートのスラブ行が現行STBにありません: ' + id);
    return indexed.get(id);
  });
  const snapshot = buildSlabOutputSnapshot(selected, { side, revision, zone: viewSpec.zone });
  return { snapshot, pages: buildSlabOutputPages(snapshot) };
}

function csvEscape(value) {
  const string = cellText(value);
  // Spreadsheet formula neutralization for untrusted STB/XML strings.
  const safe =
    /^[\s\u0000-\u001f]*[=+@]/u.test(string) ||
    (/^[\s\u0000-\u001f]*-/u.test(string) && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(string))
      ? "'" + string
      : string;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function slabOutputCsv(snapshot) {
  const extra = [
    '符号状態',
    '厚さ状態',
    '備考状態',
    '短辺状態',
    '長辺状態',
    '符号出典',
    '厚さ出典',
    '備考出典',
    'モデル',
    'STB改訂',
    '帯区分',
  ];
  const lines = [[...PRESENTATION_HEADERS, ...extra]];
  for (const row of snapshot.rows) {
    for (const face of ['TOP', 'BOTTOM']) {
      const bottom = face === 'BOTTOM';
      lines.push([
        ...faceValues(row, face),
        ...row.fieldStatuses.slice(0, 3),
        row.fieldStatuses[bottom ? 4 : 3],
        row.fieldStatuses[bottom ? 6 : 5],
        ...row.fieldSources,
        snapshot.side,
        snapshot.revision,
        row.values[4],
      ]);
    }
  }
  return '\uFEFF' + lines.map((record) => record.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function charUnits(char) {
  return /^[\x00-\x7f\uff61-\uff9f]$/.test(char) ? 1 : 2;
}
function wrap(value, widthMm) {
  const limit = Math.max(2, Math.floor((widthMm - 3) / (FONT_H * 0.57)));
  const lines = [];
  for (const input of cellText(value).split(/\r?\n/)) {
    let line = '',
      units = 0;
    for (const char of input) {
      const size = charUnits(char);
      if (units + size > limit && line) {
        lines.push(line);
        line = '';
        units = 0;
      }
      line += char;
      units += size;
    }
    lines.push(line);
  }
  if (lines.length > 40) throw new Error('セルの折返しが40行を超えています。');
  return lines;
}

/** Immutable vector instructions in A3 paper millimetres, independent of DOM/zoom. */
export function buildSlabOutputPages(snapshot) {
  if (!snapshot?.rows?.length || snapshot.headers.length !== SLAB_OUTPUT_HEADERS.length)
    throw new Error('スラブリストの出力スナップショットが不正です。');
  const tableWidth = WIDTHS.reduce((sum, width) => sum + width, 0);
  if (tableWidth > PAPER.width - 2 * PAPER.margin)
    throw new Error('A3用紙幅にスラブリストが収まりません。');
  const xPositions = WIDTHS.map(
    (_, index) => PAPER.margin + WIDTHS.slice(0, index).reduce((sum, width) => sum + width, 0),
  );
  const createPage = () => ({ paper: PAPER, cells: [], ids: [], usedHeight: 0 });
  const pages = [];
  let page;
  let y;
  const appendCell = (index, cellY, height, lines, isHeader = false) => {
    page.cells.push({
      x: xPositions[index],
      y: cellY,
      width: WIDTHS[index],
      height,
      lines,
      isHeader,
    });
  };
  const headers = PRESENTATION_HEADERS.map((value, i) => wrap(value, WIDTHS[i]));
  const nextPage = () => {
    page = createPage();
    pages.push(page);
    y = 28;
    for (let index = 0; index < headers.length; index++)
      appendCell(index, y, HEADER_H, headers[index], true);
    y += HEADER_H;
    page.usedHeight = y;
  };
  nextPage();
  for (const row of snapshot.rows) {
    const top = faceValues(row, 'TOP').map((value, i) => wrap(value, WIDTHS[i]));
    const bottom = faceValues(row, 'BOTTOM').map((value, i) => wrap(value, WIDTHS[i]));
    const needed = (lines) => Math.max(10, lines.length * LINE_H + 3);
    let topHeight = Math.max(...FACE_COLUMNS.map((index) => needed(top[index])));
    let bottomHeight = Math.max(...FACE_COLUMNS.map((index) => needed(bottom[index])));
    const mergedHeight = Math.max(...SHARED_COLUMNS.map((index) => needed(top[index])));
    if (mergedHeight > topHeight + bottomHeight) {
      const extra = (mergedHeight - topHeight - bottomHeight) / 2;
      topHeight += extra;
      bottomHeight += extra;
    }
    const groupHeight = topHeight + bottomHeight;
    if (groupHeight > PAPER.height - PAPER.margin - 28 - HEADER_H)
      throw new Error('A3用紙1ページに収まらないスラブ行があります: ' + row.id);
    // Keep the two faces on the same page and merge repeated metadata vertically.
    if (y + groupHeight > PAPER.height - PAPER.margin) nextPage();
    for (const index of SHARED_COLUMNS) appendCell(index, y, groupHeight, top[index]);
    for (const index of FACE_COLUMNS) {
      appendCell(index, y, topHeight, top[index]);
      appendCell(index, y + topHeight, bottomHeight, bottom[index]);
    }
    page.ids.push(row.id);
    y += groupHeight;
    page.usedHeight = y;
  }
  return Object.freeze(
    pages.map((p) =>
      Object.freeze({
        ...p,
        cells: Object.freeze(p.cells.map((cell) => Object.freeze(cell))),
        ids: Object.freeze(p.ids),
        source: Object.freeze({
          side: snapshot.side,
          revision: snapshot.revision,
          zone: snapshot.zone,
        }),
      }),
    ),
  );
}

function esc(value) {
  return cellText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function slabPageTitle(page) {
  const source = page.source;
  return (
    'RCスラブリスト ' +
    (source
      ? source.side +
        ' Rev.' +
        source.revision.slice(0, 12) +
        ' (' +
        (source.zone === 'END' ? '端部' : '中央') +
        ')'
      : '')
  );
}

export function slabPageSvg(page, { title = slabPageTitle(page) } = {}) {
  const body = page.cells
    .map((cell) => {
      const lineStart = cell.y + (cell.height - cell.lines.length * LINE_H) / 2 + LINE_H / 2;
      const texts = cell.lines
        .map(
          (line, i) =>
            '<text x="' +
            (cell.x + 1.5) +
            '" y="' +
            (lineStart + i * LINE_H) +
            '" dominant-baseline="middle" font-family="Meiryo, Yu Gothic, sans-serif" font-size="' +
            FONT_H +
            '">' +
            esc(line) +
            '</text>',
        )
        .join('');
      return (
        '<rect x="' +
        cell.x +
        '" y="' +
        cell.y +
        '" width="' +
        cell.width +
        '" height="' +
        cell.height +
        '" fill="' +
        (cell.isHeader ? '#eeeeee' : '#ffffff') +
        '" stroke="#222" stroke-width=".24"/>' +
        texts
      );
    })
    .join('');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297">' +
    '<rect width="420" height="297" fill="white"/><text x="12" y="17" font-family="Meiryo, Yu Gothic, sans-serif" font-size="5">' +
    esc(title) +
    '</text>' +
    body +
    '</svg>'
  );
}

function saveText(content, mime, filename) {
  downloadBlob(new Blob([content], { type: mime }), filename);
}

export function downloadSlabCsv(snapshot, filename = 'slab-list.csv') {
  saveText(slabOutputCsv(snapshot), 'text/csv;charset=utf-8', filename);
}

export function downloadSlabSvgs(pages, baseName = 'slab-list') {
  if (!pages.length) throw new Error('SVGページがありません。');
  if (pages.length === 1) {
    saveText(slabPageSvg(pages[0]), 'image/svg+xml;charset=utf-8', baseName + '.svg');
    return;
  }
  // One download avoids the browser blocking subsequent multi-page SVG downloads.
  const entries = Object.fromEntries(
    pages.map((page, index) => [
      baseName + '-' + String(index + 1).padStart(3, '0') + '.svg',
      strToU8(slabPageSvg(page)),
    ]),
  );
  downloadBlob(new Blob([zipSync(entries)], { type: 'application/zip' }), baseName + '-svg.zip');
}

async function svgRaster(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('SVG用紙のPDF描画に失敗しました。'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 2520;
    canvas.height = 1782;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PDF用Canvasを初期化できません。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadSlabPdf(
  pages,
  filename = 'slab-list.pdf',
  { validateBeforeSave = null } = {},
) {
  if (!pages.length) throw new Error('PDFページがありません。');
  // Same SVG plan, rasterized for reliable Japanese glyphs in browser PDFs.
  // PDF's raster content is not the persistent drawing source.
  const { jsPDF: JsPdf } = await import('jspdf');
  const pdf = new JsPdf({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  for (const [index, page] of pages.entries()) {
    if (index) pdf.addPage('a3', 'landscape');
    pdf.addImage(await svgRaster(slabPageSvg(page)), 'PNG', 0, 0, 420, 297);
  }
  if (validateBeforeSave) await validateBeforeSave();
  pdf.save(filename);
  return pages.length;
}

export function buildSlabDxfEntities(pages) {
  if (!pages.length) throw new Error('DXFページがありません。');
  const lines = [],
    texts = [];
  pages.forEach((page, pageIndex) => {
    const offsetX = pageIndex * 440;
    texts.push({
      position: { x: offsetX + 12, y: -17 },
      text: slabPageTitle(page),
      layer: 'LABEL',
      height: 5,
      anchor: 'left',
    });
    for (const cell of page.cells) {
      const x = cell.x + offsetX,
        top = -cell.y,
        bottom = -(cell.y + cell.height);
      const right = x + cell.width;
      const segment = (a, b, c, d) =>
        lines.push({
          start: { x: a, y: b },
          end: { x: c, y: d },
          layer: 'BORDER',
        });
      segment(x, top, right, top);
      segment(right, top, right, bottom);
      segment(right, bottom, x, bottom);
      segment(x, bottom, x, top);
      const textTop = cell.y + (cell.height - cell.lines.length * LINE_H) / 2 + LINE_H / 2;
      cell.lines.forEach((value, index) =>
        texts.push({
          position: { x: x + 1.5, y: -(textTop + index * LINE_H + FONT_H / 2) },
          text: String(value).replace(/\u2014/g, '\u2015'),
          layer: 'LABEL',
          height: FONT_H,
          anchor: 'left',
        }),
      );
    }
  });
  const bounds = {
    min: { x: 0, y: -297 },
    max: { x: pages.length * 440 - 20, y: 0 },
  };
  return { bounds, lines2D: lines, texts2D: texts };
}

export async function downloadSlabDxf(
  pages,
  filename = 'slab-list.dxf',
  profile = 'autocad-r12',
  { validateBeforeSave = null } = {},
) {
  const { bounds, lines2D, texts2D } = buildSlabDxfEntities(pages);
  const content = generateDxfContent(bounds, ['BORDER', 'LABEL'], lines2D, texts2D, [], {
    textStyle: { fontFile: 'txt', bigFontFile: profile === 'jwcad-r12' ? '' : 'extfont2.shx' },
  });
  // The shared writer may asynchronously convert the DXF to Shift-JIS.
  // Recheck source revision after encoding, immediately before download.
  await downloadDxf(content, filename, null, {
    profile,
    assertBeforeSave: validateBeforeSave || undefined,
  });
}
