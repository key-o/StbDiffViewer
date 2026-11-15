/**
 * #485 P0 read-only Document Control API. This is an application service, not an MCP server.
 * No gateway, window global, filesystem access, network transport, or write command is exposed.
 */
import { createDocumentRegistry, DocumentControlError } from './documentRegistry.js';
import { drawingProjectReadBridge } from './drawingProjectBridge.js';
import { SelectionEvents } from '../../constants/eventTypes.js';

const ELEMENT_TAGS = Object.freeze({
  node: 'StbNode',
  column: 'StbColumn',
  post: 'StbPost',
  girder: 'StbGirder',
  beam: 'StbBeam',
  brace: 'StbBrace',
  slab: 'StbSlab',
  wall: 'StbWall',
  pile: 'StbPile',
  footing: 'StbFooting',
  story: 'StbStory',
  section_column_rc: 'StbSecColumn_RC',
  section_column_s: 'StbSecColumn_S',
  section_column_src: 'StbSecColumn_SRC',
  section_column_cft: 'StbSecColumn_CFT',
  section_beam_rc: 'StbSecBeam_RC',
  section_beam_s: 'StbSecBeam_S',
  section_beam_src: 'StbSecBeam_SRC',
  section_brace_s: 'StbSecBrace_S',
  section_slab_rc: 'StbSecSlab_RC',
  section_wall_rc: 'StbSecWall_RC',
});
const ATTRIBUTE_WHITELIST = new Set([
  'id',
  'guid',
  'name',
  'id_section',
  'kind_structure',
  'kind',
  'id_node_start',
  'id_node_end',
  'id_node_bottom',
  'id_node_top',
  'rotate',
]);
const MAX_RESULTS = 100;

function validateKeys(input, allowed, required = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DocumentControlError('INVALID_ARGUMENT', 'Arguments must be an object.');
  }
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    required.some((key) => typeof input[key] !== 'string' || !input[key])
  ) {
    throw new DocumentControlError('INVALID_ARGUMENT', 'Invalid or missing request fields.');
  }
}

function summarizeElement(element) {
  const attributes = {};
  for (const key of ATTRIBUTE_WHITELIST) {
    if (element.hasAttribute(key)) attributes[key] = element.getAttribute(key);
  }
  return Object.freeze({ type: element.tagName, attributes });
}

function getOpenModels(getState) {
  const editing = getState('models.editing');
  const documents = [];
  for (const slot of ['A', 'B']) {
    const source = getState(`models.document${slot}`);
    if (source?.nodeType !== 9) continue;
    const name = getState(`files.originalFile${slot}`)?.name;
    documents.push({
      slot,
      kind: 'stb-source',
      source,
      name,
      // Private guard also covers an incomplete editing start/teardown.
      editSessionId: slot === 'A' && editing?.active ? editing.sessionId : null,
      workingRevision: slot === 'A' && editing?.active ? editing.workingRevision : null,
      workingSource: slot === 'A' && editing?.active ? editing.workingDocument : null,
    });
    if (
      slot === 'A' &&
      editing?.active === true &&
      typeof editing.sessionId === 'string' &&
      editing.sessionId &&
      Number.isSafeInteger(editing.workingRevision) &&
      editing.workingRevision >= 0 &&
      editing.workingDocument?.nodeType === 9 &&
      editing.workingDocument.documentElement?.nodeType === 1
    ) {
      documents.push({
        slot: 'A',
        kind: 'stb-working',
        source: editing.workingDocument,
        name,
        editSessionId: editing.sessionId,
        workingRevision: editing.workingRevision,
      });
    }
  }
  return documents;
}

/**
 * @param {{getState:Function, eventBus?:Object, randomId?:Function}} options
 * @returns {Object} UI-owned, read-only service. approveFromUser must never be dispatched by MCP.
 */
export function createDocumentControlApi({
  getState,
  eventBus,
  randomId,
  drawingProvider = drawingProjectReadBridge,
} = {}) {
  if (typeof getState !== 'function') {
    throw new DocumentControlError('INVALID_ARGUMENT', 'A state provider is required.');
  }
  const registry = createDocumentRegistry({ randomId });
  let selection = [];
  let drawingGrant = null;
  let observedDrawing = null;
  let activeConsent = false;
  const makeId =
    randomId ??
    (() => {
      if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new DocumentControlError(
          'SECURE_RANDOM_UNAVAILABLE',
          'Secure identifiers unavailable.',
        );
      }
      return globalThis.crypto.randomUUID();
    });
  const sameDrawing = (left, right) =>
    (!left && !right) ||
    (left &&
      right &&
      left.projectId === right.projectId &&
      left.drawingDocumentId === right.drawingDocumentId &&
      left.modelSlotId === right.modelSlotId &&
      left.sourceRevisionId === right.sourceRevisionId &&
      left.drawingRevisionId === right.drawingRevisionId);
  function verifyDrawing() {
    const current = drawingProvider.getOpenDrawingProjectDescriptor();
    if (!sameDrawing(observedDrawing, current)) {
      registry.disable('drawing_or_revision_changed');
      activeConsent = false;
      drawingGrant = null;
      observedDrawing = null;
      throw new DocumentControlError(
        'DOCUMENT_CHANGED',
        'Open drawing changed; reapproval required.',
      );
    }
  }
  function localSnapshot() {
    const snapshot = registry.snapshot();
    return drawingGrant
      ? { ...snapshot, documents: [...snapshot.documents, { ...drawingGrant }] }
      : snapshot;
  }

  const subscriptions = [];
  const stopDrawing = drawingProvider.subscribe(() => {
    // A new open, replacement, edit or close revokes existing consent synchronously.
    if (activeConsent) {
      activeConsent = false;
      drawingGrant = null;
      observedDrawing = null;
      registry.disable('drawing_lifecycle_changed');
    }
  });
  if (eventBus) {
    subscriptions.push(
      eventBus.on(SelectionEvents.ELEMENT_SELECTED, (item = {}) => {
        selection = [item];
      }),
      eventBus.on(SelectionEvents.MULTI_SELECT, ({ selectedElements = [] } = {}) => {
        selection = Array.isArray(selectedElements) ? selectedElements.slice(0, MAX_RESULTS) : [];
      }),
      eventBus.on(SelectionEvents.SELECTION_CLEARED, () => {
        selection = [];
      }),
    );
  }

  function checkSession(input, allowed = [], required = []) {
    validateKeys(input, ['sessionId', ...allowed], ['sessionId', ...required]);
    registry.assertSession(input.sessionId);
    registry.verifyOpen(getOpenModels(getState));
    verifyDrawing();
  }

  function checkDocument(input, fields = [], required = []) {
    checkSession(
      input,
      ['documentId', 'revisionId', ...fields],
      ['documentId', 'revisionId', ...required],
    );
    return registry.authorize(input);
  }

  function resolveElements(entry, elementType) {
    const tagName = ELEMENT_TAGS[elementType];
    if (!tagName)
      throw new DocumentControlError('INVALID_ELEMENT_TYPE', 'Unsupported element type.');
    return entry.source.getElementsByTagName(tagName);
  }

  const handlers = {
    get_drawing_state(input) {
      checkSession(input, ['documentId', 'revisionId'], ['documentId', 'revisionId']);
      if (!drawingGrant || !observedDrawing || input.documentId !== drawingGrant.documentId) {
        throw new DocumentControlError('DOCUMENT_NOT_AUTHORIZED', 'Drawing is not authorized.');
      }
      if (input.revisionId !== drawingGrant.revisionId) {
        throw new DocumentControlError('REVISION_MISMATCH', 'Drawing revision is not authorized.');
      }
      // Whitelist only; never include DrawingProject JSON or memo text.
      return {
        ...observedDrawing.state,
        projectId: observedDrawing.projectId,
        drawingDocumentId: observedDrawing.drawingDocumentId,
        modelSlotId: observedDrawing.modelSlotId,
        sourceRevisionId: observedDrawing.sourceRevisionId,
        drawingRevisionId: observedDrawing.drawingRevisionId,
      };
    },
    get_session_info(input) {
      checkSession(input);
      return localSnapshot();
    },
    list_open_documents(input) {
      checkSession(input);
      return localSnapshot().documents;
    },
    get_selection(input) {
      const entry = checkDocument(input);
      // Viewer selection is a Source-only semantic. No implicit Working translation.
      if (entry.kind !== 'stb-source') {
        throw new DocumentControlError('UNSUPPORTED_DOCUMENT_KIND', 'Selection is Source-only.');
      }
      // Never forward arbitrary userData or DOM/Three.js objects from viewer selection events.
      return selection.flatMap((item) => {
        const elementType = typeof item.elementType === 'string' ? item.elementType : null;
        if (!elementType) return [];
        let elementId =
          entry.slot === 'A'
            ? (item.elementIdA ??
              (['A', 'onlyA'].includes(item.modelSource) ? item.elementId : null))
            : (item.elementIdB ??
              (['B', 'onlyB'].includes(item.modelSource) ? item.elementId : null));
        const source = item.modelSource;
        if (
          (entry.slot === 'A' && ['B', 'onlyB'].includes(source)) ||
          (entry.slot === 'B' && ['A', 'onlyA'].includes(source))
        )
          return [];
        if (elementId == null) return [];
        elementId = String(elementId);
        return [{ elementType: elementType.slice(0, 64), elementId: elementId.slice(0, 128) }];
      });
    },
    find_elements(input) {
      const entry = checkDocument(input, ['elementType', 'name', 'limit'], ['elementType']);
      if (input.name !== undefined && typeof input.name !== 'string') {
        throw new DocumentControlError('INVALID_ARGUMENT', 'Name must be a string.');
      }
      if (
        input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_RESULTS)
      ) {
        throw new DocumentControlError('INVALID_ARGUMENT', 'Limit must be between 1 and 100.');
      }
      const items = resolveElements(entry, input.elementType);
      const results = [];
      const limit = input.limit ?? 50;
      for (const item of items) {
        if (input.name && !item.getAttribute('name')?.includes(input.name)) continue;
        // Report truncation only when an additional matching element actually exists.
        if (results.length >= limit) return { items: results, limited: true };
        results.push(summarizeElement(item));
      }
      return { items: results, limited: false };
    },
    get_element_details(input) {
      const entry = checkDocument(
        input,
        ['elementType', 'elementId'],
        ['elementType', 'elementId'],
      );
      const items = resolveElements(entry, input.elementType);
      for (const item of items) {
        if (item.getAttribute('id') === input.elementId) return summarizeElement(item);
      }
      throw new DocumentControlError('ELEMENT_NOT_FOUND', 'Element not found in open document.');
    },
    compare_open_models(input) {
      checkSession(
        input,
        ['documentA', 'revisionA', 'documentB', 'revisionB'],
        ['documentA', 'revisionA', 'documentB', 'revisionB'],
      );
      const entryA = registry.authorize({
        sessionId: input.sessionId,
        documentId: input.documentA,
        revisionId: input.revisionA,
      });
      const entryB = registry.authorize({
        sessionId: input.sessionId,
        documentId: input.documentB,
        revisionId: input.revisionB,
      });
      if (
        entryA.slot !== 'A' ||
        entryB.slot !== 'B' ||
        entryA.kind !== 'stb-source' ||
        entryB.kind !== 'stb-source'
      ) {
        throw new DocumentControlError(
          'INVALID_ARGUMENT',
          'Comparison requires open slots A and B.',
        );
      }
      const comparisons = getState('comparisonResults');
      if (!(comparisons instanceof Map)) {
        throw new DocumentControlError(
          'COMPARISON_UNAVAILABLE',
          'No current comparison is available.',
        );
      }
      return Array.from(comparisons.entries())
        .slice(0, 50)
        .map(([type, value]) => ({
          type: String(type).slice(0, 64),
          matched: value?.matched?.length ?? 0,
          onlyA: value?.onlyA?.length ?? 0,
          onlyB: value?.onlyB?.length ?? 0,
        }));
    },
  };

  return Object.freeze({
    // Local application UI only. Never expose these two methods via a transport adapter.
    approveFromUser: ({ includeWorking = false } = {}) => {
      selection = [];
      // Failure after registry.approve() must never leave a usable STB grant.
      try {
        const accepted = registry.approve(getOpenModels(getState), { includeWorking });
        const nextDrawing = drawingProvider.getOpenDrawingProjectDescriptor();
        const nextDrawingGrant = nextDrawing
          ? {
              slot: null,
              kind: 'drawing-project',
              documentId: makeId(),
              revisionId: makeId(),
              projectId: nextDrawing.projectId,
              drawingDocumentId: nextDrawing.drawingDocumentId,
              modelSlotId: nextDrawing.modelSlotId,
              sourceRevisionId: nextDrawing.sourceRevisionId,
              drawingRevisionId: nextDrawing.drawingRevisionId,
            }
          : null;
        observedDrawing = nextDrawing;
        drawingGrant = nextDrawingGrant;
        activeConsent = true;
        return { ...accepted, documents: localSnapshot().documents };
      } catch (error) {
        activeConsent = false;
        observedDrawing = null;
        drawingGrant = null;
        registry.disable('approval_failed');
        throw error;
      }
    },
    disconnect: () => {
      selection = [];
      drawingGrant = null;
      observedDrawing = null;
      activeConsent = false;
      registry.disable();
    },
    subscribeLocalEvents: registry.subscribe,
    // Local UI lifecycle only: proactively revoke stale grants on state changes.
    // This method is intentionally absent from the external read-tool allowlist.
    syncWithOpenDocuments() {
      try {
        registry.verifyOpen(getOpenModels(getState));
        verifyDrawing();
        return localSnapshot();
      } catch (error) {
        if (
          error instanceof DocumentControlError &&
          ['NOT_CONNECTED', 'DOCUMENT_CHANGED'].includes(error.code)
        ) {
          return null;
        }
        throw error;
      }
    },
    handleReadRequest(tool, input) {
      if (!Object.hasOwn(handlers, tool)) {
        throw new DocumentControlError('UNKNOWN_TOOL', 'Tool not in the read-only allowlist.');
      }
      return handlers[tool](input);
    },
    dispose() {
      registry.disable('disposed');
      drawingGrant = null;
      observedDrawing = null;
      activeConsent = false;
      stopDrawing();
      selection = [];
      for (const off of subscriptions) off();
    },
  });
}
