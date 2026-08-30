/**
 * @fileoverview 断面リストPDF出力モジュール
 *
 * html2canvasとjsPDFを使用して柱・梁断面リストテーブルをPDFとして出力します。
 *
 * @module ui/sectionList/SectionListPdfExporter
 */

import { createLogger } from '../../../utils/logger.js';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

const log = createLogger('ui/SectionListPdfExporter');

/**
 * テーブル要素をPDFとして出力
 * @param {HTMLElement} tableElement - 出力するテーブル要素
 * @param {string} [filename='section-list.pdf'] - 出力ファイル名
 * @returns {Promise<void>}
 */
export async function exportToPdf(tableElement, filename = 'section-list.pdf') {
  if (!tableElement) {
    throw new Error('テーブル要素が指定されていません');
  }

  log.info('Starting PDF export...');

  // グリッドレイアウトか判定（柱・梁共通）
  const isGridLayout =
    tableElement.classList.contains('column-section-grid-table') ||
    tableElement.classList.contains('beam-section-grid-table');

  // テーブルのクローンを作成してスタイルを調整
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `
    position: absolute;
    left: -9999px;
    top: 0;
    background: white;
    padding: 20px;
    ${isGridLayout ? 'width: 1600px;' : ''}
  `;

  const tableClone = tableElement.cloneNode(true);
  tableClone.style.cssText = `
    border-collapse: collapse;
    font-family: 'Meiryo', 'Yu Gothic', sans-serif;
    font-size: 10px;
    background: white;
    ${isGridLayout ? 'table-layout: auto;' : ''}
  `;

  // SVG要素のスタイルを調整
  const svgs = tableClone.querySelectorAll('svg');
  svgs.forEach((svg) => {
    // SVGの背景を白に
    const bgRect = svg.querySelector('rect');
    if (bgRect) {
      bgRect.setAttribute('fill', 'white');
    }
  });

  wrapper.appendChild(tableClone);
  document.body.appendChild(wrapper);

  try {
    // html2canvasでキャプチャ
    const canvas = await html2canvas(tableClone, {
      scale: 2, // 高解像度
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      allowTaint: true,
    });

    log.info('Canvas created', { width: canvas.width, height: canvas.height });

    // jsPDFでPDF生成
    // ページサイズを計算（A3横向きを基準）
    const imgWidth = canvas.width;
    const imgHeight = canvas.height;

    // A3横向き: 420mm x 297mm
    const pageWidth = 420;
    const pageHeight = 297;
    const margin = 10;
    const contentWidth = pageWidth - margin * 2;
    const contentHeight = pageHeight - margin * 2;

    // 画像の縮小率を計算
    const scaleX = contentWidth / (imgWidth / 2); // canvas.scale=2なので/2
    const scaleY = contentHeight / (imgHeight / 2);
    const scale = Math.min(scaleX, scaleY, 1); // 1を超えない（拡大しない）

    const scaledWidth = (imgWidth / 2) * scale;
    const scaledHeight = (imgHeight / 2) * scale;

    // グリッドレイアウトは横向き固定、リスト表示は動的に決定
    const orientation = isGridLayout
      ? 'landscape'
      : scaledWidth > scaledHeight
        ? 'landscape'
        : 'portrait';

    // PDFを作成
    // eslint-disable-next-line new-cap
    const pdf = new jsPDF({
      orientation: orientation,
      unit: 'mm',
      format: 'a3',
    });

    // 画像を追加
    const imgData = canvas.toDataURL('image/png');

    // 複数ページに分割が必要な場合
    if (scaledHeight > contentHeight) {
      // ページ分割
      const totalPages = Math.ceil(scaledHeight / contentHeight);
      log.info(`PDF will have ${totalPages} pages`);

      for (let page = 0; page < totalPages; page++) {
        if (page > 0) {
          pdf.addPage('a3', 'landscape');
        }

        // このページに表示する部分を計算
        const sourceY = (page * contentHeight) / scale;
        const sourceHeight = Math.min(contentHeight / scale, imgHeight / 2 - sourceY);

        // 部分的なキャンバスを作成
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = imgWidth;
        pageCanvas.height = sourceHeight * 2;
        const ctx = pageCanvas.getContext('2d');
        ctx.drawImage(
          canvas,
          0,
          sourceY * 2,
          imgWidth,
          sourceHeight * 2,
          0,
          0,
          imgWidth,
          sourceHeight * 2,
        );

        const pageImgData = pageCanvas.toDataURL('image/png');
        pdf.addImage(pageImgData, 'PNG', margin, margin, scaledWidth, sourceHeight * scale);
      }
    } else {
      // 1ページに収まる場合
      pdf.addImage(imgData, 'PNG', margin, margin, scaledWidth, scaledHeight);
    }

    // ダウンロード
    pdf.save(filename);
    log.info('PDF saved:', filename);
  } finally {
    // クリーンアップ
    document.body.removeChild(wrapper);
  }
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
