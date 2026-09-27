import {
  isSchemaLoaded,
  getAllAttributeNames,
  initializeJsonSchemas,
} from '../../../common-stb/import/parser/jsonSchemaLoader.js';
import { createLogger } from '../../../utils/logger.js';
import { getState } from '../../../data/state/globalState.js';
import editDocumentProvider from '../../../app/editing/editDocumentProvider.js';
import { getImportanceManager } from '../../../app/importanceManager.js';
import { eventBus, ImportanceEvents } from '../../../data/events/index.js';
import {
  setDisplayElementInfoFn,
  setCurrentEditingElement,
  getCurrentEditingElement,
} from './editMode/index.js';
import { buildSingleModelTitle, resolveElementInfoModelSide } from './DisplayModelResolver.js';
import { escapeHtml } from '../../../utils/htmlUtils.js';
import {
  applyPanelSize,
  setupPanelResizeObserver,
  tryFallbackDisplay,
  showJointMeshDataOnly,
  showInfo,
  clearElementInfoDisplayState,
  displayMultiSelectionSummary as renderMultiSelectionSummary,
} from './ElementInfoPanel.js';
import { exportElementInfoAsJson as _exportElementInfoAsJson } from './ElementInfoJsonExporter.js';

const logger = createLogger('viewer:element-info');

let currentDisplayNodes = { nodeA: null, nodeB: null, elementType: null };
let schemaInitialized = false;

const fallbackTypes = {
  Girder: ['Beam'],
  Beam: ['Girder'],
};

const JOINT_XML_TAGS = [
  'StbJointBeamShapeH',
  'StbJointColumnShapeH',
  'StbJointBeamShapeBox',
  'StbJointColumnShapeBox',
  'StbJointBeamShapeT',
  'StbJointColumnShapeT',
];

function resetElementInfoState(contentDiv = null, { renderEmptyMessage = false } = {}) {
  currentDisplayNodes = { nodeA: null, nodeB: null, elementType: null };
  setCurrentEditingElement(null);
  clearElementInfoDisplayState(contentDiv, { renderEmptyMessage });
}

function findSectionTagNameById(doc, sectionId) {
  if (!doc || !sectionId) return null;
  const sectionsRoot = doc.querySelector('StbSections');
  if (!sectionsRoot) return null;

  const targetId = String(sectionId);
  for (const child of sectionsRoot.children || []) {
    if (child?.getAttribute?.('id') === targetId) {
      return child.tagName || null;
    }
  }
  return null;
}

function extractJointIdFromMeshId(meshId) {
  if (!meshId) return null;
  const match = meshId.match(/^joint_(\d+)(?:_(?:start|end))?$/);
  return match ? match[1] : null;
}

function findJointXmlNode(doc, jointId) {
  if (!doc || !jointId) return null;

  for (const tagName of JOINT_XML_TAGS) {
    const node = doc.querySelector(`${tagName}[id="${jointId}"]`);
    if (node) return node;
  }
  return null;
}

function findJointMeshData(jointMeshId) {
  const scene = window?.viewer?.scene || window?.scene;
  if (!scene) return null;

  let result = null;
  scene.traverse((obj) => {
    if (result) return;
    if (obj.isMesh && obj.userData && obj.userData.id === jointMeshId) {
      result = obj.userData;
    }
  });
  return result;
}

function findElementWithFallback(doc, id, primaryTagName, elementType, modelLabel) {
  let node = doc.querySelector(`${primaryTagName}[id="${id}"]`);
  if (node) {
    return { node, foundType: elementType };
  }

  const fallbacks = fallbackTypes[elementType] || [];
  for (const fallbackType of fallbacks) {
    const fallbackTagName = `Stb${fallbackType}`;
    node = doc.querySelector(`${fallbackTagName}[id="${id}"]`);
    if (node) {
      logger.warn(
        `Element with ID ${id} found as ${fallbackType} (not ${elementType}) in model ${modelLabel}. ` +
          `This may indicate overlapping elements in 3D view.`,
      );
      return { node, foundType: fallbackType };
    }
  }

  logger.warn(`Element ${elementType} with ID ${id} not found in model ${modelLabel}.`);
  return { node: null, foundType: elementType };
}

async function initializeSchema() {
  if (schemaInitialized) return;

  if (isSchemaLoaded()) {
    schemaInitialized = true;
    return;
  }

  try {
    const success = await initializeJsonSchemas();
    if (!success) {
      logger.warn('JSON Schema initialization failed, using fallback mode');
    }
  } catch (error) {
    logger.warn('JSON Schema initialization error:', error);
  } finally {
    schemaInitialized = true;
  }
}

export async function displayElementInfo(idA, idB, elementType, modelSource = null) {
  const panel = document.getElementById('component-info');
  const contentDiv = document.getElementById('element-info-content');

  if (!elementType || (!idA && !idB)) {
    resetElementInfoState(contentDiv, { renderEmptyMessage: true });
    return;
  }

  if (!panel || !contentDiv) {
    logger.error('Component info panel or content div not found!');
    return;
  }

  await initializeSchema();

  setCurrentEditingElement({ idA, idB, elementType, modelSource });
  currentDisplayNodes = { nodeA: null, nodeB: null, elementType: null };

  // Model A の表示・編集読み取りは active Working Document を優先する。
  // 比較 engine の models.documentA は source snapshot のまま維持する。
  const docA = editDocumentProvider.getActiveEditDocument();
  const docB = getState('models.documentB');
  const hasModelA = !!docA;
  const hasModelB = !!docB;
  if (elementType && !docA && !docB) {
    if (tryFallbackDisplay(elementType, idA, idB, contentDiv)) {
      return;
    }
  }

  applyPanelSize(panel);
  setupPanelResizeObserver(panel);

  if (elementType === null || (idA === null && idB === null)) {
    resetElementInfoState(contentDiv, { renderEmptyMessage: true });
    return;
  }

  let nodeA = null;
  let nodeB = null;
  let title = '';
  let actualElementType = elementType;
  let jointMeshDataA = null;
  let jointMeshDataB = null;

  if (elementType === 'Joint') {
    jointMeshDataA = idA ? findJointMeshData(idA) : null;
    jointMeshDataB = idB ? findJointMeshData(idB) : null;

    const jointIdA = jointMeshDataA?.jointId?.toString() || extractJointIdFromMeshId(idA);
    const jointIdB = jointMeshDataB?.jointId?.toString() || extractJointIdFromMeshId(idB);

    logger.debug(
      `Joint ID extraction: idA=${idA} -> jointIdA=${jointIdA}, idB=${idB} -> jointIdB=${jointIdB}`,
    );

    if (jointIdA && docA) {
      nodeA = findJointXmlNode(docA, jointIdA);
      logger.debug(`Joint XML search in docA for id=${jointIdA}: ${nodeA ? 'found' : 'not found'}`);
    }
    if (jointIdB && docB) {
      nodeB = findJointXmlNode(docB, jointIdB);
      logger.debug(`Joint XML search in docB for id=${jointIdB}: ${nodeB ? 'found' : 'not found'}`);
    }

    if (nodeA) {
      actualElementType = nodeA.tagName.replace('Stb', '');
    } else if (nodeB) {
      actualElementType = nodeB.tagName.replace('Stb', '');
    }
  } else {
    const TAG_NAME_OVERRIDES = { Axis: 'StbParallelAxis', Node: 'StbNode', ShearWall: 'StbWall' };
    const tagName = TAG_NAME_OVERRIDES[elementType] || `Stb${elementType}`;

    if (idA && docA) {
      const resultA = findElementWithFallback(docA, idA, tagName, elementType, 'A');
      nodeA = resultA.node;
      if (nodeA) {
        actualElementType = resultA.foundType;
      }
    } else if (idA && !docA) {
      logger.error(`XML document for model A not found.`);
    }

    if (idB && docB) {
      const resultB = findElementWithFallback(docB, idB, tagName, elementType, 'B');
      nodeB = resultB.node;
      if (nodeB && !nodeA) {
        actualElementType = resultB.foundType;
      }
    } else if (idB && !docB) {
      logger.error(`XML document for model B not found.`);
    }
  }

  if (!nodeA && !nodeB) {
    if (elementType === 'Joint' && (jointMeshDataA || jointMeshDataB)) {
      logger.warn(`Joint XML not found for ID A:${idA} or B:${idB}, showing mesh data only.`);
      const jointMeshData = jointMeshDataA || jointMeshDataB;
      const jd = jointMeshData?.jointData || {};
      const posLabel =
        jointMeshData?.jointPosition === 'start'
          ? '始端'
          : jointMeshData?.jointPosition === 'end'
            ? '終端'
            : '';
      const parentInfoStr = `${escapeHtml(jd.parent_element_type || '')} ID:${escapeHtml(jd.parent_element_id || '')} ${posLabel}`;
      const jointId = jointMeshData?.jointId || extractJointIdFromMeshId(idA || idB);
      const jointBody = `継手 ID:${escapeHtml(jointId)} (${parentInfoStr})`;
      const jointDisplaySide = resolveElementInfoModelSide({
        hasPrimaryA: !!jointMeshDataA,
        hasPrimaryB: !!jointMeshDataB,
        modelSource,
        hasModelA,
        hasModelB,
      });

      title =
        jointMeshDataA && jointMeshDataB
          ? `比較: ${jointBody}`
          : buildSingleModelTitle(jointDisplaySide, jointBody);
      title += ' <span style="color: orange; font-size: var(--font-size-sm);">[XML未検出]</span>';

      showJointMeshDataOnly(panel, title, contentDiv, jointMeshDataA, jointMeshDataB, modelSource);
      return;
    }

    contentDiv.innerHTML = `<p>エラー: ID ${idA ? `A:${idA}` : ''}${
      idA && idB ? ', ' : ''
    }${idB ? `B:${idB}` : ''} の ${elementType} 要素が見つかりません。</p>`;
    logger.error(`Element ${elementType} with ID A:${idA} or B:${idB} not found.`);
    return;
  }

  let schemaInfo = '';
  const actualTagName = nodeA?.tagName || nodeB?.tagName;
  const schemaElementName =
    actualTagName || (actualElementType === 'Node' ? 'StbNode' : `Stb${actualElementType}`);

  if (isSchemaLoaded()) {
    const attrCount = getAllAttributeNames(schemaElementName).length;
    if (attrCount > 0) {
      schemaInfo = ` <span style="color: green; font-size: var(--font-size-sm);">[XSD: ${attrCount}属性]</span>`;
    } else {
      schemaInfo = ` <span style="color: orange; font-size: var(--font-size-sm);">[XSD: ${escapeHtml(schemaElementName)}未定義]</span>`;
      logger.warn(`XSD schema loaded but ${schemaElementName} not found in definitions`);
    }
  } else {
    schemaInfo = ' <span style="color: red; font-size: var(--font-size-sm);">[XSD: 未読込]</span>';
  }

  const typeNote =
    actualElementType !== elementType && elementType !== 'Joint'
      ? ` <span style="color: orange; font-size: var(--font-size-sm);">[実際は${escapeHtml(actualElementType)}]</span>`
      : '';

  let parentInfo = '';
  if (elementType === 'Joint') {
    const jointMeshData = jointMeshDataA || jointMeshDataB;
    if (jointMeshData?.jointData) {
      const jd = jointMeshData.jointData;
      const posLabel =
        jointMeshData.jointPosition === 'start'
          ? '始端'
          : jointMeshData.jointPosition === 'end'
            ? '終端'
            : '';
      parentInfo = ` (${escapeHtml(jd.parent_element_type || '')} ID:${escapeHtml(jd.parent_element_id || '')} ${posLabel})`;
    }
  }

  function generateEvaluationBadge() {
    try {
      const manager = getImportanceManager();
      const configId = manager.getCurrentConfigId();
      const activeXsdVersion = getState('models.activeXsdVersion');

      if (!configId && !activeXsdVersion) {
        return '';
      }

      const shortName =
        {
          'mvd-combined': '統合',
          s2: 'S2',
          s4: 'S4',
        }[configId] || 'デフォルト';

      const xsdLabel = (activeXsdVersion || '2.0.2').replace(/\./g, '');

      return ` <span style="background: rgba(0,120,215,0.15); padding: 2px 6px; border-radius: 3px; font-size: var(--font-size-xs); font-weight: normal; margin-left: 4px;">[評価: ${shortName}, XSD:${escapeHtml(xsdLabel)}]</span>`;
    } catch (error) {
      logger.warn('Failed to generate evaluation badge:', error);
      return '';
    }
  }

  const evaluationBadge = generateEvaluationBadge();
  const displayId = nodeA?.getAttribute('id') || nodeB?.getAttribute('id') || idA || idB;
  const displayModelSide = resolveElementInfoModelSide({
    hasPrimaryA: !!nodeA,
    hasPrimaryB: !!nodeB,
    modelSource,
    hasModelA,
    hasModelB,
  });

  if (nodeA && nodeB) {
    const idADisplay = nodeA.getAttribute('id') || idA;
    const idBDisplay = nodeB.getAttribute('id') || idB;
    title = `比較: ${escapeHtml(actualElementType)}${parentInfo} (A: ${escapeHtml(idADisplay)}, B: ${escapeHtml(idBDisplay)})${typeNote}${schemaInfo}${evaluationBadge}`;
  } else if (nodeA) {
    title = buildSingleModelTitle(
      displayModelSide,
      `${escapeHtml(actualElementType)}${parentInfo} (ID: ${escapeHtml(displayId)})${typeNote}${schemaInfo}${evaluationBadge}`,
    );
  } else {
    title = buildSingleModelTitle(
      displayModelSide,
      `${escapeHtml(actualElementType)}${parentInfo} (ID: ${escapeHtml(displayId)})${typeNote}${schemaInfo}${evaluationBadge}`,
    );
  }

  currentDisplayNodes = { nodeA, nodeB, elementType: actualElementType };

  showInfo(
    nodeA,
    nodeB,
    panel,
    title,
    contentDiv,
    modelSource,
    actualElementType,
    jointMeshDataA,
    jointMeshDataB,
    findSectionTagNameById,
  );
}

export function refreshElementInfoPanel() {
  const currentElement = getCurrentEditingElement();
  if (currentElement) {
    const { idA, idB, elementType, modelSource } = currentElement;
    displayElementInfo(idA, idB, elementType, modelSource);
  }
}

export function displayMultiSelectionSummary(summaryData = {}) {
  const contentDiv = document.getElementById('element-info-content');
  resetElementInfoState(contentDiv, { renderEmptyMessage: false });
  renderMultiSelectionSummary(summaryData);
}

export function exportElementInfoAsJson() {
  _exportElementInfoAsJson(currentDisplayNodes);
}

setDisplayElementInfoFn(displayElementInfo);

eventBus.on(ImportanceEvents.SETTINGS_CHANGED, () => {
  refreshElementInfoPanel();
});

export function initializeExportJsonButton() {
  const exportJsonBtn = document.getElementById('exportElementInfoJsonBtn');
  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', exportElementInfoAsJson);
  }
}
