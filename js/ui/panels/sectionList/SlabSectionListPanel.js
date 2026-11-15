/**
 * #529 Editable slab schedule. Uses P0 facts, P2 resolver and immutable overrides.
 * PDF/DXF and authoritative DrawingProject commit are owned by #530/#528.
 */
import { getState } from '../../../data/state/globalState.js';
import {
  SLAB_XML_MAX_BYTES,
  SLAB_JSON_BACKUP_MAX_BYTES,
  verifySlabXmlSources,
  completedSlabSaveState,
  isSlabImportCurrent,
} from './slabListPanelGuards.js';
import {
  buildSlabOutputSnapshot,
  buildSlabOutputPages,
  produceSlabListView,
  downloadSlabCsv,
  downloadSlabSvgs,
  downloadSlabPdf,
  downloadSlabDxf,
} from './slabListOutput.js';
import {
  resolveSectionListDrawingProjectContext,
  commitSectionListDrawingProjectLayout,
  loadSectionListDrawingProjectLayout,
} from './sectionListDrawingProjectWorkflow.js';
import { createLogger } from '../../../utils/logger.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import {
  readCurrentSlabListDrawingProjectState,
  writeCurrentSlabListDrawingProjectState,
} from './slabListDrawingProjectPersistence.js';
import { extractSlabSectionFacts } from '../../../data/extractors/slabList/slabSectionFacts.js';
import {
  AUXILIARY_BAR_LAYOUTS,
  cloneStbSlabBars,
} from '../../../data/extractors/slabList/slabAuxiliaryBars.js';
import { parseSlabDesignXml } from '../../../data/extractors/slabList/slabDesignXmlAdapter.js';
import {
  createSlabListState,
  normalizeSlabListState,
  resolveSlabList,
  setSlabListOverride,
  removeSlabListOverride,
  setSlabListMapping,
  addSlabListAuxiliaryRow,
  updateSlabListAuxiliaryRow,
  deleteSlabListAuxiliaryRow,
} from '../../../data/extractors/slabList/slabListResolver.js';
import {
  buildSlabListRows,
  visibleSlabListRows,
  slabCell,
  slabDisplayField,
  canEditSlabField,
  canMapSlabRow,
  parseSlabEditValue,
  barDisplay,
  slabProjectionCell,
} from './slabListViewModel.js';

const log = createLogger('ui/SlabSectionListPanel');
const WINDOW_ID = 'slab-section-list-window';
const EDIT_FIELDS = Object.freeze([
  ['symbol', '符号'],
  ['thicknessMm', 'スラブ厚 (mm)'],
  ['notes', '備考'],
]);
const BAR_LAYOUT_LABELS = Object.freeze({
  STANDARD: 'STANDARD（柱列帯／中間帯）',
  '2WAY_202': '2WAY STB 2.0.2（帯区分なし）',
  '2WAY_21X': '2WAY STB 2.1.x（端部／中央）',
  '1WAY1': '1WAY1（主筋／配力筋）',
  '1WAY2': '1WAY2（BASE／TIP）',
});
const editFocusKey = (area, row, field) => JSON.stringify([area, row.id, field]);

function element(tag, label = '', className = '') {
  const node = document.createElement(tag);
  if (label !== null) node.textContent = String(label);
  if (className) node.className = className;
  return node;
}

function button(label, action) {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function appendRow(parent, label, value) {
  const line = element('div', null, 'slab-list-detail-line');
  line.append(element('strong', label + ': '), element('span', value ?? '—'));
  parent.appendChild(line);
}

async function domRevision(doc) {
  // DOM-snapshot fingerprint, never claimed to be SHA-256 of the original STB file.
  if (!globalThis.crypto?.subtle || !globalThis.XMLSerializer) return null;
  const content = new XMLSerializer().serializeToString(doc);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class SlabSectionListPanel {
  constructor({ readState = null, writeState = null } = {}) {
    this.readState = readState;
    this.writeState = writeState;
    this.ledger = createSlabListState();
    this.savedLedger = createSlabListState();
    this.undoStack = [];
    this.side = 'A';
    this.zone = 'END';
    this.query = '';
    this.story = '';
    this.hideEmpty = true;
    this.detailsVisible = false;
    this.initialWindowSizeApplied = false;
    this.rows = [];
    this.stories = [];
    this.xmlBySide = { A: null, B: null };
    this.hashBySide = { A: null, B: null };
    this.revisionBySide = { A: null, B: null };
    this.selectedId = null;
    this.refreshTicket = 0;
    this.initialized = false;
    this.dirty = false;
    this.saving = false;
    this.xmlImportTicket = 0;
    this.jsonImportTicket = 0;
    this.pendingFocusKey = null;
    this.pendingFocusNavigation = false;
  }

  init() {
    if (this.initialized) return this;
    const beamToggle = document.getElementById('showBeamSectionListBtn');
    if (!document.getElementById('showSlabSectionListBtn') && beamToggle?.parentElement) {
      const trigger = element('button', 'RCスラブリスト', 'btn btn-secondary');
      trigger.id = 'showSlabSectionListBtn';
      trigger.type = 'button';
      beamToggle.insertAdjacentElement('afterend', trigger);
    }
    const root = element('div', null, 'floating-window slab-section-list-window hidden');
    root.id = WINDOW_ID;
    root.style.cssText = 'width:min(1320px,96vw);height:min(820px,90vh);';
    this.root = root;
    const header = element('div', null, 'float-window-header');
    header.id = WINDOW_ID + '-header';
    header.appendChild(element('span', 'RCスラブリスト', 'float-window-title'));
    const controls = element('div', null, 'float-window-controls');
    const maximize = button('□', () => {
      const maximized = root.classList.toggle('slab-list-maximized');
      maximize.textContent = maximized ? '❐' : '□';
      maximize.setAttribute('aria-label', maximized ? '元のサイズに戻す' : 'スラブリストを最大化');
      maximize.title = maximized ? '元のサイズに戻す' : '最大化';
    });
    maximize.className = 'float-window-btn';
    maximize.setAttribute('aria-label', 'スラブリストを最大化');
    maximize.title = '最大化';
    controls.appendChild(maximize);
    const close = button('✕', () => {});
    close.id = 'close-' + WINDOW_ID + '-btn';
    close.className = 'float-window-btn';
    controls.appendChild(close);
    header.appendChild(controls);
    root.appendChild(header);

    const content = element('div', null, 'float-window-content slab-section-list-content');
    content.style.cssText =
      'height:calc(100% - 38px);display:flex;flex-direction:column;gap:8px;overflow:hidden;padding:10px;';
    const toolbar = element('div', null, 'slab-list-toolbar');
    // Layout belongs to section-list.css; avoid inline widths on the editing surface.
    const source = element('select');
    for (const id of ['A', 'B']) {
      const option = element('option', 'モデル' + id);
      option.value = id;
      source.appendChild(option);
    }
    source.setAttribute('aria-label', 'STBモデル');
    source.addEventListener('change', () => {
      if (this.dirty && !confirm('未保存の編集を破棄してモデルを切り替えますか？')) {
        source.value = this.side;
        return;
      }
      this.xmlImportTicket++;
      this.discard();
      this.side = source.value;
      this.selectedId = null;
      this.refresh();
    });
    toolbar.appendChild(source);
    const xmlPicker = element('input');
    xmlPicker.type = 'file';
    xmlPicker.hidden = true;
    xmlPicker.accept = '.xml,application/xml,text/xml';
    xmlPicker.setAttribute('aria-label', '計算ソフトのスラブ設計XMLを選択');
    xmlPicker.addEventListener('change', async () => {
      const file = xmlPicker.files?.[0];
      if (file) await this.importXml(file);
      xmlPicker.value = '';
    });
    toolbar.append(
      button('計算XML読込', () => xmlPicker.click()),
      xmlPicker,
    );
    const search = element('input');
    search.type = 'search';
    search.placeholder = '符号・断面IDを検索';
    search.setAttribute('aria-label', '符号・断面IDで検索');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.render();
    });
    toolbar.appendChild(search);
    this.storySelect = element('select');
    this.storySelect.setAttribute('aria-label', '階フィルター');
    this.storySelect.addEventListener('change', () => {
      this.story = this.storySelect.value;
      this.render();
    });
    toolbar.appendChild(this.storySelect);
    const zone = element('select');
    zone.setAttribute('aria-label', '鉄筋表示位置');
    for (const [id, title] of [
      ['END', '端部'],
      ['CENTER', '中央'],
    ]) {
      const option = element('option', title);
      option.value = id;
      zone.appendChild(option);
    }
    zone.addEventListener('change', () => {
      this.zone = zone.value;
      this.render();
    });
    toolbar.appendChild(zone);
    const hidden = element('label');
    const check = element('input');
    check.type = 'checkbox';
    check.checked = this.hideEmpty;
    check.addEventListener('change', () => {
      this.hideEmpty = check.checked;
      this.render();
    });
    hidden.append(check, document.createTextNode(' 未入力XML行を非表示'));
    toolbar.appendChild(hidden);
    toolbar.appendChild(button('更新', () => this.refresh()));
    const detailToggle = button('詳細を表示', () => this.showDetails(!this.detailsVisible));
    detailToggle.className = 'slab-list-detail-toggle';
    detailToggle.setAttribute('aria-expanded', 'false');
    toolbar.appendChild(detailToggle);
    const save = button('プロジェクトへ保存', () => this.save());
    save.className = 'slab-list-save-btn';
    this.saveButton = save;
    save.disabled = typeof this.writeState !== 'function';
    if (save.disabled) save.title = '#528 のDrawingProject保存接続が必要です';
    toolbar.appendChild(save);

    // Keep the grid area usable: all export operations share one compact control.
    const output = element('select');
    output.setAttribute('aria-label', 'スラブリスト出力・シート配置');
    for (const [title, format] of [
      ['出力・シート', ''],
      ['CSV出力', 'csv'],
      ['SVG出力', 'svg'],
      ['PDF出力', 'pdf'],
      ['DXF出力 (AutoCAD)', 'dxf'],
      ['DXF出力 (Jw_cad)', 'dxf-jwcad'],
      ['A3シートへ配置', 'sheet'],
      ['保存シートPDF', 'stored-pdf'],
    ]) {
      const option = element('option', title);
      option.value = format;
      output.appendChild(option);
    }
    output.addEventListener('change', () => {
      const format = output.value;
      output.value = '';
      if (!format) return;
      this.exportSlabOutput(format).catch((error) => {
        this.status.textContent = 'スラブリスト出力エラー: ' + error.message;
        log.error('Slab schedule output failed', error);
      });
    });
    toolbar.appendChild(output);
    const advanced = element('details', null, 'slab-list-more');
    advanced.appendChild(element('summary', '編集・バックアップ'));
    const advancedBody = element('div', null, 'slab-list-more-body');
    advancedBody.appendChild(button('補助行追加', () => this.addAuxiliary()));
    advancedBody.appendChild(button('Undo', () => this.undo()));
    advancedBody.appendChild(button('変更破棄', () => this.discard()));
    advancedBody.appendChild(button('変更JSON保存', () => this.exportStateJson()));
    const jsonPicker = element('input');
    jsonPicker.type = 'file';
    jsonPicker.hidden = true;
    jsonPicker.accept = '.json,application/json';
    jsonPicker.setAttribute('aria-label', 'スラブリスト変更JSONを読込');
    jsonPicker.addEventListener('change', async () => {
      if (jsonPicker.files?.[0]) await this.importStateJson(jsonPicker.files[0]);
      jsonPicker.value = '';
    });
    advancedBody.append(
      button('変更JSON読込', () => jsonPicker.click()),
      jsonPicker,
    );
    advanced.appendChild(advancedBody);
    toolbar.appendChild(advanced);
    this.detailToggle = detailToggle;
    this.status = element('span', '', 'slab-list-status');
    this.status.setAttribute('role', 'status');
    toolbar.appendChild(this.status);
    content.appendChild(toolbar);

    const layout = element('div', null, 'slab-list-layout');
    layout.style.cssText = 'min-height:0;flex:1;position:relative;';
    this.tableArea = element('div', null, 'slab-list-table-area');
    this.tableArea.style.cssText = 'overflow:auto;min-width:0;height:100%;';
    this.inspector = element('div', null, 'slab-list-inspector');
    this.inspector.style.cssText = 'overflow:auto;min-width:0;';
    layout.append(this.tableArea, this.inspector);
    this.showDetails(false);
    content.appendChild(layout);
    root.appendChild(content);
    document.body.appendChild(root);
    floatingWindowManager.registerWindow({
      windowId: WINDOW_ID,
      toggleButtonId: 'showSlabSectionListBtn',
      closeButtonId: close.id,
      headerId: header.id,
      draggable: true,
      resizable: true,
      autoShow: false,
      onShow: () => {
        this.ensureReadableWindowSize();
        // A DrawingProject may have been opened after the floating window initialized.
        if (!this.dirty && !this.saving && typeof this.readState === 'function') {
          this.load().catch((error) => {
            this.status.textContent = 'プロジェクト読込エラー: ' + error.message;
          });
        } else {
          this.refresh();
        }
      },
    });
    this.initialized = true;
    if (typeof this.readState === 'function') {
      this.load().catch((error) => {
        this.status.textContent = 'プロジェクト読込エラー: ' + error.message;
      });
    }
    return this;
  }

  /**
   * Once per page load, migrate obsolete small floating-window bounds.
   * FloatingWindowManager restores the previous width after init(), which
   * otherwise defeats the larger schedule dimensions on every reopening.
   * Later user resizing within this session is respected.
   */
  ensureReadableWindowSize() {
    if (this.initialWindowSizeApplied || !this.root) return;
    const width = globalThis.window?.innerWidth;
    const height = globalThis.window?.innerHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const bounds = this.root.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    this.initialWindowSizeApplied = true;
    if (this.root.classList.contains('slab-list-maximized')) return;
    const targetWidth = Math.min(1320, Math.max(240, width - 32));
    const targetHeight = Math.min(820, Math.max(240, height - 32));
    if (bounds.width < targetWidth - 24) {
      this.root.style.width = targetWidth + 'px';
      this.root.style.left = Math.max(0, (width - targetWidth) / 2) + 'px';
      this.root.style.right = 'auto';
      this.root.style.transform = 'none';
    }
    if (bounds.height < targetHeight - 24) {
      this.root.style.height = targetHeight + 'px';
      this.root.style.top = Math.max(0, (height - targetHeight) / 2) + 'px';
      this.root.style.bottom = 'auto';
    }
  }

  async refresh() {
    const ticket = ++this.refreshTicket;
    const doc = getState(this.side === 'A' ? 'models.documentA' : 'models.documentB');
    if (!doc) {
      this.revisionBySide[this.side] = null;
      this.stories = [];
      try {
        this.rows = buildSlabListRows(
          resolveSlabList({
            xmlFacts: this.xmlBySide[this.side],
            xmlSourceHash: this.hashBySide[this.side],
            state: this.ledger,
            modelSide: this.side,
          }),
          { auxiliaryRows: this.ledger.auxiliaryRows, modelSide: this.side },
        );
        this.render();
        this.status.textContent =
          'モデル' + this.side + 'は未読込 / XML-only参照 ' + this.rows.length + '件';
      } catch (error) {
        this.rows = [];
        this.render();
        this.status.textContent = '補助XML読込エラー: ' + error.message;
      }
      return;
    }
    try {
      const revision = await domRevision(doc);
      if (ticket !== this.refreshTicket) return;
      const facts = extractSlabSectionFacts(doc, { modelSide: this.side, revision });
      this.revisionBySide[this.side] = revision;
      const resolved = resolveSlabList({
        stbFacts: facts,
        state: this.ledger,
        xmlFacts: this.xmlBySide[this.side],
        xmlSourceHash: this.hashBySide[this.side],
      });
      this.rows = buildSlabListRows(resolved, {
        auxiliaryRows: this.ledger.auxiliaryRows || [],
        modelSide: this.side,
        stbRevision: revision,
      });
      this.stories = Array.from(doc.getElementsByTagName('*'))
        .filter((node) => (node.localName || node.tagName?.split(':').pop()) === 'StbStory')
        .map((story) => ({
          id: story.getAttribute('id'),
          name: story.getAttribute('name') || story.getAttribute('id'),
        }));
      this.render();
    } catch (error) {
      log.error('Slab list refresh failed', error);
      this.status.textContent = '読込エラー: ' + error.message;
    }
  }

  render() {
    if (!this.initialized) return;
    const active = document.activeElement;
    const activeKey =
      this.tableArea.contains(active) || this.inspector.contains(active)
        ? active?.dataset?.slabFocusKey
        : null;
    // Prefer a newly focused field after pointer-driven blur. For explicit
    // Enter/Tab navigation, the selected destination takes precedence.
    const focusKey = this.pendingFocusNavigation
      ? this.pendingFocusKey
      : activeKey || this.pendingFocusKey;
    const start =
      activeKey === focusKey && typeof active.selectionStart === 'number'
        ? active.selectionStart
        : null;
    const end =
      activeKey === focusKey && typeof active.selectionEnd === 'number'
        ? active.selectionEnd
        : null;
    const tableScroll = this.tableArea.scrollTop;
    const tableScrollLeft = this.tableArea.scrollLeft;
    const detailScroll = this.inspector.scrollTop;
    this.pendingFocusKey = null;
    this.pendingFocusNavigation = false;
    this.status.textContent = this.dirty ? '未保存の変更あり' : '未編集／保存済み';
    const previousStory = this.story;
    this.storySelect.replaceChildren(new globalThis.Option('全階', ''));
    for (const story of this.stories)
      this.storySelect.appendChild(new globalThis.Option(story.name, story.id));
    if (!this.stories.some((s) => s.id === previousStory)) this.story = '';
    this.storySelect.value = this.story;
    const visible = visibleSlabListRows(this.rows, {
      search: this.query,
      storyId: this.story,
      hideEmpty: this.hideEmpty,
    });
    const table = element('table', null, 'slab-section-grid-table');
    const caption = element('caption', 'スラブリスト　' + visible.length + '件表示');
    table.appendChild(caption);
    const head = element('thead');
    const header = element('tr');
    for (const label of ['符号', 'スラブ厚 (mm)', '位置', '短辺方向', '長辺方向', '備考']) {
      header.appendChild(element('th', label));
    }
    head.appendChild(header);
    table.appendChild(head);
    const body = element('tbody');
    for (const row of visible) {
      const tr = element('tr');
      tr.tabIndex = 0;
      if (row.id === this.selectedId) tr.classList.add('selected');
      const symbol = slabDisplayField(row, 'symbol');
      const thickness = slabDisplayField(row, 'thicknessMm');
      const notes = slabDisplayField(row, 'notes');
      const barLayout = row.auxiliary?.barLayout || row.section?.barPattern;
      const unzoned2Way =
        row.auxiliary?.barLayout === '2WAY_202' ||
        (row.section?.barPattern === '2WAY' &&
          String(row.section.version || '').startsWith('2.0.2'));
      if (unzoned2Way) tr.title = '2WAY 2.0.2：端部／中央の帯区分はありません';
      if (['1WAY1', '1WAY2'].includes(barLayout))
        tr.title = '1WAYのMAIN/TRANSVERSEをSHORT/LONGへ推定変換しません';

      const editableCell = (field, value, label) => {
        const td = element('td', null, 'slab-list-simple-cell');
        if (canEditSlabField(row, field)) {
          const input = element('input', null, 'slab-list-cell-input');
          input.value = value;
          input.setAttribute(
            'aria-label',
            label + ' ' + String(row.auxiliary?.id || row.sectionId),
          );
          this.attachEditor(input, row, field, 'grid');
          td.appendChild(input);
        } else {
          td.textContent = value || '—';
        }
        return td;
      };
      const symbolCell = editableCell('symbol', symbol.value || row.symbol || '', '符号');
      const mappingState = row.mapping?.state || (row.section ? 'STB_ONLY' : 'XML_ONLY');
      const pattern = row.auxiliary?.barLayout || row.section?.barPattern || '';
      const meta = element(
        'small',
        [mappingState, pattern].filter(Boolean).join(' / '),
        'slab-list-row-status',
      );
      meta.title = '照合状態 / STB配筋体系';
      if (['AMBIGUOUS', 'NEEDS_REVIEW', 'STALE'].includes(mappingState))
        meta.classList.add('slab-list-row-warning');
      symbolCell.appendChild(meta);
      tr.appendChild(symbolCell);
      tr.appendChild(editableCell('thicknessMm', thickness.value, '厚さ'));

      const position = element('td', null, 'slab-list-position-cell');
      for (const face of ['TOP', 'BOTTOM']) {
        position.appendChild(element('div', face === 'TOP' ? '上' : '下', 'slab-list-pair-line'));
      }
      tr.appendChild(position);

      for (const dir of ['SHORT', 'LONG']) {
        const td = element('td', null, 'slab-list-pair-cell');
        for (const face of ['TOP', 'BOTTOM']) {
          const rawCell =
            unzoned2Way && !row.auxiliary
              ? row.projection?.extraCells?.[dir + '_' + face]
              : row.projection?.cells?.[[dir, face, this.zone].join('_')];
          const result = row.auxiliary
            ? slabCell(row, dir, face, this.zone)
            : slabProjectionCell(row, rawCell);
          const state = result?.state || result?.status || 'MISSING';
          const display =
            state === 'VALID'
              ? String(result.value ?? result.display ?? '')
              : state === 'AMBIGUOUS'
                ? '要確認'
                : state === 'INVALID'
                  ? '不正値'
                  : state === 'NOT_APPLICABLE'
                    ? '対象外'
                    : '—';
          const line = element('div', null, 'slab-list-pair-line');
          if (state !== 'VALID') line.classList.add('slab-list-' + state.toLowerCase());
          let sourcePos = null;
          if (row.auxiliary && ['2WAY_202', '2WAY_21X', 'STANDARD'].includes(barLayout)) {
            if (barLayout === '2WAY_202') sourcePos = dir + '_' + face;
            else if (barLayout === '2WAY_21X') sourcePos = [dir, face, this.zone].join('_');
            else if (this.zone === 'CENTER') sourcePos = [dir, face, 'MID_CENTER'].join('_');
          } else if (rawCell?.sourcePositions?.length === 1) {
            sourcePos = rawCell.sourcePositions[0];
          }
          const field = sourcePos ? 'bar:' + sourcePos : null;
          if (state === 'VALID' && field && canEditSlabField(row, field)) {
            const input = element('input', null, 'slab-list-cell-input');
            input.value = display;
            input.setAttribute(
              'aria-label',
              dir + ' ' + face + ' 配筋 ' + String(row.auxiliary?.id || row.sectionId),
            );
            this.attachEditor(input, row, field, 'grid');
            line.appendChild(input);
          } else {
            line.textContent = display;
            if (state === 'AMBIGUOUS' || state === 'INVALID')
              line.title = '詳細パネルで原STBの配筋位置・診断を確認してください';
          }
          td.appendChild(line);
        }
        tr.appendChild(td);
      }
      tr.appendChild(editableCell('notes', notes.value, '備考'));
      const choose = () => {
        this.selectedId = row.id;
        this.showDetails(true);
        this.render();
      };
      tr.addEventListener('click', (event) => {
        if (!event.target.closest('input,textarea,button,select')) choose();
      });
      tr.addEventListener('keydown', (event) => {
        if (event.target !== tr) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose();
        }
      });
      body.appendChild(tr);
    }
    table.appendChild(body);
    this.tableArea.replaceChildren(table);
    this.renderDetail(this.rows.find((row) => row.id === this.selectedId));
    this.tableArea.scrollTop = tableScroll;
    this.tableArea.scrollLeft = tableScrollLeft;
    this.inspector.scrollTop = detailScroll;
    if (focusKey) {
      const input = [
        ...this.tableArea.querySelectorAll('[data-slab-focus-key]'),
        ...this.inspector.querySelectorAll('[data-slab-focus-key]'),
      ].find((node) => node.dataset.slabFocusKey === focusKey);
      if (input && !input.disabled) {
        input.focus({ preventScroll: true });
        if (start !== null && end !== null && typeof input.setSelectionRange === 'function')
          input.setSelectionRange(start, end);
      }
    }
  }

  showDetails(visible) {
    this.detailsVisible = Boolean(visible);
    this.root?.classList.toggle('show-slab-details', this.detailsVisible);
    if (this.detailToggle) {
      this.detailToggle.textContent = this.detailsVisible ? '詳細を閉じる' : '詳細を表示';
      this.detailToggle.setAttribute('aria-expanded', String(this.detailsVisible));
    }
  }

  /** Change commits without destroying focus; Enter/Tab navigate editable cells. */
  attachEditor(input, row, field, area) {
    const key = editFocusKey(area, row, field);
    // Use the value actually rendered in the editor. For STB bar positions,
    // resolvedFields may omit a field even when the source bar has valid text.
    // Treating that case as an empty original wrote phantom overrides on Enter.
    let original = input.value;
    input.dataset.slabFocusKey = key;
    input.dataset.slabFocusArea = area;
    input.addEventListener('click', (event) => event.stopPropagation());
    if (area === 'grid')
      input.addEventListener('focus', () => {
        if (this.selectedId !== row.id) {
          this.selectedId = row.id;
          this.renderDetail(row);
        }
      });
    const commit = (targetKey = key) => {
      if (input.value === original) return false;
      // Chromium may emit change again when a focused input is detached.
      // Mark this value committed before refresh so keyboard navigation survives.
      original = input.value;
      this.pendingFocusKey = targetKey;
      this.edit(row, field, input.value);
      return true;
    };
    input.addEventListener('change', () => commit());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        input.value = original;
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        const inputs = [
          ...(area === 'grid' ? this.tableArea : this.inspector).querySelectorAll(
            'input[data-slab-focus-key]',
          ),
        ].filter((node) => !node.disabled);
        const index = inputs.indexOf(input);
        const direction = event.key === 'Tab' && event.shiftKey ? -1 : 1;
        const next = inputs[index + direction];
        if (!next && event.key === 'Tab') {
          // Preserve native Tab at the edge; don't trap keyboard users.
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const target = next || input;
        this.pendingFocusNavigation = true;
        if (!commit(target.dataset.slabFocusKey)) {
          this.pendingFocusNavigation = false;
          target.focus();
        }
      }
    });
  }

  renderDetail(row) {
    this.inspector.replaceChildren();
    const heading = element('div', null, 'slab-list-detail-heading');
    heading.append(
      element('strong', '詳細パラメータ'),
      button('閉じる', () => this.showDetails(false)),
    );
    this.inspector.appendChild(heading);
    if (!row) {
      this.inspector.appendChild(element('p', '一覧から断面を選択してください。'));
      return;
    }
    this.inspector.appendChild(
      element('h3', slabDisplayField(row, 'symbol').value || row.symbol || '無題'),
    );
    if (row.auxiliary || (row.section && canMapSlabRow(row)))
      this.inspector.appendChild(button('補助行として複製', () => this.addAuxiliary(row)));
    if (row.auxiliary) {
      appendRow(this.inspector, '行種別', '独立した補助行（STB原本には反映しません）');
      appendRow(this.inspector, '参照元STB断面ID', row.auxiliary.sourceSectionId || 'なし');
      this.inspector.appendChild(button('この補助行を削除', () => this.removeAuxiliary(row)));
    }
    appendRow(
      this.inspector,
      'STB断面ID',
      row.auxiliary ? '補助行（原STB非変更）' : row.sectionId || 'XMLのみ',
    );
    appendRow(this.inspector, '状態', row.mapping?.state);
    appendRow(
      this.inspector,
      '配筋配置',
      row.auxiliary
        ? BAR_LAYOUT_LABELS[row.auxiliary.barLayout] || '未指定（手動補助行）'
        : row.section?.barPattern,
    );
    appendRow(this.inspector, '形状', row.section?.shape?.type);
    appendRow(
      this.inspector,
      '使用階',
      row.auxiliary?.storyId || (row.section?.stb?.storyIds || []).join(', '),
    );
    if (
      row.section &&
      this.xmlBySide[this.side]?.ok &&
      this.hashBySide[this.side] &&
      canMapSlabRow(row)
    ) {
      this.inspector.appendChild(element('h4', '計算XMLとの明示対応'));
      const select = element('select');
      select.setAttribute('aria-label', '対応するXML Record');
      const empty = element('option', '対応先を選択');
      empty.value = '';
      select.appendChild(empty);
      for (const record of this.xmlBySide[this.side].records) {
        const opt = element('option', String(record.name || '無題') + ' / Record ' + record.index);
        opt.value = String(record.index);
        select.appendChild(opt);
      }
      select.value = row.mapping?.recordIndex == null ? '' : String(row.mapping.recordIndex);
      this.inspector.appendChild(select);
      this.inspector.appendChild(
        button('選択したRecordに明示LINK', () => {
          const record = this.xmlBySide[this.side].records.find(
            (r) => String(r.index) === select.value,
          );
          if (record) this.setMapping(row, 'LINK', record);
        }),
      );
      this.inspector.appendChild(
        button('対応解除（UNLINK）', () => this.setMapping(row, 'UNLINK', null)),
      );
    }
    const issues = [...row.diagnostics, ...row.sourceDiagnostics.map((d) => d.code)];
    if (issues.length) appendRow(this.inspector, '診断', issues.join(' / '));
    this.inspector.appendChild(element('h4', '採用値と編集'));
    for (const [field, label] of EDIT_FIELDS) {
      const resolved = slabDisplayField(row, field);
      const line = element('label', label + ' ');
      line.style.cssText = 'display:block;margin:8px 0;';
      const input = element('input');
      input.value = resolved.value;
      input.setAttribute('aria-label', label);
      input.style.maxWidth = '100%';
      input.disabled = !canEditSlabField(row, field);
      this.attachEditor(input, row, field, 'detail');
      line.appendChild(input);
      const source = element('small', ' ' + (resolved.source || resolved.status));
      line.appendChild(source);
      this.inspector.appendChild(line);
      if (resolved.conflict) {
        appendRow(
          this.inspector,
          label + ' 出典差異',
          'STB: ' + String(resolved.originalStb) + ' / XML: ' + String(resolved.originalXml),
        );
        if (canEditSlabField(row, field)) {
          if (resolved.originalStb != null)
            this.inspector.appendChild(
              button(label + ' STB値を上書き採用', () =>
                this.edit(row, field, resolved.originalStb),
              ),
            );
          if (resolved.originalXml != null)
            this.inspector.appendChild(
              button(label + ' XML値を上書き採用', () => {
                if (
                  field === 'thicknessMm' &&
                  !confirm('計算XMLのスラブ厚単位がmmであることを確認しましたか？')
                )
                  return;
                this.edit(row, field, resolved.originalXml);
              }),
            );
        }
      }
      if (resolved.source === 'OVERRIDE') {
        this.inspector.appendChild(
          button(label + ' の上書きを解除', () => this.removeOverride(row, field)),
        );
      }
    }
    this.inspector.appendChild(
      element(
        'h4',
        row.auxiliary ? '補助行の位置別配筋（STB原本は変更しません）' : 'STB原配置（全pos）',
      ),
    );
    if (row.auxiliary) {
      const selection = element('label', '配筋の配置体系 ');
      const layout = element('select');
      layout.setAttribute('aria-label', '補助行の配筋配置体系');
      const unset = element('option', '未指定（配筋を入力するには選択）');
      unset.value = '';
      layout.appendChild(unset);
      for (const [key, label] of Object.entries(BAR_LAYOUT_LABELS)) {
        const option = element('option', label);
        option.value = key;
        layout.appendChild(option);
      }
      layout.value = row.auxiliary.barLayout || '';
      layout.addEventListener('change', () => this.setAuxiliaryLayout(row, layout.value || null));
      selection.appendChild(layout);
      this.inspector.appendChild(selection);
    }
    const detailBars = row.auxiliary
      ? (AUXILIARY_BAR_LAYOUTS[row.auxiliary.barLayout] || []).map((pos) => ({ pos }))
      : row.section?.barPositions || [];
    for (const bar of detailBars) {
      const data = row.auxiliary
        ? {
            field: 'bar:' + bar.pos,
            value: row.auxiliary.barValues?.[bar.pos] || '',
            source: 'AUXILIARY',
          }
        : barDisplay(row, bar);
      const line = element('label', bar.pos + ' ');
      line.style.cssText = 'display:block;margin:8px 0;';
      const input = element('input');
      input.value = data.value;
      input.disabled = !canEditSlabField(row, data.field);
      input.setAttribute('aria-label', bar.pos + ' 配筋');
      this.attachEditor(input, row, data.field, 'detail');
      line.append(input, document.createTextNode(' ' + data.source));
      this.inspector.appendChild(line);
      if (!row.auxiliary) appendRow(this.inspector, bar.pos + ' 原値', data.raw);
      if (!row.auxiliary && data.source === 'OVERRIDE')
        this.inspector.appendChild(
          button('上書き解除: ' + bar.pos, () => this.removeOverride(row, data.field)),
        );
    }
    for (const bar of row.section?.openingBars || [])
      appendRow(this.inspector, '開口補強', JSON.stringify(bar.rawAttributes));
    for (const bar of row.section?.unsupportedBars || [])
      appendRow(this.inspector, '未対応配筋', JSON.stringify(bar.rawAttributes));
    if (row.projection?.extraCells && Object.keys(row.projection.extraCells).length)
      appendRow(this.inspector, '非標準配置', JSON.stringify(row.projection.extraCells));
    const record = row.xmlRecord;
    if (record) {
      this.inspector.appendChild(element('h4', '計算XML参照情報（再計算値ではありません）'));
      for (const [key, value] of Object.entries(record.fields || {}))
        appendRow(this.inspector, key, value.raw);
      for (const place of record.places || []) {
        appendRow(this.inspector, '位置', place.name);
        for (const [key, value] of Object.entries(place.design || {}))
          appendRow(this.inspector, key, value.raw);
        appendRow(this.inspector, '上端配筋', place.bars?.top?.raw);
        appendRow(this.inspector, '下端配筋', place.bars?.bottom?.raw);
      }
      appendRow(this.inspector, 'コンクリート材料', JSON.stringify(record.materials?.concrete));
      appendRow(this.inspector, '鉄筋材料', JSON.stringify(record.materials?.steel));
      appendRow(this.inspector, '支持・荷重条件', JSON.stringify(record.conditions));
    }
  }

  async importXml(file) {
    try {
      if (
        this.dirty &&
        !confirm('未保存の変更があります。XML追加後も現在の編集状態を引き継ぎますか？')
      )
        return;
      const selectedSide = this.side;
      const ticket = ++this.xmlImportTicket;
      if (file.size > SLAB_XML_MAX_BYTES) throw new TypeError('XMLは2MiB以下にしてください');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (ticket !== this.xmlImportTicket || selectedSide !== this.side)
        throw new Error('XML取込中に対象モデル／ファイルが変わりました。再選択してください');
      if (bytes.byteLength > SLAB_XML_MAX_BYTES) throw new TypeError('XMLは2MiB以下にしてください');
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const facts = parseSlabDesignXml(xml);
      if (!facts.ok) throw new TypeError(facts.diagnostics.map((d) => d.message).join(' / '));
      if (!globalThis.crypto?.subtle) throw new TypeError('SHA-256を計算できない環境です');
      const sha = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 16384)
        binary += String.fromCharCode(...bytes.slice(i, i + 16384));
      const source = { modelSide: selectedSide, sha256: sha, bytesBase64: globalThis.btoa(binary) };
      if (ticket !== this.xmlImportTicket || selectedSide !== this.side)
        throw new Error('XML取込中に対象モデル／ファイルが変わりました。再選択してください');
      const before = this.ledger;
      this.ledger = normalizeSlabListState({
        ...before,
        xmlSources: [...before.xmlSources.filter((x) => x.modelSide !== selectedSide), source],
      });
      this.undoStack.push(before);
      this.xmlBySide[selectedSide] = facts;
      this.hashBySide[selectedSide] = sha;
      this.dirty = true;
      await this.refresh();
    } catch (error) {
      this.status.textContent = 'XML取込エラー: ' + error.message;
    }
  }

  setMapping(row, decision, record) {
    if (!canMapSlabRow(row) || !this.hashBySide[this.side]) return;
    try {
      const before = this.ledger;
      this.ledger = setSlabListMapping(before, {
        modelSide: row.modelSide,
        sectionId: row.sectionId,
        stbRevision: row.stbRevision,
        xmlSourceHash: this.hashBySide[this.side],
        recordIndex: record?.index ?? null,
        recordName: record?.name ?? null,
        decision,
      });
      this.undoStack.push(before);
      this.dirty = true;
      this.refresh();
    } catch (error) {
      this.status.textContent = '照合エラー: ' + error.message;
    }
  }

  edit(row, field, raw) {
    if (!canEditSlabField(row, field)) return;
    try {
      const value = parseSlabEditValue(field, raw);
      const before = this.ledger;
      const next = row.auxiliary
        ? updateSlabListAuxiliaryRow(
            before,
            field.startsWith('bar:')
              ? {
                  ...row.auxiliary,
                  barValues: {
                    ...(row.auxiliary.barValues || {}),
                    [field.slice(4)]: value,
                  },
                }
              : { ...row.auxiliary, [field]: value },
          )
        : setSlabListOverride(before, {
            modelSide: row.modelSide,
            sectionId: row.sectionId,
            stbRevision: row.stbRevision,
            field,
            value,
          });
      this.undoStack.push(before);
      this.ledger = next;
      this.dirty = true;
      this.refresh();
    } catch (error) {
      this.pendingFocusKey = null;
      this.pendingFocusNavigation = false;
      this.status.textContent = '編集エラー: ' + error.message;
    }
  }

  setAuxiliaryLayout(row, barLayout) {
    if (!row?.auxiliary) return;
    try {
      if (row.auxiliary.barLayout === barLayout) return;
      if (
        Object.values(row.auxiliary.barValues || {}).some(Boolean) &&
        !confirm('配筋配置体系の変更により、現在の補助行配筋を破棄しますか？')
      ) {
        this.render();
        return;
      }
      const before = this.ledger;
      this.ledger = updateSlabListAuxiliaryRow(before, {
        ...row.auxiliary,
        barLayout,
        barValues: {},
      });
      this.undoStack.push(before);
      this.dirty = true;
      this.refresh();
    } catch (error) {
      this.status.textContent = '配筋配置変更エラー: ' + error.message;
    }
  }

  addAuxiliary(base = null) {
    const revision = this.revisionBySide[this.side];
    if (!revision) {
      this.status.textContent = '補助行追加には、現行STBモデルと改訂ハッシュが必要です';
      return;
    }
    try {
      if (
        base &&
        (base.modelSide !== this.side ||
          base.stbRevision !== revision ||
          (!base.auxiliary && !canMapSlabRow(base)))
      )
        throw new Error('現在改訂の一意なSTB断面／補助行のみ複製できます');
      const symbol = base ? slabDisplayField(base, 'symbol').value : '';
      const thickness = base ? Number(slabDisplayField(base, 'thicknessMm').value) : 0;
      const id =
        globalThis.crypto?.randomUUID?.() ||
        'aux-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      const row = {
        id,
        modelSide: this.side,
        stbRevision: revision,
        symbol: base ? (symbol.slice(0, 120) + '-複製').slice(0, 128) : '',
        thicknessMm: Number.isFinite(thickness) && thickness > 0 ? thickness : null,
        notes: base ? slabDisplayField(base, 'notes').value : '',
        storyId:
          this.story || base?.auxiliary?.storyId || base?.section?.stb?.storyIds?.[0] || null,
        ...(base?.sectionId
          ? { sourceSectionId: String(base.sectionId) }
          : base?.auxiliary?.sourceSectionId
            ? { sourceSectionId: base.auxiliary.sourceSectionId }
            : {}),
        ...(base?.auxiliary
          ? {
              barLayout: base.auxiliary.barLayout || null,
              barValues: { ...(base.auxiliary.barValues || {}) },
            }
          : base?.section
            ? cloneStbSlabBars(base.section)
            : { barLayout: null, barValues: {} }),
      };
      const before = this.ledger;
      this.ledger = addSlabListAuxiliaryRow(before, row);
      this.undoStack.push(before);
      this.dirty = true;
      this.selectedId = 'aux:' + id;
      this.refresh();
    } catch (error) {
      this.status.textContent = '補助行追加エラー: ' + error.message;
    }
  }

  removeAuxiliary(row) {
    if (!row?.auxiliary || !confirm('補助行を削除しますか？ 元STB断面は削除されません。')) return;
    try {
      const before = this.ledger;
      this.ledger = deleteSlabListAuxiliaryRow(before, row.auxiliary);
      this.undoStack.push(before);
      this.selectedId = null;
      this.dirty = true;
      this.refresh();
    } catch (error) {
      this.status.textContent = '補助行削除エラー: ' + error.message;
    }
  }

  removeOverride(row, field) {
    if (!canEditSlabField(row, field)) return;
    this.undoStack.push(this.ledger);
    this.ledger = removeSlabListOverride(this.ledger, {
      modelSide: row.modelSide,
      sectionId: row.sectionId,
      stbRevision: row.stbRevision,
      field,
    });
    this.dirty = true;
    this.refresh();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.ledger = this.undoStack.pop();
    this.syncXmlSourcesFromLedger();
    this.dirty = JSON.stringify(this.ledger) !== JSON.stringify(this.savedLedger);
    this.refresh();
  }

  discard() {
    this.ledger = normalizeSlabListState(this.savedLedger);
    this.syncXmlSourcesFromLedger();
    this.undoStack = [];
    this.dirty = false;
    this.refresh();
  }

  /** Authoritative STB DOM + revision + saved edit state, never an HTML table scrape. */
  async outputSnapshot({ allRows = false, zone = this.zone } = {}) {
    const side = this.side;
    const doc = getState(side === 'A' ? 'models.documentA' : 'models.documentB');
    const ticket = this.refreshTicket;
    const rows = this.rows;
    const ledger = this.ledger;
    const savedLedger = this.savedLedger;
    const filter = [this.query, this.story, this.hideEmpty, this.zone];
    if (!doc || !this.revisionBySide[side])
      throw new Error('現行STBモデルを読み込んでから出力してください。');
    if (this.dirty || this.saving)
      throw new Error('変更をDrawingProjectへ保存してから出力してください。');
    const revision = this.revisionBySide[side];
    const assertCurrent = async () => {
      const actual = await domRevision(doc);
      if (
        !actual ||
        actual !== revision ||
        side !== this.side ||
        ticket !== this.refreshTicket ||
        doc !== getState(side === 'A' ? 'models.documentA' : 'models.documentB') ||
        rows !== this.rows ||
        ledger !== this.ledger ||
        savedLedger !== this.savedLedger ||
        filter.some(
          (value, index) => value !== [this.query, this.story, this.hideEmpty, this.zone][index],
        ) ||
        this.dirty ||
        this.saving
      )
        throw new Error('出力中にSTB改訂または編集状態が変化しました。再度更新してください。');
    };
    await assertCurrent();
    const filtered = allRows
      ? rows
      : visibleSlabListRows(rows, {
          search: this.query,
          storyId: this.story,
          hideEmpty: this.hideEmpty,
        });
    return {
      doc,
      snapshot: buildSlabOutputSnapshot(filtered, { side, revision, zone }),
      assertCurrent,
    };
  }

  async exportSlabOutput(format) {
    if (format === 'stored-pdf') {
      if (this.side !== 'A') throw new Error('保存済みシートはSTB-A専用です。');
      const { doc } = await this.outputSnapshot({ allRows: true });
      const { layout, context } = await loadSectionListDrawingProjectLayout({
        source: 'A',
        xmlDocument: doc,
        listType: 'slab',
      });
      const ids = layout.pages.flatMap((page) => page.regions.flatMap((region) => region.symbols));
      if (new Set(ids).size !== ids.length)
        throw new Error('保存済みシートのスラブIDが重複しています。');
      const legacyLabel = layout.pages[0]?.regions[0]?.label;
      const legacyZone =
        legacyLabel === 'zone:CENTER' ? 'CENTER' : legacyLabel === 'zone:END' ? 'END' : null;
      const viewSpec =
        layout.viewSpec ||
        (legacyZone ? { type: 'slab-list', zone: legacyZone, rowIds: ids } : null);
      if (!viewSpec) throw new Error('保存済みViewSpecの配筋表示位置がありません。');
      const { snapshot, assertCurrent } = await this.outputSnapshot({
        allRows: true,
        zone: viewSpec.zone,
      });
      const { pages } = produceSlabListView(this.rows, viewSpec, {
        side: snapshot.side,
        revision: snapshot.revision,
      });
      if (
        pages.length !== layout.pages.length ||
        pages.some(
          (page, i) =>
            JSON.stringify(page.ids) !== JSON.stringify(layout.pages[i].regions[0]?.symbols),
        )
      )
        throw new Error(
          'スラブリストのページ割付が保存時と異なります。シートを再配置してください。',
        );
      await downloadSlabPdf(pages, 'slab-list-stored-sheet.pdf', {
        validateBeforeSave: async () => {
          await assertCurrent();
          await context.services.assertDrawingSourceCurrent({ source: context.drawing.source });
          if (
            context.session.loadedDrawingProject !== context.project ||
            context.panel.drawing !== context.drawing
          )
            throw new Error('保存シートのPDF生成中にDrawingProjectが更新されました。');
        },
      });
      this.status.textContent = '保存シートのPDFを再生成しました: ' + pages.length + '枚';
      return;
    }
    const { doc, snapshot, assertCurrent } = await this.outputSnapshot();
    const pages = format === 'csv' ? null : buildSlabOutputPages(snapshot);
    if (format === 'csv') downloadSlabCsv(snapshot);
    else if (format === 'svg') downloadSlabSvgs(pages);
    else if (format === 'pdf')
      await downloadSlabPdf(pages, 'slab-list.pdf', { validateBeforeSave: assertCurrent });
    else if (format === 'dxf')
      await downloadSlabDxf(pages, 'slab-list.dxf', 'autocad-r12', {
        validateBeforeSave: assertCurrent,
      });
    else if (format === 'dxf-jwcad')
      await downloadSlabDxf(pages, 'slab-list-jwcad.dxf', 'jwcad-r12', {
        validateBeforeSave: assertCurrent,
      });
    else if (format === 'sheet') {
      if (snapshot.side !== 'A')
        throw new Error('共通DrawingProjectシートはSTB-Aのみ配置できます。');
      const rowIds = snapshot.rows.map((row) => row.id);
      if (
        new Set(rowIds).size !== rowIds.length ||
        rowIds.some((id) => id.length > 100 || !id.trim())
      )
        throw new Error('シートへ登録できない重複または長すぎるスラブ行IDがあります。');
      const layout = {
        paperKey: 'a3-landscape',
        scaleDenominator: 1,
        compactColumns: false,
        viewSpec: { type: 'slab-list', zone: snapshot.zone, rowIds },
        pages: pages.map((page, pageIndex) => ({
          regions: [
            {
              id: 'slab-region-' + pageIndex,
              symbols: [...page.ids],
              storyIds: ['SLAB-LIST'],
              x: 12,
              y: 28,
              widthMm: 396,
              heightMm: page.usedHeight - 28,
              label: 'RCスラブリスト',
              autoLabel: false,
            },
          ],
        })),
      };
      const context = await resolveSectionListDrawingProjectContext({
        source: snapshot.side,
        xmlDocument: doc,
      });
      await assertCurrent();
      await commitSectionListDrawingProjectLayout({
        context,
        listType: 'slab',
        layout,
      });
      this.status.textContent = 'スラブリストを共通DrawingProjectのA3シートへ登録しました。';
      return;
    } else throw new Error('未対応の出力形式です: ' + format);
    this.status.textContent =
      format.toUpperCase() + 'を出力しました: ' + (pages?.length || 1) + '枚';
  }

  exportStateJson() {
    const text = JSON.stringify(normalizeSlabListState(this.ledger), null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = element('a');
    anchor.href = url;
    anchor.download = 'slab-list-overrides.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Download object URL is no longer needed after the synthetic click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async importStateJson(file) {
    try {
      if (file.size > SLAB_JSON_BACKUP_MAX_BYTES)
        throw new TypeError('JSONは8MiB以下にしてください');
      if (this.dirty && !confirm('未保存の変更を破棄してJSONを読込みますか？')) return;
      const target = { ledger: this.ledger, side: this.side, ticket: ++this.jsonImportTicket };
      const parsed = normalizeSlabListState(JSON.parse(await file.text()));
      await verifySlabXmlSources(parsed.xmlSources, parseSlabDesignXml);
      // Never replace newer edits with an earlier asynchronous file read/verification.
      if (
        !isSlabImportCurrent(target, {
          ledger: this.ledger,
          side: this.side,
          ticket: this.jsonImportTicket,
        })
      )
        throw new Error(
          'JSON読込中に編集・モデル切替・別のJSON読込が行われたため置換を中止しました',
        );
      // This is an explicit replacement, not an STB/XML source modification.
      const before = this.ledger;
      this.ledger = parsed;
      try {
        this.syncXmlSourcesFromLedger();
      } catch (error) {
        this.ledger = before;
        this.syncXmlSourcesFromLedger();
        throw error;
      }
      this.undoStack.push(before);
      this.dirty = true;
      await this.refresh();
    } catch (error) {
      this.status.textContent = '変更JSON読込エラー: ' + error.message;
    }
  }

  async save() {
    if (typeof this.writeState !== 'function' || this.saving) return;
    const copy = normalizeSlabListState(this.ledger);
    const undoDepth = this.undoStack.length;
    this.saving = true;
    if (this.saveButton) this.saveButton.disabled = true;
    try {
      await this.writeState(copy, { expectedState: this.savedLedger, modelSide: this.side });
      this.savedLedger = normalizeSlabListState(copy);
      const result = completedSlabSaveState(
        this.ledger,
        this.savedLedger,
        this.undoStack,
        undoDepth,
      );
      this.undoStack = result.undoStack;
      this.dirty = result.dirty;
      // Do not re-render inputs while an edit made during the save is still focused.
      if (this.status)
        this.status.textContent = this.dirty ? '未保存の変更あり' : '未編集／保存済み';
    } catch (error) {
      if (this.status) this.status.textContent = '保存エラー: ' + error.message;
    } finally {
      this.saving = false;
      if (this.saveButton) this.saveButton.disabled = typeof this.writeState !== 'function';
    }
  }

  syncXmlSourcesFromLedger() {
    for (const side of ['A', 'B']) {
      const src = this.ledger.xmlSources.find((entry) => entry.modelSide === side);
      if (!src) {
        this.xmlBySide[side] = null;
        this.hashBySide[side] = null;
        continue;
      }
      if (this.hashBySide[side] === src.sha256 && this.xmlBySide[side]) continue;
      const bytes = Uint8Array.from(globalThis.atob(src.bytesBase64), (char) => char.charCodeAt(0));
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const facts = parseSlabDesignXml(xml);
      if (!facts.ok) throw new TypeError('保存XMLの形式が不正です: ' + side);
      this.xmlBySide[side] = facts;
      this.hashBySide[side] = src.sha256;
    }
  }

  async load() {
    if (typeof this.readState !== 'function') return;
    const initialLedger = this.ledger;
    const saved = normalizeSlabListState((await this.readState()) ?? createSlabListState());
    await verifySlabXmlSources(saved.xmlSources, parseSlabDesignXml);
    if (this.ledger !== initialLedger || this.dirty || this.saving)
      throw new Error('読込中に編集が行われたため、古い保存状態による上書きを中止しました');
    this.savedLedger = saved;
    this.ledger = normalizeSlabListState(this.savedLedger);
    this.syncXmlSourcesFromLedger();
    this.undoStack = [];
    this.dirty = false;
    await this.refresh();
  }
}

let instance = null;
export function getSlabSectionListPanel() {
  if (!instance)
    instance = new SlabSectionListPanel({
      readState: readCurrentSlabListDrawingProjectState,
      writeState: writeCurrentSlabListDrawingProjectState,
    });
  return instance;
}
export function initSlabSectionListPanel() {
  return getSlabSectionListPanel().init();
}

/** Allow host applications and unit tests to replace the default DrawingProject adapter. */
export function configureSlabListPersistence({ readState, writeState } = {}) {
  const panel = getSlabSectionListPanel();
  panel.readState = readState ?? null;
  panel.writeState = writeState ?? null;
  if (panel.saveButton) panel.saveButton.disabled = typeof writeState !== 'function';
  if (panel.initialized && typeof readState === 'function') return panel.load();
  return Promise.resolve();
}
