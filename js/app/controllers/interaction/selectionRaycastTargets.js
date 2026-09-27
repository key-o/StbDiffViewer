/**
 * @fileoverview 3D選択raycastの対象rootを表示中の構造要素groupへ限定する。
 *
 * scene全体を毎回recursive raycastせず、elementGroupsの表示中groupだけをrootにする。
 * rootの並びはelementGroupsの挿入順（SUPPORTED_ELEMENTS順）を保持し、同距離hit時の
 * 既存選択順序を変えない。group配下のchildrenはThree.jsのrecursive raycastへ委譲する。
 */

function isGroup(group) {
  return Boolean(group && typeof group === 'object');
}

function collectEntries(elementGroups) {
  if (!elementGroups || typeof elementGroups !== 'object') return [];

  const entries = [];
  for (const elementType of Object.keys(elementGroups)) {
    const group = elementGroups[elementType];
    if (!isGroup(group)) continue;
    entries.push({
      elementType,
      group,
      visible: group.visible !== false,
    });
  }
  return entries;
}

/**
 * 表示中のelement group rootだけをlazy cacheする。
 *
 * hot pathでは固定entry配列をallocation-freeで走査し、group参照またはvisible値が変わった
 * ときだけtarget配列を再構築する。新しいelement typeをmapへ追加した場合だけinvalidate()を
 * 呼び、entry集合自体を再取得する。
 *
 * @param {Object<string, import('three').Object3D>} elementGroups
 */
export function createSelectionRaycastTargetIndex(elementGroups) {
  let entries = [];
  let cachedTargets = [];
  let refreshCount = 0;
  let topologyDirty = true;

  const refreshTargets = () => {
    const nextTargets = [];

    for (const entry of entries) {
      const currentGroup = elementGroups?.[entry.elementType];
      entry.group = isGroup(currentGroup) ? currentGroup : null;
      entry.visible = Boolean(entry.group && entry.group.visible !== false);
      if (entry.visible) nextTargets.push(entry.group);
    }

    cachedTargets = nextTargets;
    refreshCount += 1;
    return cachedTargets;
  };

  const refreshTopology = () => {
    entries = collectEntries(elementGroups);
    topologyDirty = false;
    return refreshTargets();
  };

  return {
    getTargets() {
      if (topologyDirty) return refreshTopology();

      for (const entry of entries) {
        const currentGroup = elementGroups?.[entry.elementType];
        const currentVisible = Boolean(isGroup(currentGroup) && currentGroup.visible !== false);
        if (currentGroup !== entry.group || currentVisible !== entry.visible) {
          return refreshTargets();
        }
      }

      return cachedTargets;
    },

    /**
     * elementGroupsのキー集合が変化した場合に呼ぶ。
     * visibility変更だけならgetTargets()が自動検出するため不要。
     */
    invalidate() {
      topologyDirty = true;
    },

    getStats() {
      return {
        refreshCount,
        targetCount: cachedTargets.length,
        elementGroupCount: entries.length,
      };
    },
  };
}
