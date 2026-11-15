/**
 * @fileoverview 断面リストPDFの領域・用紙ノード生成
 *
 * 簡易CADビュー(エディタ)とPDF出力で同じDOMを使うためのモジュール。
 * 領域 = グリッドテーブルから階×符号を切り出した表 + 見出し。用紙ノードは
 * 用紙サイズ(mm)の白地に領域を絶対配置したもので、画面表示とPDF化の双方の元になる。
 *
 * @module ui/sectionList/SectionListRegionRenderer
 */

import { MM_PER_PX, keepOnlyGridCells } from './sectionListPageSplit.js';

const STYLE_ID = 'section-sheet-region-style';

/**
 * 領域用の共通スタイルを一度だけ挿入する。
 * 固定列(階・項目)のstickyは、画面外・拡大表示でずれるため無効化する。
 */
export function ensureSheetStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .section-sheet-region { user-select: none; -webkit-user-select: none; }
    .section-sheet-region.section-sheet-compact .section-grid-header-symbol,
    .section-sheet-region.section-sheet-compact .section-grid-section-cell {
      min-width: 0 !important;
    }
    .section-sheet-region th,
    .section-sheet-region td {
      position: static !important;
      left: auto !important;
      top: auto !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} SheetRegion
 * @property {string} id
 * @property {Array<string>} symbols - 符号(表示順)
 * @property {Array<string>} storyIds - 階ID(表示順)
 * @property {number} x - 用紙上の左位置(mm)
 * @property {number} y - 用紙上の上位置(mm)
 * @property {string} label - 見出し(空なら非表示)
 */

/**
 * 領域のDOMノードを作る（未接続）。表は元テーブルの複製を階×符号で絞り込んだもの。
 * @param {HTMLElement} tableElement - 元のグリッドテーブル
 * @param {SheetRegion} region
 * @param {Array<string>} allStoryIds - tbody行順に対応する全階ID
 * @param {{compactColumns?: boolean}} [options] - compactColumns: 列を画面用の最小幅(180px)に
 *   縛らず内容に合わせる（縮尺を小さくしたとき実寸で詰まる）
 * @returns {HTMLElement}
 */
export function buildRegionNode(tableElement, region, allStoryIds, options = {}) {
  ensureSheetStyles();

  const node = document.createElement('div');
  node.className = options.compactColumns
    ? 'section-sheet-region section-sheet-compact'
    : 'section-sheet-region';
  node.dataset.regionId = region.id;
  node.style.cssText = `
    position: absolute;
    left: ${region.x}mm;
    top: ${region.y}mm;
    width: max-content;
    background: #fff;
    color: #000;
  `;

  if (region.label) {
    const label = document.createElement('div');
    label.className = 'section-sheet-region-label';
    label.textContent = region.label;
    label.style.cssText = `
      font: bold 12px 'Meiryo', 'Yu Gothic', sans-serif;
      margin-bottom: 2px;
      white-space: nowrap;
    `;
    node.appendChild(label);
  }

  const table = tableElement.cloneNode(true);
  table.style.cssText = `
    border-collapse: collapse;
    font-family: 'Meiryo', 'Yu Gothic', sans-serif;
    font-size: 10px;
    background: white;
    table-layout: auto;
    width: auto;
  `;
  keepOnlyGridCells(table, {
    symbols: region.symbols,
    storyIds: region.storyIds,
    allStoryIds,
  });
  table.querySelectorAll('svg:not(.steel-section-profile)').forEach((svg) => {
    const bgRect = svg.querySelector('rect');
    if (bgRect) bgRect.setAttribute('fill', 'white');
  });
  node.appendChild(table);
  return node;
}

/**
 * 領域の実寸(mm)を測る。画面外に仮置きして描画サイズを読むため、
 * 見出しを含む実際のPDF上の大きさと一致する。
 * @param {HTMLElement} tableElement
 * @param {Array<SheetRegion>} regions
 * @param {Array<string>} allStoryIds
 * @param {{compactColumns?: boolean}} [options]
 * @returns {Map<string, {width: number, height: number}>} 領域id→寸法(mm)
 */
export function measureRegions(tableElement, regions, allStoryIds, options = {}) {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0;';
  const nodes = regions.map((region) => {
    const node = buildRegionNode(tableElement, { ...region, x: 0, y: 0 }, allStoryIds, options);
    container.appendChild(node);
    return node;
  });
  document.body.appendChild(container);
  try {
    const sizes = new Map();
    regions.forEach((region, index) => {
      sizes.set(region.id, {
        width: nodes[index].offsetWidth * MM_PER_PX,
        height: nodes[index].offsetHeight * MM_PER_PX,
      });
    });
    return sizes;
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * 用紙ノードを作る（未接続）。用紙サイズ(mm)の白地に領域を配置する。
 * @param {{width: number, height: number}} paper - 用紙(mm)
 * @param {Array<SheetRegion>} regions - このページの領域
 * @param {HTMLElement} tableElement
 * @param {Array<string>} allStoryIds
 * @param {{compactColumns?: boolean}} [options]
 * @returns {HTMLElement}
 */
export function buildPaperNode(paper, regions, tableElement, allStoryIds, options = {}) {
  const paperNode = document.createElement('div');
  paperNode.className = 'section-sheet-paper';
  paperNode.style.cssText = `
    position: relative;
    width: ${paper.width}mm;
    height: ${paper.height}mm;
    background: #fff;
    overflow: hidden;
  `;
  regions.forEach((region) => {
    paperNode.appendChild(buildRegionNode(tableElement, region, allStoryIds, options));
  });
  return paperNode;
}
