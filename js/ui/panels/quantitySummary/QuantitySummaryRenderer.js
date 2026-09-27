import { STORY_AXIS_MATCH_CRITERION } from '../../../config/comparisonKeyConfig.js';
import { getElementTypeFilterLabel } from '../../../config/elementLabels.js';
import { mm2ToM2, mm3ToM3 } from '../../../quantities/core/QuantityUnits.js';
import {
  getDimensionLabel,
  getMeasureDefinition,
  getQuantitySummaryDimensions,
  paginateQuantitySummaryRows,
} from './QuantitySummaryState.js';

const STATUS_LABELS = Object.freeze({
  CALCULATED: '確定',
  PARTIAL: '部分',
  INSUFFICIENT_DATA: '不足',
  UNSUPPORTED: '未対応',
  NOT_APPLICABLE: '対象外',
  INVALID_GEOMETRY: '形状不正',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeDecimalDigits(value) {
  const digits = Number(value);
  return Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 3;
}

function roundDisplayValue(value, decimalDigits) {
  const digits = normalizeDecimalDigits(decimalDigits);
  const factor = 10 ** digits;
  return Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;
}

function convertMeasureValue(measure, value) {
  if (value === null || value === undefined) return null;
  if (measure === 'count') return Number(value);
  if (measure === 'lengthMm') return Number(value) / 1_000;
  if (measure === 'surfaceAreaMm2') return mm2ToM2(value);
  if (measure.endsWith('VolumeMm3')) return mm3ToM3(value);
  return Number(value);
}

export function formatQuantityMeasure(measure, value, decimalDigits = 3) {
  const converted = convertMeasureValue(measure, value);
  if (converted === null || !Number.isFinite(converted)) return '—';
  if (measure === 'count') return String(Math.trunc(converted));
  const digits = normalizeDecimalDigits(decimalDigits);
  return converted.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatQuantityDelta(measure, value, decimalDigits = 3) {
  const converted = convertMeasureValue(measure, value);
  if (converted === null || !Number.isFinite(converted)) return '—';
  if (measure === 'count') {
    const integer = Math.trunc(converted);
    const text = String(integer);
    return integer > 0 ? `+${text}` : text;
  }

  const digits = normalizeDecimalDigits(decimalDigits);
  const rounded = roundDisplayValue(converted, digits);
  const text = rounded.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return rounded > 0 ? `+${text}` : text;
}

export function formatQuantityDimensionValue(dimension, value) {
  const normalized = value ?? '未分類';
  if (dimension === 'memberCategory') {
    return getElementTypeFilterLabel(normalized) || normalized;
  }
  return normalized;
}

function formatStoryHeight(heightMm) {
  const height = Number(heightMm);
  if (!Number.isFinite(height)) return null;
  return `${(height / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 3 })} m`;
}

function formatSummaryDimensionValue(dimension, row, state) {
  const value = formatQuantityDimensionValue(dimension, row?.[dimension]);
  if (
    dimension === 'storyName' &&
    state?.modelSide === 'AB' &&
    state?.storyMatchCriterion === STORY_AXIS_MATCH_CRITERION.GEOMETRY
  ) {
    const height = formatStoryHeight(row?.storyHeightMm);
    return height ? `${value} (${height})` : value;
  }
  return value;
}

export function renderStatusCounts(statusCounts = {}) {
  const knownEntries = Object.keys(STATUS_LABELS)
    .filter((status) => Number(statusCounts?.[status]) > 0)
    .map((status) => [status, statusCounts[status]]);
  const unknownEntries = Object.entries(statusCounts).filter(
    ([status, count]) => !(status in STATUS_LABELS) && Number(count) > 0,
  );
  const entries = [...knownEntries, ...unknownEntries];
  if (entries.length === 0) return '—';
  return entries
    .map(([status, count]) => `${STATUS_LABELS[status] || status} ${Number(count)}`)
    .join(' / ');
}

export function renderQuantitySummaryControls(container, state) {
  if (!container) return;
  const dimensionOptions = [
    ['storyName', '階'],
    ['memberCategory', '部材種別'],
    ['kindStructure', '構造種別'],
    ['sectionName', '断面'],
  ];
  const measureOptions = [
    ['count', '件数'],
    ['lengthMm', '長さ'],
    ['surfaceAreaMm2', '面積'],
    ['grossVolumeMm3', '総体積'],
    ['netVolumeMm3', '正味体積'],
    ['concreteVolumeMm3', 'コンクリート体積'],
    ['structuralSteelVolumeMm3', '鉄骨体積'],
  ];
  const storyMatchOptions = [
    [STORY_AXIS_MATCH_CRITERION.NAME, '名前（符号）'],
    [STORY_AXIS_MATCH_CRITERION.GEOMETRY, '高さ（標高・10mm単位）'],
  ];
  const decimalDigitOptions = Array.from({ length: 7 }, (_, digits) => [
    String(digits),
    `${digits}桁`,
  ]);
  const statuses = [
    ['CALCULATED', '確定'],
    ['PARTIAL', '部分確定'],
    ['INSUFFICIENT_DATA', 'データ不足'],
    ['UNSUPPORTED', '未対応'],
    ['NOT_APPLICABLE', '対象外'],
    ['INVALID_GEOMETRY', '形状不正'],
  ];

  const optionHtml = (items, selected) =>
    items
      .map(
        ([key, label]) =>
          `<option value="${key}"${key === selected ? ' selected' : ''}>${label}</option>`,
      )
      .join('');

  container.innerHTML = `
    <div class="quantity-summary-control-row">
      <label>モデル
        <select data-quantity-control="modelSide">
          <option value="A"${state.modelSide === 'A' ? ' selected' : ''}>A</option>
          <option value="B"${state.modelSide === 'B' ? ' selected' : ''}>B</option>
          <option value="AB"${state.modelSide === 'AB' ? ' selected' : ''}>A/B比較</option>
        </select>
      </label>
      <label>集計軸1
        <select data-quantity-control="dimension1">${optionHtml(dimensionOptions, state.dimension1)}</select>
      </label>
      <label>集計軸2
        <select data-quantity-control="dimension2">
          <option value="none"${state.dimension2 === 'none' ? ' selected' : ''}>なし</option>
          ${optionHtml(dimensionOptions, state.dimension2)}
        </select>
      </label>
      <label>数量
        <select data-quantity-control="measure">${optionHtml(measureOptions, state.measure)}</select>
      </label>
      <label title="表示とCSV出力の丸めに適用します。集計計算自体は丸めません">小数桁
        <select data-quantity-control="decimalDigits">${optionHtml(decimalDigitOptions, String(state.decimalDigits))}</select>
      </label>
      <label title="全体比較の「通り芯・階の判定基準」と同じ設定を使用します">階照合（共通）
        <select data-quantity-control="storyMatchCriterion"${
          state.modelSide !== 'AB' || ![state.dimension1, state.dimension2].includes('storyName')
            ? ' disabled'
            : ''
        }>
          ${optionHtml(storyMatchOptions, state.storyMatchCriterion)}
        </select>
      </label>
    </div>
    <fieldset class="quantity-summary-statuses">
      <legend>Status</legend>
      ${statuses
        .map(
          ([status, label]) => `
        <label><input type="checkbox" data-quantity-status="${status}"${state.statuses.includes(status) ? ' checked' : ''}> ${label}</label>
      `,
        )
        .join('')}
    </fieldset>
    <div class="quantity-summary-export-actions">
      <button type="button" data-quantity-export="summary">集計CSV</button>
      <button type="button" data-quantity-export="facts">部材CSV</button>
    </div>
  `;
}

function renderSingleMeasureCell(row, measure, state) {
  const definition = getMeasureDefinition(measure);
  const unit = definition?.unit ? ` ${escapeHtml(definition.unit)}` : '';

  if (measure === 'count') {
    const totalText = formatQuantityMeasure(
      measure,
      row?.count ?? row?.measures?.count ?? null,
      state.decimalDigits,
    );
    return totalText === '—' ? '—' : `${totalText}${unit}`;
  }

  const confirmed = row?.confirmedMeasures?.[measure] ?? null;
  const partial = row?.partialMeasures?.[measure] ?? null;
  const confirmedText = formatQuantityMeasure(measure, confirmed, state.decimalDigits);
  const partialText = formatQuantityMeasure(measure, partial, state.decimalDigits);
  const main = confirmedText === '—' ? '—' : `${confirmedText}${unit}`;
  if (partialText === '—') return main;
  return `${main}<span class="quantity-summary-partial">部分: ${partialText}${unit}</span>`;
}

function comparisonValueProps(side) {
  if (side === 'A') return ['measureA', 'partialMeasureA'];
  if (side === 'B') return ['measureB', 'partialMeasureB'];
  return ['delta', 'partialDelta'];
}

function renderComparisonMeasureCell(row, measure, side, state) {
  const definition = getMeasureDefinition(measure);
  const unit = definition?.unit ? ` ${escapeHtml(definition.unit)}` : '';
  const [mainKey, partialKey] = comparisonValueProps(side);
  const isDelta = side === 'delta';
  const formatter = isDelta ? formatQuantityDelta : formatQuantityMeasure;
  const mainText = formatter(measure, row?.[mainKey] ?? null, state.decimalDigits);
  const hasPartial =
    side === 'A'
      ? Number(row?.statusCountsA?.PARTIAL) > 0
      : side === 'B'
        ? Number(row?.statusCountsB?.PARTIAL) > 0
        : Number(row?.statusCountsA?.PARTIAL) > 0 || Number(row?.statusCountsB?.PARTIAL) > 0;
  const partialText =
    measure === 'count' || !hasPartial
      ? '—'
      : formatter(measure, row?.[partialKey] ?? null, state.decimalDigits);
  const main =
    mainText === '—' ? '—' : `<span class="quantity-summary-main">${mainText}${unit}</span>`;
  if (partialText === '—') return main;
  return `${main}<span class="quantity-summary-partial">${isDelta ? '部分Δ' : '部分'}: ${partialText}${unit}</span>`;
}

function renderPagination(pagination, prefix = '') {
  if (pagination.total <= pagination.pageSize) return `${pagination.total} グループ`;
  const attr = prefix ? `data-quantity-${prefix}-page` : 'data-quantity-page';
  return `
    <div class="quantity-summary-pagination">
      <button type="button" ${attr}="${pagination.page - 1}"${pagination.page <= 1 ? ' disabled' : ''}>前へ</button>
      <span>${pagination.startIndex}-${pagination.endIndex} / ${pagination.total} グループ</span>
      <button type="button" ${attr}="${pagination.page + 1}"${pagination.page >= pagination.pageCount ? ' disabled' : ''}>次へ</button>
    </div>
  `;
}

export function renderQuantitySummaryTable(
  container,
  rows,
  state,
  { message = null, selectedGroupKey = null } = {},
) {
  if (!container) return;
  if (message) {
    container.innerHTML = `<div class="quantity-summary-message">${escapeHtml(message)}</div>`;
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    container.innerHTML =
      '<div class="quantity-summary-message">該当する数量データがありません。</div>';
    return;
  }

  const dimensions = getQuantitySummaryDimensions(state);
  const measureDef = getMeasureDefinition(state.measure);
  const pagination = paginateQuantitySummaryRows(rows, state);
  const visibleRows = pagination.rows;
  const sortMarker = (key) =>
    state.sortKey === key ? (state.sortDirection === 'asc' ? ' ▲' : ' ▼') : '';

  const dimensionHeaders = dimensions.map(
    (key) =>
      `<th><button type="button" data-quantity-sort="${key}">${escapeHtml(getDimensionLabel(key))}${sortMarker(key)}</button></th>`,
  );

  const header =
    state.modelSide === 'AB'
      ? [
          ...dimensionHeaders,
          `<th><button type="button" data-quantity-sort="measureA">A ${escapeHtml(measureDef?.label || state.measure)}${sortMarker('measureA')}</button></th>`,
          `<th><button type="button" data-quantity-sort="measureB">B ${escapeHtml(measureDef?.label || state.measure)}${sortMarker('measureB')}</button></th>`,
          `<th><button type="button" data-quantity-sort="delta">Δ (B-A)${sortMarker('delta')}</button></th>`,
          '<th>Status A</th>',
          '<th>Status B</th>',
        ].join('')
      : [
          ...dimensionHeaders,
          `<th><button type="button" data-quantity-sort="measure">${escapeHtml(measureDef?.label || state.measure)}${sortMarker('measure')}</button></th>`,
          '<th>Status</th>',
        ].join('');

  const body = visibleRows
    .map((row) => {
      const isSelected = selectedGroupKey && row?.groupKey === selectedGroupKey;
      const rowOpen = `<tr class="quantity-summary-group-row${isSelected ? ' selected' : ''}" data-quantity-group-key="${escapeHtml(row?.groupKey || '')}" tabindex="0"${isSelected ? ' aria-selected="true"' : ''}>`;
      const dimensionCells = dimensions
        .map((key) => `<td>${escapeHtml(formatSummaryDimensionValue(key, row, state))}</td>`)
        .join('');

      if (state.modelSide === 'AB') {
        return `
          ${rowOpen}
            ${dimensionCells}
            <td class="quantity-summary-value">${renderComparisonMeasureCell(row, state.measure, 'A', state)}</td>
            <td class="quantity-summary-value">${renderComparisonMeasureCell(row, state.measure, 'B', state)}</td>
            <td class="quantity-summary-value quantity-summary-delta">${renderComparisonMeasureCell(row, state.measure, 'delta', state)}</td>
            <td>${escapeHtml(renderStatusCounts(row?.statusCountsA))}</td>
            <td>${escapeHtml(renderStatusCounts(row?.statusCountsB))}</td>
          </tr>
        `;
      }

      return `
        ${rowOpen}
          ${dimensionCells}
          <td class="quantity-summary-value">${renderSingleMeasureCell(row, state.measure, state)}</td>
          <td>${escapeHtml(renderStatusCounts(row?.statusCounts))}</td>
        </tr>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="quantity-summary-table-scroll">
      <table class="quantity-summary-table">
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="quantity-summary-footer">
      ${renderPagination(pagination)}
    </div>
  `;
}

function paginateFacts(facts, requestedPage, pageSize = 100) {
  const source = Array.isArray(facts) ? facts : [];
  const total = source.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), pageCount);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return {
    facts: source.slice(start, end),
    total,
    page,
    pageCount,
    pageSize,
    startIndex: total === 0 ? 0 : start + 1,
    endIndex: end,
  };
}

function factMeasureValue(fact, measure) {
  if (measure === 'count') return 1;
  return fact?.quantity?.[measure] ?? null;
}

export function renderQuantityDrilldown(
  container,
  facts,
  state,
  { group = null, page = 1, pageSize = 100 } = {},
) {
  if (!container) return;
  if (!group) {
    container.innerHTML = '';
    return;
  }

  const dimensions = getQuantitySummaryDimensions(state);
  const groupLabel = dimensions
    .map(
      (dimension) =>
        `${getDimensionLabel(dimension)}: ${formatQuantityDimensionValue(dimension, group?.[dimension])}`,
    )
    .join(' / ');
  const measureDef = getMeasureDefinition(state.measure);
  const pagination = paginateFacts(facts, page, pageSize);

  const body = pagination.facts
    .map((fact) => {
      const viewerType =
        getElementTypeFilterLabel(fact?.memberCategory) || fact?.memberCategory || '—';
      const valueText = formatQuantityMeasure(
        state.measure,
        factMeasureValue(fact, state.measure),
        state.decimalDigits,
      );
      const unit = valueText === '—' || !measureDef?.unit ? '' : ` ${escapeHtml(measureDef.unit)}`;
      return `
        <tr class="quantity-summary-fact-row"
            data-quantity-fact-side="${escapeHtml(fact?.modelSide || '')}"
            data-quantity-fact-type="${escapeHtml(fact?.elementType || '')}"
            data-quantity-fact-id="${escapeHtml(fact?.elementId || '')}"
            data-quantity-member-category="${escapeHtml(fact?.memberCategory || '')}"
            tabindex="0">
          <td>${escapeHtml(fact?.modelSide || '—')}</td>
          <td>${escapeHtml(viewerType)}</td>
          <td>${escapeHtml(fact?.elementId || '—')}</td>
          <td>${escapeHtml(fact?.storyName || '未分類')}</td>
          <td>${escapeHtml(fact?.kindStructure || '未分類')}</td>
          <td>${escapeHtml(fact?.sectionName || '未分類')}</td>
          <td>${escapeHtml(STATUS_LABELS[fact?.status] || fact?.status || '—')}</td>
          <td class="quantity-summary-value">${valueText}${unit}</td>
        </tr>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="quantity-summary-drilldown-header">
      <strong>内訳</strong>
      <span>${escapeHtml(groupLabel)}</span>
      <button type="button" data-quantity-drilldown-close aria-label="内訳を閉じる">✕</button>
    </div>
    <div class="quantity-summary-drilldown-scroll">
      <table class="quantity-summary-table quantity-summary-drilldown-table">
        <thead>
          <tr>
            <th>Model</th><th>部材種別</th><th>ID</th><th>階</th><th>構造</th><th>断面</th><th>Status</th>
            <th>${escapeHtml(measureDef?.label || state.measure)}</th>
          </tr>
        </thead>
        <tbody>${body || '<tr><td colspan="8">該当部材がありません。</td></tr>'}</tbody>
      </table>
    </div>
    <div class="quantity-summary-footer">
      ${
        pagination.total > pagination.pageSize
          ? `<div class="quantity-summary-pagination">
              <button type="button" data-quantity-drilldown-page="${pagination.page - 1}"${pagination.page <= 1 ? ' disabled' : ''}>前へ</button>
              <span>${pagination.startIndex}-${pagination.endIndex} / ${pagination.total} 部材</span>
              <button type="button" data-quantity-drilldown-page="${pagination.page + 1}"${pagination.page >= pagination.pageCount ? ' disabled' : ''}>次へ</button>
            </div>`
          : `${pagination.total} 部材`
      }
    </div>
  `;
}
