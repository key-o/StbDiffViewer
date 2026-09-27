import { escapeHtml } from '../../../utils/htmlUtils.js';

const QUANTITY_ROWS = [
  { key: 'lengthMm', label: '実部材長', divisor: 1_000, decimals: 3, unit: 'm' },
  { key: 'sectionAreaMm2', label: '断面積', divisor: 1_000_000, decimals: 4, unit: 'm²' },
  { key: 'surfaceAreaMm2', label: '面積', divisor: 1_000_000, decimals: 4, unit: 'm²' },
  {
    key: 'concreteAreaMm2',
    label: 'コンクリート断面積',
    divisor: 1_000_000,
    decimals: 4,
    unit: 'm²',
  },
  {
    key: 'structuralSteelAreaMm2',
    label: '鉄骨断面積',
    divisor: 1_000_000,
    decimals: 4,
    unit: 'm²',
  },
  { key: 'grossVolumeMm3', label: '総体積', divisor: 1_000_000_000, decimals: 4, unit: 'm³' },
  {
    key: 'grossEnvelopeVolumeMm3',
    label: '包絡体積',
    divisor: 1_000_000_000,
    decimals: 4,
    unit: 'm³',
  },
  {
    key: 'openingVolumeMm3',
    label: '開口控除体積',
    divisor: 1_000_000_000,
    decimals: 4,
    unit: 'm³',
  },
  { key: 'netVolumeMm3', label: '正味体積', divisor: 1_000_000_000, decimals: 4, unit: 'm³' },
  {
    key: 'concreteVolumeMm3',
    label: 'コンクリート体積',
    divisor: 1_000_000_000,
    decimals: 4,
    unit: 'm³',
  },
  {
    key: 'structuralSteelVolumeMm3',
    label: '鉄骨体積',
    divisor: 1_000_000_000,
    decimals: 4,
    unit: 'm³',
  },
  { key: 'structuralSteelLengthMm', label: '鉄骨有効長', divisor: 1_000, decimals: 3, unit: 'm' },
];

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumeric(value, row, { signed = false } = {}) {
  const number = finiteNumber(value);
  if (number === null) return '-';
  const converted = number / row.divisor;
  const sign = signed && converted > 0 ? '+' : '';
  return `${sign}${converted.toFixed(row.decimals)} ${row.unit}`;
}

function formatText(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function formatWarnings(result) {
  if (!Array.isArray(result?.warnings) || result.warnings.length === 0) return '-';
  return result.warnings.join(' / ');
}

function quantityTypeForNode(node) {
  const name = node?.localName || node?.tagName || null;
  if (!name) return null;
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

export function resolveQuantityResult(store, node) {
  if (!store || typeof store.get !== 'function' || !node) return null;
  const elementType = quantityTypeForNode(node);
  const elementId = node.getAttribute?.('id');
  if (!elementType || !elementId) return null;
  return store.get(elementType, elementId) || null;
}

function renderHeader({ showSingleColumn, displayModelSide, hasA, hasB }) {
  if (showSingleColumn) {
    const side = displayModelSide || (hasA ? 'A' : hasB ? 'B' : null);
    return `<thead><tr><th>算出項目</th><th>モデル ${escapeHtml(side || '-')}</th></tr></thead>`;
  }
  return '<thead><tr><th>算出項目</th><th>モデル A</th><th>モデル B</th><th>差 (B - A)</th></tr></thead>';
}

function renderSingleRow(label, value) {
  return `<tr><td><span class="attr-name">${escapeHtml(label)}</span></td><td>${escapeHtml(value)}</td></tr>`;
}

function renderComparisonRow(label, valueA, valueB, delta = '-') {
  const differs = valueA !== valueB;
  const className = differs ? ' class="differs"' : '';
  return `<tr><td><span class="attr-name">${escapeHtml(label)}</span></td><td${className}>${escapeHtml(valueA)}</td><td${className}>${escapeHtml(valueB)}</td><td>${escapeHtml(delta)}</td></tr>`;
}

function renderStatusRows(resultA, resultB, options) {
  const { showSingleColumn, displayModelSide, suppressAReason } = options;
  if (showSingleColumn) {
    const useA = displayModelSide === 'A' || (displayModelSide !== 'B' && resultA);
    if (useA && suppressAReason) {
      return renderSingleRow('状態', '再計算待ち') + renderSingleRow('注記', suppressAReason);
    }
    const result = useA ? resultA : resultB;
    if (!result) return '';
    let html = renderSingleRow('状態', formatText(result.status));
    if (result.basis?.method) html += renderSingleRow('算出方法', formatText(result.basis.method));
    if (result.warnings?.length) html += renderSingleRow('警告', formatWarnings(result));
    return html;
  }

  const statusA = suppressAReason ? '再計算待ち' : formatText(resultA?.status);
  const statusB = formatText(resultB?.status);
  let html = renderComparisonRow('状態', statusA, statusB);
  const methodA = suppressAReason ? '-' : formatText(resultA?.basis?.method);
  const methodB = formatText(resultB?.basis?.method);
  if (methodA !== '-' || methodB !== '-') html += renderComparisonRow('算出方法', methodA, methodB);
  const warningA = suppressAReason || formatWarnings(resultA);
  const warningB = formatWarnings(resultB);
  if (warningA !== '-' || warningB !== '-') html += renderComparisonRow('警告', warningA, warningB);
  return html;
}

export function renderQuantityInfoHtml({
  resultA = null,
  resultB = null,
  showSingleColumn = false,
  displayModelSide = null,
  suppressAReason = null,
} = {}) {
  const effectiveA = suppressAReason ? null : resultA;
  const hasA = !!effectiveA || !!suppressAReason;
  const hasB = !!resultB;
  if (!hasA && !hasB) return '';

  let html = '<section class="element-info-derived-quantity" style="margin-top:10px;">';
  html += '<div style="font-weight:var(--font-weight-bold);margin:0 0 4px;">算出情報</div>';
  html += '<table class="unified-comparison-table quantity-info-table">';
  html += renderHeader({ showSingleColumn, displayModelSide, hasA, hasB });
  html += '<tbody>';
  html += renderStatusRows(effectiveA, resultB, {
    showSingleColumn,
    displayModelSide,
    suppressAReason,
  });

  for (const row of QUANTITY_ROWS) {
    if (showSingleColumn) {
      const useA = displayModelSide === 'A' || (displayModelSide !== 'B' && effectiveA);
      const result = useA ? effectiveA : resultB;
      const value = result?.values?.[row.key];
      if (finiteNumber(value) === null) continue;
      html += renderSingleRow(row.label, formatNumeric(value, row));
      continue;
    }

    const valueA = effectiveA?.values?.[row.key];
    const valueB = resultB?.values?.[row.key];
    const numberA = finiteNumber(valueA);
    const numberB = finiteNumber(valueB);
    if (numberA === null && numberB === null) continue;
    const delta =
      numberA !== null && numberB !== null
        ? formatNumeric(numberB - numberA, row, { signed: true })
        : '-';
    html += renderComparisonRow(
      row.label,
      formatNumeric(valueA, row),
      formatNumeric(valueB, row),
      delta,
    );
  }

  html += '</tbody></table></section>';
  return html;
}

export function renderQuantityInfoFromStores({
  storeA = null,
  storeB = null,
  nodeA = null,
  nodeB = null,
  showSingleColumn = false,
  displayModelSide = null,
  suppressAReason = null,
} = {}) {
  return renderQuantityInfoHtml({
    resultA: resolveQuantityResult(storeA, nodeA),
    resultB: resolveQuantityResult(storeB, nodeB),
    showSingleColumn,
    displayModelSide,
    suppressAReason,
  });
}
