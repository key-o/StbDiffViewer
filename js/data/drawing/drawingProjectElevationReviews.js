/**
 * #423: Validate persisted elevation reviews against the selected STB-A view.
 * Reviews are project metadata (not graphic annotations). Historical records
 * remain inactive, while current records must resolve exactly or fail closed.
 */
function matchesElevationView(expected, actual) {
  if (
    expected?.type !== 'elevation' ||
    actual?.type !== 'elevation' ||
    expected.axisDirection !== actual.axisDirection ||
    String(expected.axisId) !== String(actual.axisId)
  )
    return false;
  const { lowerBound, upperBound, position } = actual;
  return (
    Number.isFinite(lowerBound) &&
    Number.isFinite(upperBound) &&
    Number.isFinite(position) &&
    upperBound > lowerBound &&
    Math.abs((lowerBound + upperBound) / 2 - position) < 1e-6 &&
    Math.abs((upperBound - lowerBound) / 2 - expected.depth) < 1e-6
  );
}

export function resolvePersistedElevationReviews({ project, document, drawing } = {}) {
  if (document?.view?.type !== 'elevation')
    throw new TypeError('軸組図DrawingDocumentが必要です。');
  const slot = project?.modelSlots?.find((item) => item.id === document.modelSlotId);
  const revision = slot?.revisions?.find((item) => item.id === document.sourceRevisionId);
  if (
    !revision ||
    slot.currentRevisionId !== revision.id ||
    drawing?.source?.modelKey !== 'A' ||
    ![revision.id, revision.sha256].some(
      (value) =>
        String(value).toLowerCase() === String(drawing.source?.modelRevision ?? '').toLowerCase(),
    ) ||
    !matchesElevationView(document.view, drawing.view)
  )
    throw new Error('保存レビューと現行軸組図のSTB改訂またはビューが一致しません。');

  const records = new Map();
  for (const record of drawing.elements || []) {
    if (!record?.key || records.has(record.key))
      throw new Error('軸組図の部材キーが欠落または重複しています。');
    records.set(record.key, record);
  }
  const activeReviews = [];
  const statuses = [];
  for (const review of document.memberReviews || []) {
    if (review.context.sourceRevisionId !== document.sourceRevisionId) {
      statuses.push(
        Object.freeze({ id: review.id, active: false, invalidationCode: 'STB_CHANGED' }),
      );
      continue;
    }
    const view = review.context.view;
    if (
      view?.type !== 'elevation' ||
      view.axisDirection !== document.view.axisDirection ||
      String(view.axisId) !== String(document.view.axisId) ||
      view.depth !== document.view.depth
    )
      throw new Error('軸組図の保存レビューのビューが一致しません: ' + review.id);
    const binding = project.bindings?.find(
      (item) =>
        item.entityId === review.binding.entityId && item.modelSlotId === document.modelSlotId,
    );
    const mapped = binding?.revisions?.find(
      (item) => item.sourceRevisionId === document.sourceRevisionId,
    );
    if (!mapped) throw new Error('軸組図の保存レビューに現行Bindingがありません: ' + review.id);
    if (mapped.orphaned) {
      statuses.push(
        Object.freeze({ id: review.id, active: false, invalidationCode: 'BINDING_ORPHANED' }),
      );
      continue;
    }
    const ref = mapped.sourceRef;
    if (!ref) throw new Error('軸組図の保存レビューに部材参照がありません: ' + review.id);
    const key = JSON.stringify(['A', ref.elementType, String(ref.elementId)]);
    const record = records.get(key);
    if (
      !record ||
      record.state !== 'drawn' ||
      String(record.ref?.modelKey) !== 'A' ||
      String(record.ref?.elementType) !== String(ref.elementType) ||
      String(record.ref?.elementId) !== String(ref.elementId) ||
      (ref.guid != null && String(record.ref?.guid) !== String(ref.guid))
    )
      throw new Error('軸組図の保存レビューの現行STB部材を特定できません: ' + review.id);
    activeReviews.push(
      Object.freeze({
        id: review.id,
        identity: Object.freeze(['A', String(ref.elementType), String(ref.elementId)]),
        reviewState: review.reviewState,
        memo: review.memo,
      }),
    );
    statuses.push(Object.freeze({ id: review.id, active: true, invalidationCode: null }));
  }
  return Object.freeze({
    activeReviews: Object.freeze(activeReviews),
    statuses: Object.freeze(statuses),
  });
}
