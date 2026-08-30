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

export function createInitialModelState() {
  return {
    documentA: null,
    documentB: null,
    nodeMapA: new Map(),
    nodeMapB: new Map(),
    calDataA: null,
    calDataB: null,
    ss7OriginalCsvTextA: null,
    ss7OriginalCsvTextB: null,
    nodeMapRawA: new Map(),
    nodeMapRawB: new Map(),
    sectionMaps: createEmptySectionMaps(),
    steelSections: new Map(),
    elementData: createEmptyElementData(),
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
