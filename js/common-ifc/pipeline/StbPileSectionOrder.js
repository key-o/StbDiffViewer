/**
 * The ST-Bridge 2.1 StbSections sequence requires RC, steel and precast pile
 * sections in this order, irrespective of the order of IFC member discovery.
 * Preserve the original relative order within each classification.
 */
export function orderPileSectionUsages(usages, sectionById, inferStructure) {
  const rank = (usage) => {
    const section = sectionById.get(usage.sectionId);
    if (!section) return 3;
    const structure = inferStructure(usage.elements, section);
    if (section.stbType === 'PILE_PRODUCT' || structure === 'PC') return 2;
    if (structure === 'RC' && ['PILE_RC', 'CIRCLE'].includes(section.stbType)) return 0;
    if (structure === 'S' && ['PILE_S', 'PIPE'].includes(section.stbType)) return 1;
    return 3;
  };
  return [...usages].sort((left, right) => rank(left) - rank(right));
}
