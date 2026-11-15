/**
 * @fileoverview 断面リストPDF出力モジュール
 *
 * html2canvasとjsPDFを使用して柱・梁断面リストテーブルをPDFとして出力します。
 * 簡易CADビューで配置したページ(用紙サイズ(mm)のDOM)は、そのまま1ページずつ画像化して
 * PDF化するため、画面表示と出力が一致し、指定縮尺の実寸になります。
 *
 * @module ui/sectionList/SectionListPdfExporter
 */

import { createLogger } from '../../../utils/logger.js';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { DEFAULT_PAPER_KEY, PAPER_SIZES, computeSheetPlacement } from './sectionListPageSplit.js';
import { buildPaperNode, ensureSheetStyles } from './SectionListRegionRenderer.js';

const log = createLogger('ui/SectionListPdfExporter');

const CAPTURE_SCALE = 2;

/**
 * グリッドレイアウトか判定（柱・梁共通）
 * @param {HTMLElement} tableElement
 * @returns {boolean}
 */
export function isGridTable(tableElement) {
  return (
    tableElement.classList.contains('column-section-grid-table') ||
    tableElement.classList.contains('beam-section-grid-table') ||
    tableElement.classList.contains('steel-section-grid-table')
  );
}

/**
 * 複製内の `position: sticky` を解除する。
 * 画面外(left:-9999px)に置いた複製では、stickyがビューポート側へ要素を引き寄せ、
 * 固定列(階・項目)がキャプチャ上でずれるため、通常配置へ戻す。
 * @param {HTMLElement} root
 */
function neutralizeSticky(root) {
  root.querySelectorAll('*').forEach((el) => {
    if (window.getComputedStyle(el).position === 'sticky') {
      el.style.position = 'static';
      el.style.left = 'auto';
      el.style.top = 'auto';
    }
  });
}

/**
 * テーブルをクローンしてキャプチャ用ラッパーへ載せる。
 * グリッドは原寸(自然幅)で並べ、断面図の縮尺をそのまま保つ。
 * @param {HTMLElement} tableElement - 元テーブル
 * @param {boolean} isGridLayout
 * @param {boolean} [compactColumns] - 列を内容に合わせる（領域レイアウトと同じ条件で測る）
 * @returns {{wrapper: HTMLElement, tableClone: HTMLElement}}
 */
function mountCaptureClone(tableElement, isGridLayout, compactColumns = false) {
  ensureSheetStyles();
  const wrapper = document.createElement('div');
  if (compactColumns) wrapper.className = 'section-sheet-region section-sheet-compact';
  wrapper.style.cssText = `
    position: absolute;
    left: -9999px;
    top: 0;
    background: white;
    padding: 20px;
    ${isGridLayout ? 'width: max-content;' : ''}
  `;

  const tableClone = tableElement.cloneNode(true);
  tableClone.style.cssText = `
    border-collapse: collapse;
    font-family: 'Meiryo', 'Yu Gothic', sans-serif;
    font-size: 10px;
    background: white;
    ${isGridLayout ? 'table-layout: auto; width: auto;' : ''}
  `;

  // SVGの背景を白に
  tableClone.querySelectorAll('svg').forEach((svg) => {
    const bgRect = svg.querySelector('rect');
    if (bgRect) bgRect.setAttribute('fill', 'white');
  });

  wrapper.appendChild(tableClone);
  document.body.appendChild(wrapper);
  neutralizeSticky(tableClone);
  return { wrapper, tableClone };
}

/**
 * 出力と同じ条件(原寸・自然幅)でグリッドの列幅・行高を測定する。
 * 列幅は表示する階の行によって変わる（幅の広いセルを含む行があるかで決まる）ため、
 * 階を1行ずつだけ表示した状態でセル幅を測り、シートでは含める階の最大値を使う。
 * @param {HTMLElement} tableElement - グリッドテーブル
 * @param {Array<string>} storyIds - tbody行順に対応する階ID
 * @param {{compactColumns?: boolean}} [options] - compactColumns: 列を内容に合わせて測る
 * @returns {{
 *   fixedWidth: number,
 *   headerHeight: number,
 *   colWidths: Object<string, number>,
 *   cellWidths: Object<string, Object<string, number>>,
 *   rowHeights: Object<string, number>
 * }} CSS px。colWidths は全階を含めたときの符号ごとの最大幅
 */
export function measureGridTable(tableElement, storyIds, { compactColumns = false } = {}) {
  const { wrapper, tableClone } = mountCaptureClone(tableElement, true, compactColumns);
  try {
    const headerCells = [...(tableClone.querySelector('thead tr')?.children || [])];
    const bodyRows = [...tableClone.querySelectorAll('tbody tr')];

    // 行高・ヘッダー高は全行表示のまま測る
    const rowHeights = {};
    bodyRows.forEach((tr, index) => {
      if (storyIds[index] !== undefined) {
        rowHeights[storyIds[index]] = tr.getBoundingClientRect().height;
      }
    });
    const headerHeight = tableClone.querySelector('thead')?.getBoundingClientRect().height || 0;

    const colWidths = {};
    const cellWidths = {};
    let fixedWidth = 0;
    bodyRows.forEach((_, rowIndex) => {
      const storyId = storyIds[rowIndex];
      if (storyId === undefined) return;
      bodyRows.forEach((tr, i) => {
        tr.style.display = i === rowIndex ? '' : 'none';
      });

      let fixed = 0;
      const widths = {};
      headerCells.forEach((th) => {
        const width = th.getBoundingClientRect().width;
        if (th.classList.contains('section-grid-header-symbol')) {
          widths[th.textContent.trim()] = width;
          colWidths[th.textContent.trim()] = Math.max(colWidths[th.textContent.trim()] || 0, width);
        } else {
          fixed += width;
        }
      });
      fixedWidth = Math.max(fixedWidth, fixed);
      cellWidths[storyId] = widths;
    });
    bodyRows.forEach((tr) => {
      tr.style.display = '';
    });

    return { fixedWidth, headerHeight, colWidths, cellWidths, rowHeights };
  } finally {
    document.body.removeChild(wrapper);
  }
}

/**
 * 要素をCanvas化する。ページ全体(3Dビュー等)の複製を避け、対象とその祖先・<head>(CSS)
 * だけを複製して高速化する。
 * @param {HTMLElement} target - キャプチャ対象（文書に接続済み）
 * @returns {Promise<HTMLCanvasElement>} scale=2 のCanvas
 */
function captureElement(target) {
  return html2canvas(target, {
    scale: CAPTURE_SCALE,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    allowTaint: true,
    ignoreElements: (el) => !el.contains(target) && !target.contains(el) && !el.closest('head'),
  });
}

/**
 * テーブル全体をCanvas化する（従来の「PDF」ボタン用）
 * @param {HTMLElement} tableElement - 元テーブル
 * @param {boolean} isGridLayout
 * @returns {Promise<HTMLCanvasElement>}
 */
async function captureTable(tableElement, isGridLayout) {
  const { wrapper, tableClone } = mountCaptureClone(tableElement, isGridLayout);
  try {
    return await captureElement(tableClone);
  } finally {
    document.body.removeChild(wrapper);
  }
}

/**
 * レイアウト済みのページ(用紙ノード)を1ページずつ画像化する。
 * 簡易CADビューと同じDOMを用紙サイズ(mm)で描くため、見た目と出力が一致する。
 * @param {Object} params
 * @param {HTMLElement} params.tableElement - グリッドテーブル
 * @param {Array<{regions: Array<Object>}>} params.pages - ページ(領域の配置)
 * @param {Array<string>} params.allStoryIds - tbody行順に対応する全階ID
 * @param {string} params.paperKey - 用紙キー
 * @param {boolean} [params.compactColumns] - 列を内容に合わせる
 * @param {(done: number, total: number) => void} [params.onProgress]
 * @returns {Promise<Array<string>>} ページごとのPNG data URL
 */
export async function captureLayoutPages({
  tableElement,
  pages,
  allStoryIds,
  paperKey,
  compactColumns = false,
  onProgress,
}) {
  if (!tableElement || !isGridTable(tableElement)) {
    throw new Error('グリッドテーブルが指定されていません');
  }
  const paper = PAPER_SIZES[paperKey] || PAPER_SIZES[DEFAULT_PAPER_KEY];
  const nonEmpty = pages.filter((page) => page.regions.length > 0);

  const images = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;left:-9999px;top:0;';
    wrapper.appendChild(
      buildPaperNode(paper, nonEmpty[i].regions, tableElement, allStoryIds, { compactColumns }),
    );
    document.body.appendChild(wrapper);
    try {
      const canvas = await captureElement(wrapper.firstChild);
      images.push(canvas.toDataURL('image/png'));
    } finally {
      document.body.removeChild(wrapper);
    }
    onProgress?.(i + 1, nonEmpty.length);
  }
  return images;
}

/**
 * ページ画像から、1ページ=用紙1枚のPDFを保存する（画像は用紙全面へ等倍で貼る）
 * @param {Array<string>} images - captureLayoutPages の結果
 * @param {string} paperKey - 用紙キー
 * @param {string} filename
 * @returns {number} ページ数
 */
export function savePdfFromPages(images, paperKey, filename) {
  const paper = PAPER_SIZES[paperKey] || PAPER_SIZES[DEFAULT_PAPER_KEY];
  // eslint-disable-next-line new-cap
  const pdf = new jsPDF({ orientation: paper.orientation, unit: 'mm', format: paper.format });
  images.forEach((image, index) => {
    if (index > 0) pdf.addPage(paper.format, paper.orientation);
    pdf.addImage(image, 'PNG', 0, 0, paper.width, paper.height);
  });
  pdf.save(filename);
  log.info('PDF saved:', filename, { pages: images.length });
  return images.length;
}

/**
 * テーブル全体を1枚へ縮小フィットしてPDF出力する（従来の「PDF」ボタン）。
 * グリッドはA3横固定、リスト表示は縦横を内容から決める。
 * @param {HTMLElement} tableElement - 出力するテーブル要素
 * @param {string} [filename='section-list.pdf'] - 出力ファイル名
 * @returns {Promise<void>}
 */
export async function exportToPdf(tableElement, filename = 'section-list.pdf') {
  if (!tableElement) {
    throw new Error('テーブル要素が指定されていません');
  }

  log.info('Starting PDF export...');

  const isGridLayout = isGridTable(tableElement);
  const canvas = await captureTable(tableElement, isGridLayout);
  log.info('Canvas created', { width: canvas.width, height: canvas.height });

  const portrait = !isGridLayout && canvas.height > canvas.width;
  const paper = PAPER_SIZES[portrait ? 'a3-portrait' : 'a3-landscape'];
  // eslint-disable-next-line new-cap
  const pdf = new jsPDF({ orientation: paper.orientation, unit: 'mm', format: paper.format });
  const { x, y, width, height } = computeSheetPlacement(
    { width: canvas.width / CAPTURE_SCALE, height: canvas.height / CAPTURE_SCALE },
    paper,
    1,
  );
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, width, height);
  pdf.save(filename);
  log.info('PDF saved:', filename);
}

/**
 * SVGを画像に変換（代替手法）
 * @param {SVGElement} svg - SVG要素
 * @returns {Promise<string>} Base64画像データ
 */
export async function svgToImage(svg) {
  return new Promise((resolve, reject) => {
    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = svg.width.baseVal.value * 2;
      canvas.height = svg.height.baseVal.value * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export default exportToPdf;
