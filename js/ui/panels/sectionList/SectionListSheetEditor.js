/**
 * @fileoverview 断面リストPDFの簡易CADビュー(用紙レイアウトエディタ)
 *
 * マトリクスで区切った領域(階×符号の切り出し)を用紙上に実寸で表示し、
 * 1ページへ複数の領域を貼り付けたり、位置・見出し・階範囲・符号を調整したり、
 * 縮尺を切り替えて収まりを確認したりできる。画面の表示がそのままPDFになる。
 *
 * @module ui/sectionList/SectionListSheetEditor
 */

import { escapeHtml } from '../../../utils/htmlUtils.js';
import {
  DEFAULT_PAPER_KEY,
  MM_PER_PX,
  PAGE_MARGIN_MM,
  PAPER_SIZES,
} from './sectionListPageSplit.js';
import {
  countUncoveredCells,
  defaultRegionLabel,
  findLayoutIssues,
  packRegions,
  snapPosition,
} from './sectionListSheetLayout.js';
import { buildRegionNode, measureRegions } from './SectionListRegionRenderer.js';

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * 簡易CADビューを開く
 * @param {Object} params
 * @param {Array<{symbols: Array<string>, storyIds: Array<string>}>} params.sheets - 初期の領域(マトリクスの区切り結果)
 * @param {Array<string>} params.symbols - 符号一覧（並び替え後の表示順）
 * @param {Array<{id: string, name: string}>} params.stories - 階一覧（表示順）
 * @param {string} params.paperKey - 用紙キー
 * @param {number} params.scaleDenominator - 現在の縮尺分母
 * @param {Array<number>} params.scaleOptions - 選べる縮尺分母
 * @param {() => HTMLElement|null} params.getTable - 現在のグリッドテーブル
 * @param {(denominator: number) => void} params.setScale - 縮尺を変更して表を再描画する
 * @param {(paperKey: string, options: {compactColumns: boolean}) => Array<{symbols: Array<string>, storyIds: Array<string>}>} params.autoSplit -
 *   現在の縮尺・用紙で収まるよう自動分割する
 * @param {(storyId: string, symbol: string) => boolean} [params.hasCell]
 * @param {Object|null} [params.initialLayout] - typed DrawingProject section-list layout
 * @returns {Promise<{action: 'export', pages: Array<{regions: Array<Object>}>, paperKey: string}|{action: 'back'}|null>}
 */
export function openSheetEditor({
  sheets,
  symbols,
  stories,
  paperKey: initialPaperKey,
  scaleDenominator,
  scaleOptions,
  getTable,
  setScale,
  autoSplit,
  hasCell,
  initialLayout = null,
}) {
  return new Promise((resolve) => {
    const storyIds = stories.map((story) => story.id);
    const storyName = new Map(stories.map((story) => [story.id, story.name]));
    const nameOf = (id) => storyName.get(id) ?? id;

    let paperKey = PAPER_SIZES[initialLayout?.paperKey || initialPaperKey]
      ? initialLayout?.paperKey || initialPaperKey
      : DEFAULT_PAPER_KEY;
    let scale = initialLayout?.scaleDenominator ?? scaleDenominator;
    let zoom = 1;
    let pages = [{ regions: [] }];
    let currentPage = 0;
    let selectedId = null;
    let manuallyEdited = false;
    let compactColumns = initialLayout?.compactColumns ?? true;
    let regionSeq = 0;
    const usedRegionIds = new Set(
      initialLayout?.pages?.flatMap((page) => page.regions.map((r) => r.id)) || [],
    );
    /** @type {Map<string, {key: string, width: number, height: number}>} */
    const sizeCache = new Map();

    const paper = () => PAPER_SIZES[paperKey];

    // ---- 領域モデル ----

    const makeRegion = (sheet) => {
      const region = {
        id: (() => {
          let candidate;
          do {
            candidate = `region-${++regionSeq}`;
          } while (usedRegionIds.has(candidate));
          usedRegionIds.add(candidate);
          return candidate;
        })(),
        symbols: [...sheet.symbols],
        storyIds: [...sheet.storyIds],
        x: PAGE_MARGIN_MM,
        y: PAGE_MARGIN_MM,
        label: '',
        autoLabel: true,
      };
      region.label = defaultRegionLabel(region, nameOf);
      return region;
    };

    const sizeKey = (region) =>
      [
        scale,
        compactColumns,
        region.label,
        region.symbols.join(','),
        region.storyIds.join(','),
      ].join('|');

    /** 寸法キャッシュが古い領域をまとめて測り直す */
    const ensureSizes = (regions) => {
      const stale = regions.filter((r) => sizeCache.get(r.id)?.key !== sizeKey(r));
      if (stale.length === 0) return;
      const table = getTable();
      if (!table) return;
      const measured = measureRegions(table, stale, storyIds, { compactColumns });
      stale.forEach((region) => {
        sizeCache.set(region.id, { key: sizeKey(region), ...measured.get(region.id) });
      });
    };

    const sizeOf = (region) => {
      ensureSizes([region]);
      return sizeCache.get(region.id) || { width: 0, height: 0 };
    };

    const allRegions = () => pages.flatMap((page) => page.regions);

    /** 与えた順に領域を用紙へ詰め込み直す */
    const repack = (regions) => {
      ensureSizes(regions);
      const placements = packRegions(
        regions.map((r) => sizeOf(r)),
        paper(),
      );
      const next = [];
      regions.forEach((region, index) => {
        const { page, x, y } = placements[index];
        (next[page] ??= { regions: [] }).regions.push({ ...region, x: round1(x), y: round1(y) });
      });
      pages = next.length > 0 ? next : [{ regions: [] }];
      for (let i = 0; i < pages.length; i += 1) pages[i] ??= { regions: [] };
      currentPage = Math.min(currentPage, pages.length - 1);
      manuallyEdited = false;
    };

    const findRegion = (id) => allRegions().find((r) => r.id === id) || null;
    const currentRegions = () => pages[currentPage].regions;

    const issuesFor = (regions) =>
      findLayoutIssues(
        regions.map((r) => ({ x: r.x, y: r.y, ...sizeOf(r) })),
        paper(),
      );

    // ---- DOM骨格 ----

    const overlay = document.createElement('div');
    overlay.className = 'section-list-sheet-editor-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';

    const root = document.createElement('div');
    root.className = 'section-list-sheet-editor';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.style.cssText =
      'background:var(--bg-primary,#fff);color:var(--text-primary,#222);border-radius:8px;' +
      'width:98vw;height:96vh;display:flex;flex-direction:column;gap:6px;padding:10px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.45);font-size:13px;';
    overlay.appendChild(root);

    root.innerHTML = `
      <div data-part="toolbar" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;"></div>
      <div style="display:flex;gap:8px;flex:1;min-height:0;">
        <div data-part="pages" style="width:120px;overflow:auto;display:flex;flex-direction:column;gap:4px;"></div>
        <div data-part="scroller" style="flex:1;overflow:auto;background:#777;position:relative;"></div>
        <div data-part="panel" style="width:290px;overflow:auto;display:flex;flex-direction:column;gap:8px;"></div>
      </div>
      <div data-part="status" style="font-size:12px;"></div>`;
    const part = (name) => root.querySelector(`[data-part="${name}"]`);
    const toolbar = part('toolbar');
    const pagesEl = part('pages');
    const scroller = part('scroller');
    const panelEl = part('panel');
    const statusEl = part('status');

    const close = (result) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve(result);
    };

    // ---- 描画 ----

    const renderToolbar = () => {
      const paperOptions = Object.entries(PAPER_SIZES)
        .map(
          ([key, p]) =>
            `<option value="${key}"${key === paperKey ? ' selected' : ''}>${p.label}</option>`,
        )
        .join('');
      const scaleOpts = scaleOptions
        .map((n) => `<option value="${n}"${n === scale ? ' selected' : ''}>1/${n}</option>`)
        .join('');
      toolbar.innerHTML = `
        <strong>PDFレイアウト（簡易CADビュー）</strong>
        <label>用紙 <select data-field="paper">${paperOptions}</select></label>
        <label>縮尺 <select data-field="scale">${scaleOpts}</select></label>
        <label title="内容に合わせる: 縮尺に応じて列が詰まります / 画面と同じ: 画面表示の列幅(最小180px)">列幅 <select data-field="columns"><option value="compact"${compactColumns ? ' selected' : ''}>内容に合わせる</option><option value="screen"${compactColumns ? '' : ' selected'}>画面と同じ</option></select></label>
        <span style="display:inline-flex;gap:2px;align-items:center;">
          表示 <button type="button" data-action="zoom-out">−</button>
          <span data-part="zoom-label" style="min-width:3.2em;text-align:center;">${Math.round(zoom * 100)}%</span>
          <button type="button" data-action="zoom-in">＋</button>
          <button type="button" data-action="zoom-fit">全体</button>
        </span>
        <button type="button" data-action="repack" title="領域を現在の縮尺・用紙で詰め直します（手動の位置は上書きされます）">再配置</button>
        <button type="button" data-action="autosplit" title="現在の縮尺・用紙で収まるよう階×符号を自動分割して配置します">自動分割</button>
        <span style="flex:1"></span>
        <button type="button" data-action="back">区切りへ戻る</button>
        <button type="button" data-action="cancel">キャンセル</button>
        <button type="button" data-action="save-project" title="共通DrawingProjectシート（A3）として保存">共通シート保存</button>
        <button type="button" data-action="export" style="font-weight:bold;">PDF出力</button>`;
    };

    const renderPages = () => {
      pagesEl.innerHTML =
        pages
          .map((page, index) => {
            const issues = issuesFor(page.regions);
            const warn = issues.some((i) => i.outOfBounds || i.overlaps.length > 0) ? ' ⚠' : '';
            const active = index === currentPage;
            return `<button type="button" data-action="page" data-index="${index}" style="text-align:left;${active ? 'background:#1976d2;color:#fff;font-weight:bold;' : ''}">ページ${index + 1}${warn}<br><small>${page.regions.length}領域</small></button>`;
          })
          .join('') +
        '<button type="button" data-action="add-page">＋ページ追加</button>' +
        `<button type="button" data-action="remove-page"${currentRegions().length > 0 || pages.length === 1 ? ' disabled' : ''} title="空のページだけ削除できます">ページ削除</button>`;
    };

    const applyDecorations = () => {
      const regions = currentRegions();
      const issues = issuesFor(regions);
      regions.forEach((region, index) => {
        const node = scroller.querySelector(`[data-region-id="${region.id}"]`);
        if (!node) return;
        const bad = issues[index].outOfBounds || issues[index].overlaps.length > 0;
        node.style.outline = bad ? '2px dashed #d32f2f' : '1px solid #bbb';
        node.style.outlineOffset = '0';
        node.style.boxShadow = region.id === selectedId ? '0 0 0 3px rgba(25,118,210,.55)' : '';
      });
    };

    const renderPaper = () => {
      const p = paper();
      const widthPx = p.width / MM_PER_PX;
      const heightPx = p.height / MM_PER_PX;
      scroller.innerHTML = '';

      const holder = document.createElement('div');
      holder.style.cssText = `position:relative;margin:16px;width:${widthPx * zoom}px;height:${heightPx * zoom}px;`;
      const sheet = document.createElement('div');
      sheet.style.cssText = `position:absolute;left:0;top:0;width:${p.width}mm;height:${p.height}mm;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.5);transform:scale(${zoom});transform-origin:top left;`;
      const guide = document.createElement('div');
      guide.style.cssText = `position:absolute;inset:${PAGE_MARGIN_MM}mm;border:1px dashed #bbb;pointer-events:none;`;
      sheet.appendChild(guide);

      const table = getTable();
      if (table) {
        currentRegions().forEach((region) => {
          const node = buildRegionNode(table, region, storyIds, { compactColumns });
          node.style.cursor = 'move';
          node.style.touchAction = 'none';
          node.addEventListener('pointerdown', (event) => startDrag(event, region, node));
          sheet.appendChild(node);
        });
      }
      holder.appendChild(sheet);
      scroller.appendChild(holder);
      applyDecorations();
    };

    const renderPanel = () => {
      const region = findRegion(selectedId);
      if (!region) {
        panelEl.innerHTML =
          '<div style="opacity:.75;line-height:1.6;">用紙上の領域をクリックして選択します。<br>ドラッグ・矢印キー（Shift=10mm / Alt=0.1mm）で位置を調整できます。<br>領域は階×符号の切り出しで、1ページへ複数貼り付けられます。</div>';
        return;
      }
      const size = sizeOf(region);
      const index = pages.findIndex((page) => page.regions.includes(region));
      const idxInPage = pages[index].regions.indexOf(region);
      const issue = issuesFor(pages[index].regions)[idxInPage];
      const status = issue.outOfBounds
        ? '<span style="color:#c62828;font-weight:bold;">用紙の描画範囲を超えています</span>'
        : issue.overlaps.length > 0
          ? '<span style="color:#c62828;font-weight:bold;">他の領域と重なっています</span>'
          : '<span style="color:#1a7f37;">収まっています</span>';
      const lo = Math.min(...region.storyIds.map((id) => storyIds.indexOf(id)));
      const hi = Math.max(...region.storyIds.map((id) => storyIds.indexOf(id)));
      const storyOptions = (selected) =>
        stories
          .map(
            (s, i) =>
              `<option value="${i}"${i === selected ? ' selected' : ''}>${escapeHtml(s.name)}</option>`,
          )
          .join('');
      const symbolChecks = symbols
        .map(
          (symbol) =>
            `<label style="display:inline-flex;align-items:center;gap:2px;margin:1px 6px 1px 0;"><input type="checkbox" data-field="symbol" value="${escapeHtml(symbol)}"${region.symbols.includes(symbol) ? ' checked' : ''}>${escapeHtml(symbol)}</label>`,
        )
        .join('');
      const pageOptions = pages
        .map(
          (_, i) => `<option value="${i}"${i === index ? ' selected' : ''}>ページ${i + 1}</option>`,
        )
        .join('');

      panelEl.innerHTML = `
        <div><strong>選択中の領域</strong><br>${Math.round(size.width)} × ${Math.round(size.height)} mm　${status}</div>
        <div style="display:flex;gap:6px;align-items:center;">
          X <input type="number" data-field="x" step="0.5" value="${round1(region.x)}" style="width:5.5em">
          Y <input type="number" data-field="y" step="0.5" value="${round1(region.y)}" style="width:5.5em"> mm
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          移動(1mm) <button type="button" data-action="nudge" data-dx="-1" data-dy="0">←</button>
          <button type="button" data-action="nudge" data-dx="0" data-dy="-1">↑</button>
          <button type="button" data-action="nudge" data-dx="0" data-dy="1">↓</button>
          <button type="button" data-action="nudge" data-dx="1" data-dy="0">→</button>
        </div>
        <label>ページ <select data-field="page">${pageOptions}</select></label>
        <label>見出し<br><input type="text" data-field="label" value="${escapeHtml(region.label)}" style="width:100%;box-sizing:border-box;"></label>
        <div>階 <select data-field="story-from">${storyOptions(lo)}</select> 〜 <select data-field="story-to">${storyOptions(hi)}</select></div>
        <div><div style="margin-bottom:2px;">符号</div>${symbolChecks}</div>
        <div style="display:flex;gap:6px;">
          <button type="button" data-action="duplicate">複製</button>
          <button type="button" data-action="delete-region">削除</button>
        </div>`;
    };

    const renderStatus = () => {
      const regions = allRegions();
      const uncovered = countUncoveredCells(regions, storyIds, symbols, hasCell);
      let outOfBounds = 0;
      let overlapping = 0;
      pages.forEach((page) => {
        issuesFor(page.regions).forEach((issue) => {
          if (issue.outOfBounds) outOfBounds += 1;
          if (issue.overlaps.length > 0) overlapping += 1;
        });
      });
      const bad = (n, label) =>
        n > 0 ? `<span style="color:#c62828;font-weight:bold;">${label} ${n}</span>` : `${label} 0`;
      statusEl.innerHTML = `${pages.length}ページ / ${regions.length}領域　${bad(uncovered, '未配置セル')}　${bad(outOfBounds, 'はみ出し')}　${bad(overlapping, '重なり')}　<span style="opacity:.7;">縮尺 1/${scale}・${paper().label}・実寸で配置（画面表示がそのままPDFになります）</span>`;
    };

    const renderAll = () => {
      renderToolbar();
      renderPages();
      renderPaper();
      renderPanel();
      renderStatus();
    };

    /** 位置だけが変わったとき（ドラッグ・数値入力）の軽量更新 */
    const refreshAfterMove = () => {
      renderPages();
      applyDecorations();
      renderStatus();
    };

    const fitZoom = () => {
      const widthPx = paper().width / MM_PER_PX;
      const available = Math.max(200, scroller.clientWidth - 32);
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, available / widthPx));
    };

    const setZoom = (value) => {
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
      renderPaper();
      const label = toolbar.querySelector('[data-part="zoom-label"]');
      if (label) label.textContent = `${Math.round(zoom * 100)}%`;
    };

    // ---- 操作 ----

    const moveRegion = (region, x, y) => {
      region.x = round1(x);
      region.y = round1(y);
      manuallyEdited = true;
      const node = scroller.querySelector(`[data-region-id="${region.id}"]`);
      if (node) {
        node.style.left = `${region.x}mm`;
        node.style.top = `${region.y}mm`;
      }
    };

    const selectRegion = (id) => {
      if (selectedId === id) return;
      selectedId = id;
      applyDecorations();
      renderPanel();
    };

    function startDrag(event, region, node) {
      if (event.button !== 0) return;
      event.preventDefault();
      selectRegion(region.id);
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = region.x;
      const originY = region.y;
      const size = sizeOf(region);
      const others = currentRegions()
        .filter((r) => r !== region)
        .map((r) => ({ x: r.x, y: r.y, ...sizeOf(r) }));
      node.setPointerCapture?.(event.pointerId);

      const onMove = (e) => {
        const dx = ((e.clientX - startX) / zoom) * MM_PER_PX;
        const dy = ((e.clientY - startY) / zoom) * MM_PER_PX;
        const rect = { x: originX + dx, y: originY + dy, ...size };
        const snapped = e.altKey ? rect : snapPosition(rect, others, paper());
        moveRegion(region, snapped.x, snapped.y);
        const xi = panelEl.querySelector('[data-field="x"]');
        const yi = panelEl.querySelector('[data-field="y"]');
        if (xi) xi.value = round1(region.x);
        if (yi) yi.value = round1(region.y);
      };
      const onUp = () => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        refreshAfterMove();
        renderPanel();
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    }

    const nudge = (dx, dy) => {
      const region = findRegion(selectedId);
      if (!region) return;
      moveRegion(region, region.x + dx, region.y + dy);
      refreshAfterMove();
      renderPanel();
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(null);
        return;
      }
      const tag = document.activeElement?.tagName;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const keys = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (keys[event.key] && selectedId) {
        event.preventDefault();
        event.stopPropagation();
        nudge(...keys[event.key]);
      }
    };

    const changeComposition = (region, nextSymbols, nextStoryIds) => {
      if (nextSymbols.length === 0 || nextStoryIds.length === 0) {
        renderPanel();
        return;
      }
      region.symbols = nextSymbols;
      region.storyIds = nextStoryIds;
      if (region.autoLabel) region.label = defaultRegionLabel(region, nameOf);
      manuallyEdited = true;
      renderAll();
    };

    const moveToPage = (region, pageIndex) => {
      pages.forEach((page) => {
        page.regions = page.regions.filter((r) => r !== region);
      });
      pages[pageIndex].regions.push(region);
      currentPage = pageIndex;
      manuallyEdited = true;
      renderAll();
    };

    const onScaleChange = (value) => {
      scale = value;
      setScale(value);
      sizeCache.clear();
      if (!manuallyEdited) repack(allRegions());
      renderAll();
    };

    root.addEventListener('change', (event) => {
      const el = event.target;
      const field = el.dataset?.field;
      if (!field) return;
      const region = findRegion(selectedId);

      if (field === 'paper') {
        paperKey = el.value;
        fitZoom();
        renderAll();
      } else if (field === 'scale') {
        onScaleChange(Number(el.value));
      } else if (field === 'columns') {
        compactColumns = el.value === 'compact';
        sizeCache.clear();
        if (!manuallyEdited) repack(allRegions());
        renderAll();
      } else if (!region) {
        // 以下は領域選択中のみ
      } else if (field === 'x' || field === 'y') {
        const value = Number(el.value);
        if (Number.isFinite(value)) {
          moveRegion(region, field === 'x' ? value : region.x, field === 'y' ? value : region.y);
        }
        refreshAfterMove();
        renderPanel();
      } else if (field === 'page') {
        moveToPage(region, Number(el.value));
      } else if (field === 'label') {
        region.label = el.value;
        region.autoLabel = false;
        renderAll();
      } else if (field === 'story-from' || field === 'story-to') {
        const from = Number(panelEl.querySelector('[data-field="story-from"]').value);
        const to = Number(panelEl.querySelector('[data-field="story-to"]').value);
        changeComposition(
          region,
          region.symbols,
          storyIds.slice(Math.min(from, to), Math.max(from, to) + 1),
        );
      } else if (field === 'symbol') {
        const checked = new Set(
          [...panelEl.querySelectorAll('[data-field="symbol"]:checked')].map((c) => c.value),
        );
        changeComposition(
          region,
          symbols.filter((s) => checked.has(s)),
          region.storyIds,
        );
      }
    });

    root.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      const region = findRegion(selectedId);
      switch (button.dataset.action) {
        case 'zoom-in':
          setZoom(zoom * 1.25);
          break;
        case 'zoom-out':
          setZoom(zoom / 1.25);
          break;
        case 'zoom-fit':
          fitZoom();
          setZoom(zoom);
          break;
        case 'repack':
          repack(allRegions());
          renderAll();
          break;
        case 'autosplit': {
          sizeCache.clear();
          regionSeq = 0;
          selectedId = null;
          repack(autoSplit(paperKey, { compactColumns }).map(makeRegion));
          renderAll();
          break;
        }
        case 'page':
          currentPage = Number(button.dataset.index);
          selectedId = null;
          renderAll();
          break;
        case 'add-page':
          pages.push({ regions: [] });
          currentPage = pages.length - 1;
          selectedId = null;
          renderAll();
          break;
        case 'remove-page':
          pages.splice(currentPage, 1);
          currentPage = Math.max(0, currentPage - 1);
          selectedId = null;
          renderAll();
          break;
        case 'nudge':
          nudge(Number(button.dataset.dx), Number(button.dataset.dy));
          break;
        case 'duplicate':
          if (region) {
            const copy = {
              ...makeRegion(region),
              label: region.label,
              autoLabel: region.autoLabel,
              x: region.x + 5,
              y: region.y + 5,
            };
            currentRegions().push(copy);
            selectedId = copy.id;
            manuallyEdited = true;
            renderAll();
          }
          break;
        case 'delete-region':
          if (region) {
            pages.forEach((page) => {
              page.regions = page.regions.filter((r) => r !== region);
            });
            selectedId = null;
            manuallyEdited = true;
            renderAll();
          }
          break;
        case 'back':
          close({ action: 'back' });
          break;
        case 'cancel':
          close(null);
          break;
        case 'save-project':
        case 'export': {
          const toProject = button.dataset.action === 'save-project';
          if (toProject && !paperKey.startsWith('a3-')) {
            window.alert(
              '共通DrawingProjectへの保存はA3シートのみ対応しています。A4の既存PDF出力は利用できます。',
            );
            break;
          }
          const nonEmpty = pages.filter((page) => page.regions.length > 0);
          if (nonEmpty.length === 0) {
            window.alert('出力する領域がありません。領域を追加してください。');
            break;
          }
          const problems = nonEmpty.some((page) =>
            issuesFor(page.regions).some((i) => i.outOfBounds || i.overlaps.length > 0),
          );
          const uncovered = countUncoveredCells(allRegions(), storyIds, symbols, hasCell);
          if (toProject && problems) {
            window.alert('共通シートに用紙外・重複領域は保存できません。配置を修正してください。');
            break;
          }
          if (
            !toProject &&
            (problems || uncovered > 0) &&
            !window.confirm(
              `はみ出し・重なり${uncovered > 0 ? `・未配置セル(${uncovered})` : ''}があります。` +
                '用紙外の部分は出力されません。このままPDF出力しますか？',
            )
          ) {
            break;
          }
          close({
            action: toProject ? 'save-project' : 'export',
            paperKey,
            compactColumns,
            scaleDenominator: scale,
            pages: pages.map((page) => ({
              regions: page.regions.map((r) => ({
                id: r.id,
                symbols: [...r.symbols],
                storyIds: [...r.storyIds],
                x: r.x,
                y: r.y,
                widthMm: sizeOf(r).width,
                heightMm: sizeOf(r).height,
                label: r.label,
                autoLabel: r.autoLabel,
              })),
            })),
          });
          break;
        }
        default:
          break;
      }
    });

    // 余白(用紙外)クリックで選択解除
    scroller.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.section-sheet-region')) {
        selectedId = null;
        applyDecorations();
        renderPanel();
      }
    });

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);

    if (initialLayout?.pages?.length) {
      pages = initialLayout.pages.map((page) => ({
        regions: page.regions.map((r) => ({
          id: r.id,
          symbols: [...r.symbols],
          storyIds: [...r.storyIds],
          x: r.x,
          y: r.y,
          label: r.label,
          autoLabel: r.autoLabel,
        })),
      }));
      manuallyEdited = true;
    } else {
      repack(sheets.map(makeRegion));
    }
    fitZoom();
    renderAll();
  });
}

export default openSheetEditor;
