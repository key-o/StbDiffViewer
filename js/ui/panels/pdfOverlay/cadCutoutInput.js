/**
 * Shared model-mm rectangle input for both the dedicated plan/elevation cutout
 * windows and the legacy current-view registration path. UI selectors and
 * registration transactions remain owned by their respective controllers.
 */
import { normalizeCutBoundsMm } from '../../../data/drawing/drawingSheetCutRegion.js';

const RECT_FIELDS = ['min-x', 'min-y', 'max-x', 'max-y'];
const RECT_KEYS = ['minX', 'minY', 'maxX', 'maxY'];

export function parseOptionalCadCutBounds(
  readField,
  incompleteMessage = '切り出し範囲は4座標すべて指定してください。',
) {
  const raw = RECT_FIELDS.map((field) => String(readField(field) ?? '').trim());
  const filled = raw.filter(Boolean).length;
  if (filled === 0) return null;
  if (filled !== 4) throw new Error(incompleteMessage);
  return normalizeCutBoundsMm(
    Object.fromEntries(RECT_KEYS.map((key, index) => [key, Number(raw[index])])),
  );
}
