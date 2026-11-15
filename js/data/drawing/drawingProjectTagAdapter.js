import { createDrawingProjectTagPlacementResolver } from './drawingProjectRenderAdapter.js';
import { BUILTIN_TAG_FAMILY_SOURCES } from './tags/builtinTagFamilies.js';
import { familySelectionValue } from './tags/tagFamilyRegistry.js';
import { tagFamilyCategoryForElementType } from './tags/tagFamilyDefinition.js';

/**
 * Render automatic member marks for a registered view without explicit tag intents.
 * When tag intents are stored, publish exactly those persisted member-mark tags.
 * The existing pure placement resolver handles model-fixed, paper-fixed and
 * semantic follow-member origins in model/paper mm. Rich templates need STB
 * facts and are not reconstructed by the independent sheet pipeline.
 */
export function createCadSheetPersistedTagOptions({
  project,
  document,
  drawing,
  modelToPaper,
  resolveTagFacts = null,
} = {}) {
  const intents = document?.tagIntents || [];
  if (!intents.length) {
    return {
      showLabels: true,
      tagOrientationMode: document.sheet.tagOrientationMode,
      tagFamilyState: project.definitions?.tagFamilyState,
      resolveTagFacts,
      resolveTagSelection: (record) => {
        const elementType = record.renderType || record.ref.elementType;
        const selected = document.display?.tagModes?.[elementType] ?? 'mark';
        // Restore the saved view's actual tag family rather than silently
        // substituting a member mark for an RC section figure.
        if (selected !== 'hidden' && selected !== 'mark' && !resolveTagFacts)
          throw new Error('登録ビューの詳細・豆図タグにはSTB原本が必要です: ' + document.id);
        return selected;
      },
    };
  }
  const selectionsByKey = new Map();
  const drawingRecords = new Map((drawing?.elements || []).map((item) => [item.key, item]));
  for (const intent of intents) {
    const binding = project.bindings.find((entry) => entry.entityId === intent.binding.entityId);
    if (!binding || binding.modelSlotId !== document.modelSlotId)
      throw new Error('保存タグのBindingRegistryが一致しません: ' + intent.id);
    const revision = binding.revisions.find(
      (entry) => entry.sourceRevisionId === document.sourceRevisionId,
    );
    if (!revision) throw new Error('保存タグに現行改訂の対応先がありません: ' + intent.id);
    // Explicitly orphaned intents are retained, but never drawn as current.
    if (revision.orphaned) continue;
    const ref = revision.sourceRef;
    if (!ref) throw new Error('保存タグの部材参照がありません: ' + intent.id);
    const category = tagFamilyCategoryForElementType(ref.elementType);
    const template = intent.template;
    let selection;
    if (template.id === 'member-mark-v1' && template.version === 1) {
      selection = 'mark';
    } else {
      const builtin = BUILTIN_TAG_FAMILY_SOURCES.find(
        (item) =>
          item.templateId === template.id &&
          item.family.version === template.version &&
          item.family.category === category,
      );
      const custom = project.definitions?.tagFamilyState?.families?.find(
        (family) =>
          family.id === template.id &&
          family.version === template.version &&
          family.category === category,
      );
      const family = builtin?.family || custom;
      if (!family) throw new Error('保存タグのテンプレート描画が未対応です: ' + template.id);
      selection = familySelectionValue(family.id);
      if (!resolveTagFacts) throw new Error('保存豆図タグにはSTB原本が必要です: ' + document.id);
    }
    const key = JSON.stringify(['A', ref.elementType, String(ref.elementId)]);
    const record = drawingRecords.get(key);
    if (
      !record ||
      record.state !== 'drawn' ||
      record.taggable === false ||
      String(record.ref?.elementType) !== String(ref.elementType) ||
      String(record.ref?.elementId) !== String(ref.elementId) ||
      (ref.guid != null && String(ref.guid) !== String(record.ref?.guid))
    )
      throw new Error('保存タグの現行STB部材を描画できません: ' + intent.id);
    if (document.view.type === 'elevation' && !String(record.mark || '').trim())
      throw new Error('軸組図の保存タグにSTB部材符号がありません: ' + intent.id);
    if (selectionsByKey.has(key) && selectionsByKey.get(key) !== selection)
      throw new Error('同一部材に異なる保存タグタイプが競合しています: ' + intent.id);
    selectionsByKey.set(key, selection);
  }
  if (!selectionsByKey.size) return { showLabels: false };

  const resolvePlacement = createDrawingProjectTagPlacementResolver({
    project,
    drawingId: document.id,
    modelToPaper,
  });
  return {
    showLabels: true,
    tagOrientationMode: document.sheet.tagOrientationMode,
    tagFamilyState: project.definitions?.tagFamilyState,
    resolveTagFacts,
    resolveTagSelection: (record) => selectionsByKey.get(record.key) ?? 'hidden',
    resolveTagPlacement: (context) => {
      const placement = resolvePlacement(context);
      if (placement == null)
        throw new Error('保存タグの配置を再解決できません: ' + context.elementKey);
      return placement;
    },
  };
}
