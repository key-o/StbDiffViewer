/**
 * #528 Pure fail-closed STB slab / supplementary XML resolver.
 * Source documents are strictly read-only. No recalculation is performed.
 */
import { validateAuxiliaryBars } from './slabAuxiliaryBars.js';

export const SLAB_LIST_STATE_VERSION = 1;
const SIDES = new Set(['A', 'B']);
const MODES = new Set(['LINK', 'UNLINK']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validString = (s) => typeof s === 'string' && s.length > 0;
const identity = (...items) => JSON.stringify(items);
const allowedKeys = (value, allowed) =>
  isObject(value) && Object.keys(value).every((key) => allowed.has(key));
const XML_MAX_BYTES = 2 * 1024 * 1024;
const XML_MAX_BASE64_LENGTH = Math.ceil(XML_MAX_BYTES / 3) * 4;
const base64DecodedSize = (encoded) =>
  (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Reject alternate padding-bit spellings for the same XML bytes at the state boundary.
const canonicalBase64 = (encoded) => {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (!padding) return true;
  const last = base64Alphabet.indexOf(encoded[encoded.length - padding - 1]);
  return last >= 0 && last % (padding === 2 ? 16 : 4) === 0;
};

export function normalizeSlabSymbol(value) {
  return typeof value === 'string' ? value.trim().normalize('NFC') : '';
}
export function slabSectionIdentity(section) {
  if (!SIDES.has(section?.modelSide) || !validString(section?.stb?.sectionId))
    throw new TypeError('A/B side and a unique STB section ID are required');
  return identity(section.modelSide, section.stb.sectionId);
}
export function xmlRecordIdentity(record, xmlSourceHash) {
  if (!validString(xmlSourceHash) || !Number.isSafeInteger(record?.index) || record.index < 0)
    throw new TypeError('XML source hash and Record index are required');
  return identity(xmlSourceHash, record.index, record.name ?? null);
}
export function createSlabListState() {
  return { schemaVersion: SLAB_LIST_STATE_VERSION, mappings: [], overrides: [], xmlSources: [] };
}
/** Versioned, JSON-serializable state; keeps 0, empty string, and null distinct. */
export function normalizeSlabListState(state = createSlabListState()) {
  if (!isObject(state) || state.schemaVersion !== SLAB_LIST_STATE_VERSION)
    throw new TypeError('Unsupported slab-list state schema');
  for (const key of Object.keys(state))
    if (!['schemaVersion', 'mappings', 'overrides', 'xmlSources', 'auxiliaryRows'].includes(key))
      throw new TypeError('Unknown slab-list state property: ' + key);
  const mappings = state.mappings ?? [];
  const overrides = state.overrides ?? [];
  const xmlSources = state.xmlSources ?? [];
  const auxiliaryRows = state.auxiliaryRows ?? [];
  if (
    ![mappings, overrides, xmlSources, auxiliaryRows].every(Array.isArray) ||
    mappings.length > 10000 ||
    overrides.length > 20000 ||
    xmlSources.length > 32 ||
    auxiliaryRows.length > 2000
  )
    throw new TypeError('Invalid or excessive slab-list arrays');
  const keys = new Set();
  for (const m of mappings) {
    if (
      !allowedKeys(
        m,
        new Set([
          'modelSide',
          'sectionId',
          'stbRevision',
          'xmlSourceHash',
          'recordIndex',
          'recordName',
          'decision',
          'confirmedAt',
        ]),
      ) ||
      (m.confirmedAt !== undefined && !validString(m.confirmedAt)) ||
      !SIDES.has(m?.modelSide) ||
      !validString(m.sectionId) ||
      !validString(m.stbRevision) ||
      !/^[a-f0-9]{64}$/.test(m.xmlSourceHash) ||
      !MODES.has(m.decision) ||
      (m.decision === 'LINK' &&
        (!Number.isSafeInteger(m.recordIndex) ||
          m.recordIndex < 0 ||
          typeof m.recordName !== 'string')) ||
      (m.decision === 'UNLINK' &&
        m.recordIndex != null &&
        (!Number.isSafeInteger(m.recordIndex) || m.recordIndex < 0))
    )
      throw new TypeError('Invalid mapping');
    const key = identity(m.modelSide, m.sectionId, m.stbRevision, m.xmlSourceHash);
    if (keys.has(key)) throw new TypeError('Duplicate mapping for one section/source revision');
    keys.add(key);
  }
  keys.clear();
  for (const o of overrides) {
    if (
      !allowedKeys(
        o,
        new Set(['modelSide', 'sectionId', 'stbRevision', 'field', 'value', 'updatedAt']),
      ) ||
      (o.updatedAt !== undefined && !validString(o.updatedAt)) ||
      !SIDES.has(o?.modelSide) ||
      !validString(o.sectionId) ||
      !validString(o.stbRevision) ||
      !validString(o.field) ||
      o.field.length > 128 ||
      ['__proto__', 'prototype', 'constructor'].includes(o.field) ||
      !own(o, 'value') ||
      (typeof o.value === 'number' && !Number.isFinite(o.value)) ||
      (o.value !== null && !['number', 'string', 'boolean'].includes(typeof o.value))
    )
      throw new TypeError('Invalid override');
    const key = identity(o.modelSide, o.sectionId, o.stbRevision, o.field);
    if (keys.has(key)) throw new TypeError('Duplicate override');
    keys.add(key);
  }
  keys.clear();
  for (const source of xmlSources) {
    if (
      !allowedKeys(source, new Set(['modelSide', 'sha256', 'bytesBase64'])) ||
      typeof source.bytesBase64 !== 'string' ||
      source.bytesBase64.length > XML_MAX_BASE64_LENGTH ||
      base64DecodedSize(source.bytesBase64) > XML_MAX_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        source.bytesBase64,
      ) ||
      !canonicalBase64(source.bytesBase64) ||
      !SIDES.has(source?.modelSide) ||
      !validString(source.sha256) ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    )
      throw new TypeError('Invalid XML source descriptor');
    const key = identity(source.modelSide, source.sha256);
    if (keys.has(key)) throw new TypeError('Duplicate XML source');
    keys.add(key);
  }
  keys.clear();
  for (const row of auxiliaryRows) {
    if (
      !allowedKeys(
        row,
        new Set([
          'id',
          'modelSide',
          'stbRevision',
          'symbol',
          'thicknessMm',
          'notes',
          'storyId',
          'sourceSectionId',
          'barLayout',
          'barValues',
        ]),
      ) ||
      !validString(row.id) ||
      row.id.length > 128 ||
      !SIDES.has(row.modelSide) ||
      !validString(row.stbRevision) ||
      row.stbRevision.length > 128 ||
      typeof row.symbol !== 'string' ||
      row.symbol.length > 128 ||
      (row.thicknessMm !== null &&
        row.thicknessMm !== undefined &&
        (typeof row.thicknessMm !== 'number' ||
          !Number.isFinite(row.thicknessMm) ||
          row.thicknessMm <= 0 ||
          row.thicknessMm > 10000)) ||
      typeof row.notes !== 'string' ||
      row.notes.length > 4096 ||
      (row.storyId !== undefined &&
        row.storyId !== null &&
        (typeof row.storyId !== 'string' || row.storyId.length > 128)) ||
      (row.sourceSectionId !== undefined &&
        row.sourceSectionId !== null &&
        (typeof row.sourceSectionId !== 'string' || row.sourceSectionId.length > 128))
    )
      throw new TypeError('Invalid slab-list auxiliary row');
    validateAuxiliaryBars(row);
    if (keys.has(row.id)) throw new TypeError('Duplicate slab-list auxiliary row ID');
    keys.add(row.id);
  }
  return JSON.parse(
    JSON.stringify({
      schemaVersion: SLAB_LIST_STATE_VERSION,
      mappings,
      overrides,
      xmlSources,
      ...(auxiliaryRows.length ? { auxiliaryRows } : {}),
    }),
  );
}
/** A user-confirmed link or unlink always identifies both immutable revisions. */
export function setSlabListMapping(state, mapping) {
  const next = normalizeSlabListState(state);
  const candidate = { ...mapping, confirmedAt: mapping.confirmedAt ?? new Date().toISOString() };
  normalizeSlabListState({ ...next, mappings: [candidate] });
  next.mappings = next.mappings.filter(
    (m) =>
      identity(m.modelSide, m.sectionId, m.stbRevision, m.xmlSourceHash) !==
      identity(
        candidate.modelSide,
        candidate.sectionId,
        candidate.stbRevision,
        candidate.xmlSourceHash,
      ),
  );
  next.mappings.push(candidate);
  return normalizeSlabListState(next);
}
export function setSlabListOverride(state, override) {
  const next = normalizeSlabListState(state);
  const candidate = { ...override, updatedAt: override.updatedAt ?? new Date().toISOString() };
  normalizeSlabListState({ ...next, overrides: [candidate] });
  next.overrides = next.overrides.filter(
    (o) =>
      identity(o.modelSide, o.sectionId, o.stbRevision, o.field) !==
      identity(candidate.modelSide, candidate.sectionId, candidate.stbRevision, candidate.field),
  );
  next.overrides.push(candidate);
  return normalizeSlabListState(next);
}
export function removeSlabListOverride(state, { modelSide, sectionId, stbRevision, field }) {
  const next = normalizeSlabListState(state);
  next.overrides = next.overrides.filter(
    (o) =>
      identity(o.modelSide, o.sectionId, o.stbRevision, o.field) !==
      identity(modelSide, sectionId, stbRevision, field),
  );
  return next;
}
/** Auxiliary schedule rows never mutate a source STB/XML section. */
export function addSlabListAuxiliaryRow(state, row) {
  const next = normalizeSlabListState(state);
  if ((next.auxiliaryRows || []).some((item) => item.id === row.id))
    throw new TypeError('Auxiliary row ID already exists');
  return normalizeSlabListState({
    ...next,
    auxiliaryRows: [...(next.auxiliaryRows || []), row],
  });
}
export function updateSlabListAuxiliaryRow(state, row) {
  const next = normalizeSlabListState(state);
  const matches = (next.auxiliaryRows || []).filter(
    (item) =>
      item.id === row.id &&
      item.modelSide === row.modelSide &&
      item.stbRevision === row.stbRevision,
  );
  if (matches.length !== 1) throw new TypeError('Auxiliary row is missing or stale');
  return normalizeSlabListState({
    ...next,
    auxiliaryRows: next.auxiliaryRows.map((item) =>
      item.id === row.id ? { ...item, ...row } : item,
    ),
  });
}
export function deleteSlabListAuxiliaryRow(state, { id, modelSide, stbRevision }) {
  const next = normalizeSlabListState(state);
  if (
    !(next.auxiliaryRows || []).some(
      (row) => row.id === id && row.modelSide === modelSide && row.stbRevision === stbRevision,
    )
  )
    throw new TypeError('Auxiliary row is missing or stale');
  return normalizeSlabListState({
    ...next,
    auxiliaryRows: next.auxiliaryRows.filter((row) => row.id !== id),
  });
}
function fromStb(section) {
  return {
    symbol: { status: section.symbol ? 'VALID' : 'MISSING', value: section.symbol || null },
    thicknessMm: {
      status:
        section.shape?.type === 'STRAIGHT' && Number.isFinite(section.shape?.depthMm)
          ? 'VALID'
          : 'UNSUPPORTED',
      value:
        section.shape?.type === 'STRAIGHT' && Number.isFinite(section.shape?.depthMm)
          ? section.shape.depthMm
          : null,
    },
    concrete: { status: section.concrete ? 'VALID' : 'MISSING', value: section.concrete || null },
  };
}
function fromXml(record) {
  const get = (key) => {
    const f = record?.fields?.[key];
    return {
      status: f?.status ?? 'MISSING',
      value: f?.status === 'VALID' ? (own(f, 'value') && f.value != null ? f.value : f.raw) : null,
      raw: f?.raw ?? null,
      unit: f?.unit ?? null,
    };
  };
  return {
    symbol: get('Name'),
    thicknessMm: get('t'),
    notes: get('備考'),
    lx: get('lx'),
    ly: get('ly'),
    dt: get('dt'),
    w: get('w'),
  };
}
/**
 * thicknessUnit='mm' is an explicit caller assertion, not an inferred conversion.
 * P1 XML units are unverified by default; values remain visible but unadopted.
 */
export function resolveSlabList({
  stbFacts = null,
  xmlFacts = null,
  xmlSourceHash = null,
  state = createSlabListState(),
  thicknessUnit = null,
  modelSide = null,
} = {}) {
  const ledger = normalizeSlabListState(state);
  if (stbFacts && !SIDES.has(stbFacts.modelSide)) throw new TypeError('Invalid STB model side');
  if (stbFacts && modelSide != null && modelSide !== stbFacts.modelSide)
    throw new TypeError('Supplementary XML model side differs from STB side');
  if (xmlFacts && (xmlFacts.ok !== true || !/^[a-f0-9]{64}$/.test(xmlSourceHash)))
    throw new TypeError('Valid XML facts and source hash required');
  const sections = stbFacts?.sections ?? [];
  const records = xmlFacts?.records ?? [];
  const side = stbFacts?.modelSide ?? modelSide ?? 'A';
  if (sections.some((section) => section.modelSide !== side))
    throw new TypeError('STB slab section model side mismatch');
  if (
    stbFacts &&
    validString(stbFacts.revision) &&
    sections.some(
      (section) => validString(section.stb?.revision) && section.stb.revision !== stbFacts.revision,
    )
  )
    throw new TypeError('STB slab section revision mismatch');
  const recordIndices = new Set();
  for (const record of records) {
    if (!Number.isSafeInteger(record.index) || record.index < 0 || recordIndices.has(record.index))
      throw new TypeError('Invalid or duplicate XML Record index');
    recordIndices.add(record.index);
  }
  if (!SIDES.has(side)) throw new TypeError('Invalid supplementary XML model side');
  const revision = stbFacts?.revision;
  const diagnostics = [];
  const bySymbol = (rows, name) =>
    rows.filter((x) => normalizeSlabSymbol(name(x)) && normalizeSlabSymbol(name(x)) !== '無題');
  const stbNames = new Map();
  const xmlNames = new Map();
  for (const section of bySymbol(sections, (s) => s.symbol)) {
    const name = normalizeSlabSymbol(section.symbol);
    stbNames.set(name, [...(stbNames.get(name) ?? []), section]);
  }
  for (const record of bySymbol(records, (r) => r.name)) {
    const name = normalizeSlabSymbol(record.name);
    xmlNames.set(name, [...(xmlNames.get(name) ?? []), record]);
  }
  // Reserve explicit manual links BEFORE automatic candidates to avoid order-dependent stealing.
  const reserved = new Map();
  for (const m of ledger.mappings) {
    if (
      m.modelSide !== side ||
      m.stbRevision !== revision ||
      m.xmlSourceHash !== xmlSourceHash ||
      m.decision !== 'LINK'
    )
      continue;
    const record = records.find((r) => r.index === m.recordIndex && r.name === m.recordName);
    if (record) reserved.set(record.index, (reserved.get(record.index) ?? 0) + 1);
  }
  const claimed = new Set();
  const rows = sections.map((section) => {
    const sectionId = section.stb?.sectionId;
    const base = {
      id: section.id,
      modelSide: side,
      sectionId,
      stbRevision: revision,
      symbol: section.symbol,
      section,
      mapping: { state: 'STB_ONLY', confirmed: false },
      resolvedFields: {},
      diagnostics: [],
    };
    if (xmlFacts && !validString(revision)) {
      base.mapping.state = 'NEEDS_REVIEW';
      base.diagnostics.push('SOURCE_REVISION_MISSING');
    }
    if (
      !validString(sectionId) ||
      sections.filter((s) => s.stb?.sectionId === sectionId).length !== 1
    ) {
      base.mapping.state = 'NEEDS_REVIEW';
      base.diagnostics.push('SECTION_ID_MISSING_OR_DUPLICATE');
    }
    const relevant = ledger.mappings.filter(
      (m) => m.modelSide === side && m.sectionId === sectionId,
    );
    // An ambiguous STB section identity must never apply an override to multiple rows.
    const uniqueSectionId =
      validString(sectionId) && sections.filter((s) => s.stb?.sectionId === sectionId).length === 1;
    const overrides = uniqueSectionId
      ? ledger.overrides.filter((o) => o.modelSide === side && o.sectionId === sectionId)
      : [];
    const currentMapping = relevant.find(
      (m) => m.stbRevision === revision && m.xmlSourceHash === xmlSourceHash,
    );
    if (
      (!currentMapping &&
        relevant.some((m) => m.stbRevision !== revision || m.xmlSourceHash !== xmlSourceHash)) ||
      (!currentMapping &&
        overrides.some((o) => o.stbRevision !== revision) &&
        !overrides.some((o) => o.stbRevision === revision))
    ) {
      base.mapping.state = 'STALE';
      base.diagnostics.push('SOURCE_REVISION_CHANGED');
    }
    const explicit = relevant.find(
      (m) => m.stbRevision === revision && m.xmlSourceHash === xmlSourceHash,
    );
    let record = null;
    if (
      base.mapping.state !== 'NEEDS_REVIEW' &&
      base.mapping.state !== 'STALE' &&
      explicit?.decision === 'UNLINK'
    ) {
      base.mapping.state = 'STB_ONLY';
      base.mapping.confirmed = true;
      base.mapping.confirmedAt = explicit.confirmedAt ?? null;
    } else if (base.mapping.state !== 'NEEDS_REVIEW' && base.mapping.state !== 'STALE') {
      if (explicit?.decision === 'LINK') {
        record =
          records.find((r) => r.index === explicit.recordIndex && r.name === explicit.recordName) ??
          null;
        if (!record) {
          base.mapping.state = 'STALE';
          base.diagnostics.push('XML_RECORD_CHANGED');
        } else if (claimed.has(record.index) || (reserved.get(record.index) ?? 0) > 1) {
          base.mapping.state = 'NEEDS_REVIEW';
          base.diagnostics.push('RECORD_ALREADY_CLAIMED');
          record = null;
        } else {
          base.mapping.state = 'MAPPED';
          base.mapping.confirmed = true;
          base.mapping.confirmedAt = explicit.confirmedAt ?? null;
        }
      } else if (
        xmlFacts &&
        normalizeSlabSymbol(section.symbol) &&
        normalizeSlabSymbol(section.symbol) !== '無題'
      ) {
        const name = normalizeSlabSymbol(section.symbol);
        const candidates = xmlNames.get(name) ?? [];
        if ((stbNames.get(name)?.length ?? 0) > 1 || candidates.length > 1) {
          base.mapping.state = 'NEEDS_REVIEW';
          base.diagnostics.push('DUPLICATE_SYMBOL');
        } else if (candidates.length === 1) {
          if (reserved.has(candidates[0].index) || claimed.has(candidates[0].index)) {
            base.mapping.state = 'NEEDS_REVIEW';
            base.diagnostics.push('RECORD_RESERVED_OR_CLAIMED');
          } else {
            record = candidates[0];
            base.mapping.state = 'MAPPED';
          }
        }
      }
    }
    if (record) {
      const xmlT = fromXml(record).thicknessMm;
      const stbT = fromStb(section).thicknessMm;
      if (xmlT.status !== 'VALID') {
        base.diagnostics.push('THICKNESS_VALUE_UNVERIFIED');
        if (!base.mapping.confirmed) {
          record = null;
          base.mapping.state = 'NEEDS_REVIEW';
        }
      } else if (thicknessUnit !== 'mm' || stbT.status !== 'VALID') {
        base.diagnostics.push('THICKNESS_COMPARISON_UNVERIFIED');
        if (!base.mapping.confirmed) {
          record = null;
          base.mapping.state = 'NEEDS_REVIEW';
        }
      } else if (xmlT.status === 'VALID' && stbT.status === 'VALID' && xmlT.value !== stbT.value) {
        base.diagnostics.push('THICKNESS_MISMATCH');
        if (!base.mapping.confirmed) {
          record = null;
          base.mapping.state = 'NEEDS_REVIEW';
        }
      }
    }
    if (record) {
      base.xmlRecord = record; // preserve every P1 Place/design/material fact without inference
      claimed.add(record.index);
      base.mapping = {
        ...base.mapping,
        recordIndex: record.index,
        xmlSourceHash,
        recordName: record.name,
      };
    }
    const stbValues = fromStb(section);
    const xmlValues = record ? fromXml(record) : {};
    for (const key of new Set([
      ...Object.keys(stbValues),
      ...Object.keys(xmlValues),
      ...overrides.map((o) => o.field),
    ])) {
      const s = stbValues[key] ?? { status: 'MISSING', value: null };
      const x = xmlValues[key] ?? { status: 'MISSING', value: null };
      const override = overrides.find((o) => o.stbRevision === revision && o.field === key);
      const stale = base.mapping.state === 'STALE';
      const conflict =
        s.status === 'VALID' &&
        x.status === 'VALID' &&
        s.value !== x.value &&
        !(key === 'symbol' && normalizeSlabSymbol(s.value) === normalizeSlabSymbol(x.value)) &&
        !(key === 'thicknessMm' && thicknessUnit !== 'mm');
      const winner =
        override && !stale
          ? {
              value: override.value,
              source: 'OVERRIDE',
              status: override.value === null ? 'EXPLICIT_NULL' : 'VALID',
              reason: 'USER_EXPLICIT',
            }
          : s.status === 'VALID'
            ? { value: s.value, source: 'STB', status: 'VALID', reason: 'STB_AUTHORITATIVE' }
            : key === 'thicknessMm' && s.status === 'UNSUPPORTED'
              ? // A tapered/haunched STB slab is not representable as one XML thickness.
                {
                  value: null,
                  source: null,
                  status: 'UNSUPPORTED',
                  reason: 'STB_GEOMETRY_UNSUPPORTED',
                }
              : !stale && x.status === 'VALID' && !(key === 'thicknessMm' && thicknessUnit !== 'mm')
                ? { value: x.value, source: 'XML', status: 'VALID', reason: 'STB_MISSING' }
                : {
                    value: null,
                    source: null,
                    status: s.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'MISSING',
                    reason: stale ? 'STALE_SOURCE' : 'NO_VALID_VALUE',
                  };
      base.resolvedFields[key] = {
        ...winner,
        conflict,
        stb: s,
        xml: x,
        provenance: {
          stbRevision: revision ?? null,
          xmlSourceHash: record ? xmlSourceHash : null,
          overrideTimestamp: override?.updatedAt ?? null,
          mappingConfirmedAt: explicit?.confirmedAt ?? null,
        },
      };
      if (conflict) base.diagnostics.push('FIELD_CONFLICT:' + key);
    }
    if (
      base.mapping.state === 'MAPPED' &&
      base.diagnostics.some((d) => d === 'THICKNESS_MISMATCH' || d.startsWith('FIELD_CONFLICT:'))
    )
      base.mapping.state = 'CONFLICTED';
    diagnostics.push(...base.diagnostics.map((code) => ({ code, sectionId, modelSide: side })));
    return base;
  });
  for (const record of records) {
    if (!claimed.has(record.index))
      rows.push({
        id: 'xml-only:' + side + ':' + xmlRecordIdentity(record, xmlSourceHash),
        modelSide: side,
        sectionId: null,
        stbRevision: null,
        symbol: record.name,
        section: null,
        xmlRecord: record,
        mapping: { state: 'XML_ONLY', confirmed: false },
        // XML-only records are reference data, never fabricated STB members.
        resolvedFields: Object.fromEntries(
          Object.entries(fromXml(record)).map(([field, source]) => {
            // XML t has no verified unit. Keep the raw reference value, but never
            // expose it as an adopted millimetre value without an explicit gate.
            const unitUnverified =
              field === 'thicknessMm' && source.status === 'VALID' && thicknessUnit !== 'mm';
            return [
              field,
              {
                value: unitUnverified ? null : source.value,
                source: !unitUnverified && source.status === 'VALID' ? 'XML' : null,
                status: unitUnverified ? 'UNIT_UNVERIFIED' : source.status,
                unit: source.unit ?? null,
                reason: unitUnverified ? 'UNIT_UNVERIFIED_REFERENCE' : 'XML_ONLY_REFERENCE',
                conflict: false,
                stb: { status: 'MISSING', value: null },
                xml: source,
                provenance: { stbRevision: null, xmlSourceHash, overrideTimestamp: null },
              },
            ];
          }),
        ),
        diagnostics: [],
      });
  }
  return { rows, diagnostics };
}
