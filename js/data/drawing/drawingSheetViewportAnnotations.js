/** Annotation intents belong to the registered view, not the sheet placement. */
import { normalizeDrawingProject } from './drawingProjectSchema.js';

export function resolveSheetViewportDocument(project, sheetId, placementId) {
  const sheet = project?.drawingSheets?.find(
    (item) => item.id === sheetId && item.kind !== 'section-list',
  );
  if (!sheet) throw new Error('編集対象のシートがありません。');
  const placement = sheet.placements.find((item) => item.id === placementId);
  if (!placement) throw new Error('編集対象のビューポートがありません。');
  const document = project.drawingDocuments.find((item) => item.id === placement.drawingDocumentId);
  if (!document) throw new Error('配置先のビューがありません。');
  const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
  if (!slot || slot.currentRevisionId !== document.sourceRevisionId)
    throw new Error('ビューのSTB改訂が現在のプロジェクトと一致しません。');
  return { document, placement };
}

/** Coordinates are stored in their original model-mm or paper-mm reference frame. */
export function editSheetViewportAnnotation({
  project,
  sheetId,
  placementId,
  kind,
  intentId,
  changes,
}) {
  const { document } = resolveSheetViewportDocument(project, sheetId, placementId);
  const property = kind === 'tag' ? 'tagIntents' : kind === 'dimension' ? 'dimensionIntents' : null;
  if (!property) throw new Error('未対応の注記種類です。');
  const intents = document[property] || [];
  const target = intents.find((item) => item.id === intentId);
  if (!target) throw new Error('対象ビューの注記が見つかりません。');
  let edited;
  if (kind === 'tag') {
    const existing = target.placement;
    const xy =
      changes.xy == null
        ? existing.mode === 'follow-member'
          ? existing.offset.xy
          : existing.origin.xy
        : changes.xy;
    if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(Number.isFinite))
      throw new Error('タグ座標は有限な2値で指定してください。');
    const rotationDeg = changes.rotationDeg ?? existing.orientation.rotationDeg;
    if (![0, 90, 180, 270].includes(rotationDeg))
      throw new Error('タグの回転は0/90/180/270度です。');
    const leader = changes.leader ?? existing.leader;
    if (typeof leader !== 'boolean') throw new Error('引出線は真偽値で指定してください。');
    edited = {
      ...target,
      placement: {
        ...existing,
        ...(existing.mode === 'follow-member'
          ? { offset: { ...existing.offset, xy: [...xy] } }
          : { origin: { ...existing.origin, xy: [...xy] } }),
        orientation: { ...existing.orientation, rotationDeg },
        leader,
      },
    };
  } else {
    const offsetModelMm = changes.offsetModelMm ?? target.placement.offsetModelMm;
    if (!Number.isFinite(offsetModelMm))
      throw new Error('寸法のオフセットは有限数で指定してください。');
    edited = { ...target, placement: { ...target.placement, offsetModelMm } };
  }
  return normalizeDrawingProject({
    ...project,
    drawingDocuments: project.drawingDocuments.map((entry) =>
      entry.id === document.id
        ? { ...entry, [property]: intents.map((item) => (item.id === intentId ? edited : item)) }
        : entry,
    ),
  });
}

/** Move a saved tag by a sheet SVG paper-mm delta (X right, Y down). Stored coordinates use Y up. */
export function moveSheetViewportTag({
  project,
  sheetId,
  placementId,
  intentId,
  deltaPaperMm,
  modelToPaper,
}) {
  if (
    !Array.isArray(deltaPaperMm) ||
    deltaPaperMm.length !== 2 ||
    !deltaPaperMm.every(Number.isFinite)
  )
    throw new Error('移動量が不正です。');
  const { document } = resolveSheetViewportDocument(project, sheetId, placementId);
  const tag = document.tagIntents.find((item) => item.id === intentId);
  if (!tag) throw new Error('対象ビューのタグが見つかりません。');
  const paperDelta = [deltaPaperMm[0], -deltaPaperMm[1]];
  let delta = paperDelta;
  if (tag.placement.mode === 'model-fixed') {
    if (
      !Array.isArray(modelToPaper) ||
      modelToPaper.length !== 6 ||
      !modelToPaper.every(Number.isFinite)
    )
      throw new Error('ビューポートのモデル変換がありません。');
    const [a, b, c, d] = modelToPaper,
      det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
      throw new Error('ビューポートの変換行列が特異です。');
    delta = [
      (d * paperDelta[0] - c * paperDelta[1]) / det,
      (-b * paperDelta[0] + a * paperDelta[1]) / det,
    ];
  }
  const source =
    tag.placement.mode === 'follow-member' ? tag.placement.offset.xy : tag.placement.origin.xy;
  return editSheetViewportAnnotation({
    project,
    sheetId,
    placementId,
    kind: 'tag',
    intentId,
    changes: { xy: source.map((value, index) => Math.round((value + delta[index]) * 1e6) / 1e6) },
  });
}
