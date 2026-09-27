/**
 * @fileoverview モデル状態の初期値ファクトリー
 */

export function createEmptySectionMaps() {
  return {
    columnSections: new Map(),
    postSections: new Map(),
    girderSections: new Map(),
    beamSections: new Map(),
    braceSections: new Map(),
    pileSections: new Map(),
    footingSections: new Map(),
    foundationColumnSections: new Map(),
    foundationcolumnSections: new Map(),
    slabSections: new Map(),
    wallSections: new Map(),
    parapetSections: new Map(),
    isolatingDeviceSections: new Map(),
    isolatingdeviceSections: new Map(),
    dampingDeviceSections: new Map(),
    dampingdeviceSections: new Map(),
    undefinedSections: new Map(),
  };
}

export function createEmptyElementData() {
  return {
    columnElements: [],
    postElements: [],
    girderElements: [],
    beamElements: [],
    braceElements: [],
    isolatingDeviceElements: [],
    dampingDeviceElements: [],
    frameDampingDeviceElements: [],
    pileElements: [],
    footingElements: [],
    foundationColumnElements: [],
    slabElements: [],
    wallElements: [],
    parapetElements: [],
    openingElements: [],
    jointElements: [],
    stripFootingElements: [],
    undefinedElements: [],
  };
}

export function createInitialEditingState() {
  return {
    active: false,
    sessionId: null,
    sourceDocumentA: null,
    workingDocument: null,
    sourceNodeMapA: new Map(),
    workingNodeMap: new Map(),
    workingRevision: 0,
    moveFollowRelatedNodes: true,
    dirty: false,
    untrackedDirty: false,
    history: [],
    redoStack: [],
  };
}

export function createInitialModelState() {
  return {
    documentA: null,
    documentB: null,
    nodeMapA: new Map(),
    nodeMapB: new Map(),
    calDataA: null,
    calDataB: null,
    nodeMapRawA: new Map(),
    nodeMapRawB: new Map(),
    sectionMaps: createEmptySectionMaps(),
    steelSections: new Map(),
    elementData: createEmptyElementData(),
    // STB原データとは分離して保持する派生数量store（QuantityServiceが読込後に設定）
    derivedQuantitiesA: null,
    derivedQuantitiesB: null,
    // DerivedQuantityStore を集計向けに正規化した派生キャッシュ（STB正本ではない）
    quantityFactsA: null,
    quantityFactsB: null,
    editing: createInitialEditingState(),
    modelsLoaded: false,
    stbVersionA: null,
    stbVersionB: null,
    activeXsdVersion: null,
    versionInfo: null,
    stories: [],
    axesData: { xAxes: [], yAxes: [] },
    modelBounds: null,
  };
}
