/** @fileoverview DrawingModel→タグfacts境界。STB値の再取得/推定はしない。 */
import { createElementRef, elementRefKey, normalizeDrawingSource } from '../drawingModel.js';
import { normalizeTagValue } from './tagValue.js';

/** タグfactsの受渡し契約。未提供revisionはnullであり現行性の保証ではない。 */
export function normalizeTagFacts(input) {
  if (input?.schemaVersion !== 1) throw new TypeError('TagFacts v1が必要です。');
  const ref = createElementRef(
    input.ref,
    input.ref?.elementType,
    input.ref?.elementId,
    input.ref?.guid,
  );
  const elementKey = elementRefKey(ref);
  if (input.elementKey !== elementKey) throw new TypeError('タグfactsの部材参照が不正です。');
  const source =
    input.source == null || input.source.modelRevision === null
      ? { modelKey: input.source?.modelKey ?? ref.modelKey, modelRevision: null }
      : normalizeDrawingSource(input.source);
  if (source.modelKey !== ref.modelKey) throw new TypeError('タグfactsのモデルが一致しません。');
  if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields))
    throw new TypeError('タグfieldsが必要です。');
  const fields = Object.fromEntries(
    Object.entries(input.fields).map(([field, value]) => {
      if (!field.trim()) throw new TypeError('タグfield名が不正です。');
      return [field, normalizeTagValue(value)];
    }),
  );
  return Object.freeze({
    schemaVersion: 1,
    ref,
    elementKey,
    source: Object.freeze({ ...source }),
    fields: Object.freeze(fields),
  });
}

/** 既存markの出自をsection.nameと偽らず、drawing.markとして保持する。 */
export function createDrawingTagFacts({ record, source = null } = {}) {
  const missing = record?.mark == null || record.mark === '';
  return normalizeTagFacts({
    schemaVersion: 1,
    ref: record?.ref,
    elementKey: record?.key,
    source,
    fields: {
      'drawing.mark': {
        valueType: 'text',
        status: missing ? 'missing' : 'known',
        value: missing ? null : record.mark,
        reason: missing ? 'DRAWING_MARK_MISSING' : null,
        provenance: { kind: 'drawing', path: 'DrawingModel.elements[].mark' },
      },
      'member.identity': {
        valueType: 'text',
        value: `${record?.ref?.elementType} ${record?.ref?.elementId}`,
        provenance: { kind: 'derived', path: 'DrawingModel.elements[].ref: type + id' },
      },
    },
  });
}
