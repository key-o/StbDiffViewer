import { normalizeDrawingProject } from '../../data/drawing/drawingProjectSchema.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tagKey = (item) =>
  JSON.stringify([item.binding.entityId, item.template.id, item.template.version]);
const reviewKey = (item) =>
  JSON.stringify([
    item.binding.entityId,
    item.context.sourceRevisionId,
    item.context.view.type,
    item.context.view.storyId,
  ]);

function uniqueIndex(items, key, label) {
  const index = new Map();
  for (const item of items) {
    const identity = key(item);
    if (index.has(identity)) throw new Error(`DrawingProject ${label} が曖昧です。`);
    index.set(identity, item);
  }
  return index;
}

/** The workspace can edit one current document, while retaining inactive history. */
export function assertDrawingProjectWorkspaceEditSafe(input) {
  const project = normalizeDrawingProject(input);
  if (project.modelSlots.length !== 1 || project.drawingDocuments.length !== 1)
    throw new Error(
      '複数 slot・複数図面の再保存は未対応です。履歴を失わないため保存を中止します。',
    );
  const slot = project.modelSlots[0];
  const document = project.drawingDocuments[0];
  if (document.modelSlotId !== slot.id || document.sourceRevisionId !== slot.currentRevisionId)
    throw new Error('DrawingProject の現在改訂が一致しません。');
  uniqueIndex(
    project.bindings.flatMap((binding) => {
      const current = binding.revisions.find(
        (r) => r.sourceRevisionId === document.sourceRevisionId,
      );
      return current ? [{ ...current.sourceRef, entityId: binding.entityId }] : [];
    }),
    (ref) => JSON.stringify([ref.elementType, ref.elementId]),
    'sourceRef',
  );
  uniqueIndex(document.tagIntents, tagKey, 'tag');
  for (const intent of document.tagIntents) {
    if (intent.placement.mode !== 'model-fixed')
      throw new Error('DrawingProject の配置モードを workspace で保持できません。');
  }
  for (const items of [document.memberReviews, document.annotations]) {
    for (const item of items) {
      if (
        item.context.sourceRevisionId === document.sourceRevisionId &&
        (item.context.view.type !== document.view.type ||
          item.context.view.storyId !== document.view.storyId ||
          (item.context.view.storyBinding != null &&
            !equal(item.context.view.storyBinding, document.view.storyBinding)))
      )
        throw new Error('DrawingProject の現在レビュー・注記の view が一致しません。');
    }
  }
  uniqueIndex(document.memberReviews, reviewKey, 'review');
  return project;
}

function retainIds(previous, edited, key) {
  const existing = uniqueIndex(previous, key, '編集 ID');
  uniqueIndex(edited, key, '編集 ID');
  const reserved = new Set(previous.map((item) => item.id));
  const retained = new Set();
  return edited.map((item) => {
    const original = existing.get(key(item));
    let id = original?.id || item.id;
    if (!original) {
      // Deleted intent IDs must not be recycled for a different semantic item.
      let suffix = 1;
      while (reserved.has(id) || retained.has(id)) id = `${item.id}:workspace:${suffix++}`;
    }
    if (retained.has(id)) throw new Error('DrawingProject の編集 ID が重複しています。');
    retained.add(id);
    return { ...item, ...(original?.context ? { context: original.context } : {}), id };
  });
}

/** Merge runtime edits into a clone; never rebuild the revision registry from runtime. */
export function mergeDrawingProjectWorkspaceSnapshot({ project: input, snapshot: editedInput }) {
  const project = assertDrawingProjectWorkspaceEditSafe(input);
  const edited = assertDrawingProjectWorkspaceEditSafe(editedInput);
  const document = project.drawingDocuments[0];
  const next = edited.drawingDocuments[0];
  const slot = project.modelSlots[0];
  const editedSlot = edited.modelSlots[0];
  const current = slot.revisions.find((r) => r.id === slot.currentRevisionId);
  const nextCurrent = editedSlot.revisions.find((r) => r.id === editedSlot.currentRevisionId);
  if (
    project.projectId !== edited.projectId ||
    slot.id !== editedSlot.id ||
    document.id !== next.id ||
    document.sourceRevisionId !== next.sourceRevisionId ||
    !equal(document.view, next.view) ||
    current.sha256 !== nextCurrent.sha256
  )
    throw new Error('DrawingProject の編集 context が変化しています。');

  const bindings = new Map(project.bindings.map((binding) => [binding.entityId, binding]));
  for (const binding of edited.bindings) {
    const original = bindings.get(binding.entityId);
    if (!original) {
      project.bindings.push(binding);
      bindings.set(binding.entityId, binding);
      continue;
    }
    const oldRef = original.revisions.find(
      (r) => r.sourceRevisionId === document.sourceRevisionId,
    )?.sourceRef;
    const newRef = binding.revisions.find(
      (r) => r.sourceRevisionId === next.sourceRevisionId,
    )?.sourceRef;
    if (
      !oldRef ||
      !newRef ||
      oldRef.elementType !== newRef.elementType ||
      oldRef.elementId !== newRef.elementId ||
      (oldRef.guid != null && oldRef.guid !== newRef.guid)
    )
      throw new Error('DrawingProject の現在 binding が変化しています。rebind が必要です。');
  }

  const revisionId = document.sourceRevisionId;
  const reviews = document.memberReviews.filter(
    (item) => item.context.sourceRevisionId === revisionId,
  );
  document.memberReviews = [
    ...document.memberReviews.filter((item) => item.context.sourceRevisionId !== revisionId),
    ...retainIds(reviews, next.memberReviews, reviewKey),
  ];
  const currentAnnotations = document.annotations.filter(
    (item) => item.context.sourceRevisionId === revisionId,
  );
  const annotationById = new Map(currentAnnotations.map((item) => [item.id, item]));
  const historicalAnnotations = document.annotations.filter(
    (item) => item.context.sourceRevisionId !== revisionId,
  );
  if (next.annotations.some((item) => historicalAnnotations.some((old) => old.id === item.id)))
    throw new Error('DrawingProject の過去注記 ID は現在改訂に再利用できません。');
  document.annotations = [
    ...historicalAnnotations,
    ...next.annotations.map((item) => {
      const original = annotationById.get(item.id);
      return original ? { ...item, context: original.context } : item;
    }),
  ];
  document.tagIntents = retainIds(document.tagIntents, next.tagIntents, tagKey);
  // Workspace has no dimension-intent editor. Keep imported dimensions verbatim,
  // including ones absent from the runtime's generated defaults.
  document.sheet = next.sheet;
  document.display = next.display;
  project.definitions = edited.definitions;
  return assertDrawingProjectWorkspaceEditSafe(project);
}
