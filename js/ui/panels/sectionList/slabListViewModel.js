/**
 * #529 Slab section list presentation. Lossless source stays in P0/P1/P2.
 * No SHORT/LONG -> MAIN/TRANSVERSE or END/CENTER inference.
 */
import { projectSlabSectionToList } from '../../../data/extractors/slabList/slabSectionProjection.js';
import {
  AUXILIARY_BAR_LAYOUTS,
  auxiliaryBarCell,
} from '../../../data/extractors/slabList/slabAuxiliaryBars.js';

export const SLAB_ZONE_KEYS = Object.freeze(['END', 'CENTER']);
export const SLAB_DIRECTIONS = Object.freeze(['SHORT', 'LONG']);
export const SLAB_FACES = Object.freeze(['TOP', 'BOTTOM']);

export function buildSlabListRows(
  resolved,
  { auxiliaryRows = [], modelSide = null, stbRevision = null } = {},
) {
  const sourceRows = (resolved?.rows || []).map((row) => {
    const projection = row.section ? projectSlabSectionToList(row.section) : null;
    return { ...row, projection, sourceDiagnostics: row.section?.diagnostics || [] };
  });
  const extra = auxiliaryRows
    .filter((item) => item.modelSide === modelSide && item.stbRevision === stbRevision)
    .map((item) => ({
      id: 'aux:' + item.id,
      modelSide: item.modelSide,
      stbRevision: item.stbRevision,
      sectionId: null,
      symbol: item.symbol,
      auxiliary: item,
      section: null,
      projection: null,
      xmlRecord: null,
      mapping: { state: 'AUXILIARY', confirmed: true },
      resolvedFields: Object.fromEntries(
        ['symbol', 'thicknessMm', 'notes'].map((key) => [
          key,
          {
            value: item[key] ?? null,
            source: 'AUXILIARY',
            status: item[key] == null ? 'MISSING' : 'VALID',
          },
        ]),
      ),
      diagnostics: [],
      sourceDiagnostics: [],
    }));
  const all = [...sourceRows, ...extra];
  const names = all.map((row) =>
    String(row.resolvedFields?.symbol?.value ?? row.symbol ?? '')
      .trim()
      .normalize('NFC'),
  );
  const symbolCounts = new Map();
  for (const symbol of names)
    if (symbol) symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1);
  return all.map((row, index) => {
    if (!row.auxiliary || !names[index] || symbolCounts.get(names[index]) < 2) return row;
    return {
      ...row,
      mapping: { ...row.mapping, state: 'NEEDS_REVIEW' },
      diagnostics: [...row.diagnostics, 'AUXILIARY_SYMBOL_DUPLICATE'],
    };
  });
}

export function visibleSlabListRows(rows, { search = '', storyId = '', hideEmpty = false } = {}) {
  const needle = String(search).trim().normalize('NFC').toLocaleLowerCase();
  return rows.filter((row) => {
    const symbol = String(row.resolvedFields?.symbol?.value ?? row.symbol ?? '');
    if (
      needle &&
      ![symbol, row.sectionId, row.section?.barPattern].some((value) =>
        String(value ?? '')
          .normalize('NFC')
          .toLocaleLowerCase()
          .includes(needle),
      )
    )
      return false;
    if (
      storyId &&
      !(row.auxiliary
        ? row.auxiliary.storyId === storyId
        : (row.section?.stb?.storyIds || []).includes(storyId))
    )
      return false;
    if (
      hideEmpty &&
      !row.auxiliary &&
      !row.section &&
      (!row.xmlRecord?.name?.trim() ||
        (row.xmlRecord.name.trim() === '無題' && row.xmlRecord.fields?.t?.status !== 'VALID'))
    )
      return false;
    return true;
  });
}

export function slabCell(row, direction, face, zone) {
  if (row?.auxiliary) return auxiliaryBarCell(row, direction, face, zone);
  const key = [direction, face, zone].join('_');
  return slabProjectionCell(row, row?.projection?.cells?.[key]);
}

/** Project detail overrides back to the summary without discarding source positions. */
export function slabProjectionCell(row, cell) {
  if (!cell) return { value: '', state: 'MISSING' };
  const sourcePositions = cell.sourcePositions || [];
  const bars = sourcePositions.map((pos) =>
    (row?.section?.barPositions || []).filter((bar) => bar.pos === pos),
  );
  const hasOverride = sourcePositions.some(
    (pos) => row?.resolvedFields?.['bar:' + pos]?.source === 'OVERRIDE',
  );
  if (!hasOverride || cell.status === 'NOT_APPLICABLE')
    return cell.status === 'VALID'
      ? { value: cell.display, state: 'VALID' }
      : { value: '', state: cell.status };
  if (
    !sourcePositions.length ||
    bars.some((entries) => entries.length !== 1 || entries[0].problems?.length)
  )
    // Preserve the source diagnostic: a missing position is not an invalid one.
    return {
      value: '',
      state: ['MISSING', 'AMBIGUOUS'].includes(cell.status) ? cell.status : 'INVALID',
    };
  // A textual reinforcement override does not change source steel strength.
  // Never collapse strips with different materials into one apparently valid cell.
  if (new Set(bars.map(([bar]) => bar.strength ?? '')).size !== 1)
    return { value: '', state: 'AMBIGUOUS' };
  const adopted = bars.map(([bar]) => barDisplay(row, bar).value);
  if (adopted.some((value) => !value.trim())) return { value: '', state: 'MISSING' };
  if (new Set(adopted).size !== 1) return { value: '', state: 'AMBIGUOUS' };
  return { value: adopted[0], state: 'VALID' };
}

export function slabDisplayField(row, field) {
  const value = row?.resolvedFields?.[field];
  return {
    value: value?.value == null ? '' : String(value.value),
    source: value?.source || '',
    status: value?.status || 'MISSING',
    originalStb: value?.stb?.value,
    originalXml: value?.xml?.value,
    conflict: value?.conflict === true,
  };
}

export function canMapSlabRow(row) {
  return Boolean(
    row?.sectionId &&
    row.sectionId === row?.section?.stb?.sectionId &&
    row.stbRevision &&
    !row.diagnostics?.includes('SECTION_ID_MISSING_OR_DUPLICATE') &&
    !(row.sourceDiagnostics || []).some((d) =>
      ['SECTION_ID_MISSING', 'SECTION_ID_DUPLICATE'].includes(d.code),
    ),
  );
}

export function canEditSlabField(row, field) {
  if (row?.auxiliary) {
    if (['symbol', 'thicknessMm', 'notes'].includes(field)) return true;
    return (
      field.startsWith('bar:') &&
      (AUXILIARY_BAR_LAYOUTS[row.auxiliary.barLayout] || []).includes(field.slice(4))
    );
  }
  if (
    !row?.sectionId ||
    row.sectionId !== row?.section?.stb?.sectionId ||
    !row.stbRevision ||
    row.diagnostics?.includes('SECTION_ID_MISSING_OR_DUPLICATE')
  )
    return false;
  if (row.mapping?.state === 'STALE' || row.mapping?.state === 'NEEDS_REVIEW') return false;
  if (
    (row.sourceDiagnostics || []).some((d) =>
      ['SECTION_ID_MISSING', 'SECTION_ID_DUPLICATE'].includes(d.code),
    )
  )
    return false;
  if (field === 'thicknessMm' && row.section.shape?.type !== 'STRAIGHT') return false;
  if (field.startsWith('bar:')) {
    const pos = field.slice(4);
    const bars = row.section.barPositions.filter((bar) => bar.pos === pos);
    return bars.length === 1 && bars[0].problems.length === 0;
  }
  return ['symbol', 'thicknessMm', 'notes'].includes(field);
}

export function parseSlabEditValue(field, raw) {
  if (field === 'thicknessMm') {
    const value = String(raw).trim();
    if (!/^(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)$/.test(value) || Number(value) <= 0)
      throw new TypeError('スラブ厚は正の数値（mm）で入力してください');
    return Number(value);
  }
  return String(raw);
}

export function barDisplay(row, bar) {
  const field = 'bar:' + bar.pos;
  const override = row.resolvedFields?.[field];
  const stb = [bar.rawD || '', bar.rawPitch ? '@' + bar.rawPitch : ''].join('');
  return {
    field,
    raw: stb,
    // Explicit null is a cleared value, not the literal reinforcement text "null".
    value:
      override?.source === 'OVERRIDE'
        ? override.value == null
          ? ''
          : String(override.value)
        : stb,
    source: override?.source === 'OVERRIDE' ? 'OVERRIDE' : 'STB',
  };
}
