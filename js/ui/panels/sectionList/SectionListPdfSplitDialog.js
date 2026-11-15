/**
 * @fileoverview 断面リストPDFのシート分割マトリクスダイアログ
 *
 * 行=階、列=符号のマトリクスを一覧し、どの列・どの行で区切るかをトグルして
 * シート(ページ)を決める。区切りで作られる各区画が1シートになり、
 * 指定縮尺の実寸のまま用紙へ載せる。収まるかはシートごとに寸法で表示する。
 *
 * @module ui/sectionList/SectionListPdfSplitDialog
 */

import { escapeHtml } from '../../../utils/htmlUtils.js';
import {
  DEFAULT_PAPER_KEY,
  MM_PER_PX,
  PAPER_SIZES,
  autoBreaks,
  buildSheetGrid,
  estimateSheetSize,
  sheetFitsPaper,
} from './sectionListPageSplit.js';

const BREAK_BORDER = '3px solid #d32f2f';
const NORMAL_BORDER = '1px solid var(--border-color,#bbb)';

/**
 * 区画番号から淡い背景色を返す（明暗どちらのテーマでも暗色文字で読める）
 * @param {number|null} number - シート番号(1始まり)
 * @returns {string}
 */
function tileColor(number) {
  if (number === null) return '#e0e0e0';
  return `hsl(${((number - 1) * 57) % 360}, 70%, 84%)`;
}

/**
 * 配列の要素を移動した新しい配列を返す
 * @param {Array<string>} list
 * @param {number} from
 * @param {number} to
 * @returns {Array<string>}
 */
function moveItem(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * シート分割マトリクスダイアログを表示する
 * @param {Object} params
 * @param {Array<string>} params.symbols - 符号一覧（元の表示順）
 * @param {Array<{id: string, name: string}>} params.stories - 階一覧（表示順）
 * @param {Object} params.metrics - measureGridTable の結果(px)
 * @param {string} [params.scaleLabel] - 縮尺表示（例: 1/40）
 * @param {(storyId: string, symbol: string) => boolean} [params.hasCell] - セルにデータがあるか
 * @param {{colBreakAfter: Array<string>, rowBreakAfter: Array<string>}|null} [params.initialBreaks] - 前回の区切り
 * @param {Array<string>} [params.initialSymbolOrder] - 前回の符号並び順
 * @param {string} [params.initialPaperKey] - 前回の用紙
 * @returns {Promise<{
 *   sheets: Array<{symbols: Array<string>, storyIds: Array<string>}>,
 *   paperKey: string,
 *   colBreakAfter: Array<string>,
 *   rowBreakAfter: Array<string>,
 *   symbolOrder: Array<string>
 * }|null>} キャンセル時はnull
 */
export function openPdfSplitDialog({
  symbols: originalSymbols,
  stories,
  metrics,
  scaleLabel = '',
  hasCell,
  initialBreaks,
  initialSymbolOrder,
  initialPaperKey,
}) {
  return new Promise((resolve) => {
    // 前回の並び順を引き継ぎ、新規の符号は末尾へ、消えた符号は除く
    const keptOrder = (initialSymbolOrder || []).filter((s) => originalSymbols.includes(s));
    let symbols = [...keptOrder, ...originalSymbols.filter((s) => !keptOrder.includes(s))];
    const storyIds = stories.map((story) => story.id);
    const storyName = new Map(stories.map((story) => [story.id, story.name]));
    let paperKey = PAPER_SIZES[initialPaperKey] ? initialPaperKey : DEFAULT_PAPER_KEY;

    const applyAuto = () => autoBreaks({ symbols, storyIds, metrics, paperKey });
    const initial = initialBreaks || applyAuto();
    const colBreaks = new Set(
      (initial.colBreakAfter || []).filter((s) => originalSymbols.includes(s)),
    );
    const rowBreaks = new Set((initial.rowBreakAfter || []).filter((id) => storyIds.includes(id)));

    const overlay = document.createElement('div');
    overlay.className = 'section-list-pdf-split-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);' +
      'display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.className = 'section-list-pdf-split-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.style.cssText =
      'background:var(--bg-primary,#fff);color:var(--text-primary,#222);' +
      'border-radius:8px;padding:16px;width:min(900px,96vw);max-height:92vh;' +
      'display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.35);';
    overlay.appendChild(dialog);

    const close = (result) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve(result);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
      }
    };

    const mm = (px) => Math.round(px * MM_PER_PX);
    const currentGrid = () =>
      buildSheetGrid({
        symbols,
        storyIds,
        colBreakAfter: colBreaks,
        rowBreakAfter: rowBreaks,
        hasCell,
      });

    const breakButton = (kind, key, active, label) =>
      `<button type="button" data-action="toggle" data-kind="${kind}" data-key="${escapeHtml(key)}" aria-pressed="${active}" title="${label}" style="padding:0 4px;line-height:1.3;${active ? 'background:#d32f2f;color:#fff;' : ''}">✂</button>`;

    const renderMatrix = (grid) => {
      const tileAt = (rowIndex, colIndex) => {
        const rowGroup = grid.rowGroups.findIndex((g) => g.includes(rowIndex));
        const colGroup = grid.colGroups.findIndex((g) => g.includes(colIndex));
        return grid.tiles[rowGroup * grid.colGroups.length + colGroup];
      };
      const overflowTile = (tile) =>
        tile.number !== null &&
        !sheetFitsPaper({ symbols: tile.symbols, storyIds: tile.storyIds }, metrics, paperKey);

      const head = symbols
        .map((symbol, c) => {
          const last = c === symbols.length - 1;
          const active = colBreaks.has(symbol) && !last;
          const border = active ? BREAK_BORDER : NORMAL_BORDER;
          const move = (dir, label, disabled) =>
            `<button type="button" data-action="move" data-key="${escapeHtml(symbol)}" data-dir="${dir}" title="${label}"${disabled ? ' disabled' : ''} style="padding:0 3px;line-height:1.3;">${dir < 0 ? '◀' : '▶'}</button>`;
          return `<th draggable="true" data-drag-symbol="${escapeHtml(symbol)}" style="border:${NORMAL_BORDER};border-right:${border};padding:2px 4px;font-weight:normal;vertical-align:bottom;cursor:grab;">
            <div style="font-weight:bold;white-space:nowrap;">${escapeHtml(symbol)}</div>
            <div style="white-space:nowrap;">${move(-1, '左へ移動', c === 0)}${move(1, '右へ移動', last)}</div>
            <div style="font-size:10px;opacity:.7;">${mm(metrics.colWidths[symbol] || 0)}mm</div>
            ${last ? '' : breakButton('col', symbol, active, 'この列の右で区切る/解除')}
          </th>`;
        })
        .join('');

      const body = stories
        .map((story, r) => {
          const lastRow = r === stories.length - 1;
          const rowActive = rowBreaks.has(story.id) && !lastRow;
          const rowBorder = rowActive ? BREAK_BORDER : NORMAL_BORDER;
          const cells = symbols
            .map((symbol, c) => {
              const tile = tileAt(r, c);
              const colActive = colBreaks.has(symbol) && c < symbols.length - 1;
              const filled = hasCell ? hasCell(story.id, symbol) : true;
              const over = overflowTile(tile);
              const text = tile.number === null ? '' : filled ? tile.number : '·';
              return `<td title="${escapeHtml(story.name)} × ${escapeHtml(symbol)}${tile.number ? ` → シート${tile.number}` : '（出力なし）'}" style="background:${tileColor(tile.number)};color:#222;text-align:center;min-width:2.4em;border:${NORMAL_BORDER};border-right:${colActive ? BREAK_BORDER : NORMAL_BORDER};border-bottom:${rowBorder};${over ? 'outline:2px dashed #c62828;outline-offset:-3px;' : ''}${filled ? '' : 'opacity:.55;'}">${text}</td>`;
            })
            .join('');
          return `<tr>
            <th style="border:${NORMAL_BORDER};border-bottom:${rowBorder};padding:2px 6px;text-align:left;font-weight:normal;white-space:nowrap;">
              <span style="font-weight:bold;">${escapeHtml(story.name)}</span>
              <span style="font-size:10px;opacity:.7;"> ${mm(metrics.rowHeights[story.id] || 0)}mm</span>
              ${lastRow ? '' : breakButton('row', story.id, rowActive, 'この階の下で区切る/解除')}
            </th>${cells}</tr>`;
        })
        .join('');

      return `<table style="border-collapse:collapse;font-size:12px;">
        <thead><tr><th style="border:${NORMAL_BORDER};padding:2px 6px;font-weight:normal;">階＼符号</th>${head}</tr></thead>
        <tbody>${body}</tbody></table>`;
    };

    const renderSummary = (grid) => {
      if (grid.sheets.length === 0) return '<div>出力対象のシートがありません。</div>';
      const range = (items) =>
        items.length > 1 ? `${items[0]}〜${items[items.length - 1]}` : items[0];
      return `<ol style="margin:0;padding-left:1.6em;display:flex;flex-direction:column;gap:2px;">${grid.sheets
        .map((sheet, i) => {
          const size = estimateSheetSize(sheet, metrics);
          const fits = sheetFitsPaper(sheet, metrics, paperKey);
          const status = fits
            ? '<span style="color:#1a7f37;">収まる</span>'
            : '<span style="color:#c62828;font-weight:bold;">はみ出し（CADビューで縮尺・配置を調整）</span>';
          return `<li><span style="display:inline-block;width:.9em;height:.9em;background:${tileColor(i + 1)};border:1px solid #888;vertical-align:-1px;"></span>
            階 ${escapeHtml(range(sheet.storyIds.map((id) => storyName.get(id))))} × 符号 ${escapeHtml(range(sheet.symbols))}
            — ${mm(size.width)}×${mm(size.height)}mm ${status}</li>`;
        })
        .join('')}</ol>`;
    };

    const render = () => {
      const prevScroll = dialog.querySelector('#pdf-split-matrix')?.scrollTop || 0;
      const grid = currentGrid();
      const paperOptions = Object.entries(PAPER_SIZES)
        .map(
          ([key, paper]) =>
            `<option value="${key}"${key === paperKey ? ' selected' : ''}>${paper.label}</option>`,
        )
        .join('');

      dialog.innerHTML = `
        <div style="font-weight:bold;font-size:15px;">PDFシート分割（階 × 符号）</div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
          <label>用紙 <select id="pdf-split-paper">${paperOptions}</select></label>
          <span>縮尺 ${escapeHtml(scaleLabel) || '-'}（実寸で配置）</span>
          <button type="button" data-action="auto" title="用紙に実寸で収まるよう区切りを自動設定します">自動分割</button>
          <button type="button" data-action="clear" title="区切りをすべて解除します">区切り解除</button>
          <button type="button" data-action="reset-order" title="符号の並びを元の順に戻します">並び順リセット</button>
        </div>
        <div style="font-size:12px;opacity:.8;">
          符号は見出しの ◀▶ またはドラッグで並べ替えられます。列見出し・行見出しの ✂ で「この列の右 / この階の下」を区切ります。赤線で囲まれた区画が1シート（1ページ）で、
          数字はシート番号、·はデータなし、灰色は出力されない区画、破線の赤枠は用紙に収まらない区画です。
        </div>
        <div id="pdf-split-matrix" style="overflow:auto;border:1px solid var(--border-color,#ccc);padding:4px;">${renderMatrix(grid)}</div>
        <div id="pdf-split-summary" style="overflow:auto;max-height:22vh;font-size:12px;">${renderSummary(grid)}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" data-action="cancel">キャンセル</button>
          <button type="button" data-action="ok" style="font-weight:bold;"${grid.sheets.length === 0 ? ' disabled' : ''}>CADビューへ (${grid.sheets.length}領域)</button>
        </div>`;
      const matrix = dialog.querySelector('#pdf-split-matrix');
      if (matrix) matrix.scrollTop = prevScroll;
    };

    dialog.addEventListener('change', (event) => {
      if (event.target.id === 'pdf-split-paper') {
        paperKey = event.target.value;
        render();
      }
    });

    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      switch (button.dataset.action) {
        case 'toggle': {
          const set = button.dataset.kind === 'col' ? colBreaks : rowBreaks;
          const key = button.dataset.key;
          if (set.has(key)) set.delete(key);
          else set.add(key);
          break;
        }
        case 'auto': {
          const auto = applyAuto();
          colBreaks.clear();
          rowBreaks.clear();
          auto.colBreakAfter.forEach((key) => colBreaks.add(key));
          auto.rowBreakAfter.forEach((key) => rowBreaks.add(key));
          break;
        }
        case 'move': {
          const from = symbols.indexOf(button.dataset.key);
          const to = from + Number(button.dataset.dir);
          if (from >= 0 && to >= 0 && to < symbols.length) {
            symbols = moveItem(symbols, from, to);
          }
          break;
        }
        case 'reset-order':
          symbols = [...originalSymbols];
          break;
        case 'clear':
          colBreaks.clear();
          rowBreaks.clear();
          break;
        case 'cancel':
          close(null);
          return;
        case 'ok':
          close({
            sheets: currentGrid().sheets,
            paperKey,
            colBreakAfter: [...colBreaks],
            rowBreakAfter: [...rowBreaks],
            symbolOrder: [...symbols],
          });
          return;
        default:
          return;
      }
      render();
    });

    // ヘッダーのドラッグ&ドロップで符号を並べ替え
    let dragSymbol = null;
    dialog.addEventListener('dragstart', (event) => {
      const th = event.target.closest?.('th[data-drag-symbol]');
      if (!th) return;
      dragSymbol = th.dataset.dragSymbol;
      event.dataTransfer?.setData('text/plain', dragSymbol);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    dialog.addEventListener('dragover', (event) => {
      if (dragSymbol && event.target.closest?.('th[data-drag-symbol]')) event.preventDefault();
    });
    dialog.addEventListener('drop', (event) => {
      const th = event.target.closest?.('th[data-drag-symbol]');
      if (!th || !dragSymbol) return;
      event.preventDefault();
      const from = symbols.indexOf(dragSymbol);
      const to = symbols.indexOf(th.dataset.dragSymbol);
      dragSymbol = null;
      if (from >= 0 && to >= 0 && from !== to) {
        symbols = moveItem(symbols, from, to);
        render();
      }
    });
    dialog.addEventListener('dragend', () => {
      dragSymbol = null;
    });

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKeydown, true);
    render();
    document.body.appendChild(overlay);
    dialog.querySelector('[data-action="ok"]')?.focus();
  });
}

export default openPdfSplitDialog;
