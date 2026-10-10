/**
 * @fileoverview accepted LOCAL_PRISMふかしのST-Bridge StbExtension表現契約。
 *
 * ST-Bridge標準のthickness_add_*は局所station範囲を保持できないため、
 * LOCAL_PRISMはStbExtObject + StbExtPropertyでhost部材へ紐付ける。
 */

export const CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER =
  'StbDiffViewer.ConcreteAccommodation.LocalPrism.1';

export const CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_DESCRIPTION =
  'StbDiffViewer accepted local concrete accommodation prism';

const HOST_TAGS = new Set(['StbBeam', 'StbGirder']);
const FACES = new Set(['TOP', 'BOTTOM', 'RIGHT', 'LEFT']);
const PROPERTY_SCHEMA = Object.freeze([
  ['candidate_id', 'string'],
  ['source_rule_id', 'string'],
  ['source_type', 'string'],
  ['reason', 'string'],
  ['mode', 'string'],
  ['face', 'string'],
  ['support_endpoint', 'string'],
  ['station_origin', 'string'],
  ['station_direction', 'string'],
  ['station_start_mm', 'double'],
  ['station_end_mm', 'double'],
  ['thickness_mm', 'double'],
  ['raw_required_mm', 'double'],
  ['construction_margin_mm', 'double'],
  ['status', 'string'],
]);

export function stbLocalName(element) {
  const localName = element?.localName;
  if (typeof localName === 'string' && localName) return localName;
  return String(element?.tagName || element?.nodeName || '').replace(/^.*:/, '');
}

export function stbElementsByLocalName(document, name) {
  if (!document) return [];
  if (typeof document.getElementsByTagNameNS === 'function') {
    try {
      const matches = Array.from(document.getElementsByTagNameNS('*', name) || []);
      if (matches.length > 0) return matches;
    } catch {
      // Fall through to the local-name scan for DOM implementations without wildcard NS support.
    }
  }
  return Array.from(document.getElementsByTagName?.('*') || []).filter(
    (element) => stbLocalName(element) === name,
  );
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function fail(reason, extra = {}) {
  return { resolved: false, persistable: false, reason, entry: null, ...extra };
}

function accepted(evaluation) {
  if (evaluation?.decisionStatus !== undefined && evaluation?.decisionStatus !== null) {
    return evaluation.decisionStatus === 'ACCEPTED';
  }
  return evaluation?.candidate?.status === 'ACCEPTED';
}

function propertyValueMap({ candidate, evaluation }) {
  const stationStart = finite(candidate.stationStartMm);
  const stationEnd = finite(candidate.stationEndMm);
  const thickness = finite(candidate.proposedThicknessMm);
  const rawRequired = finite(candidate.rawRequiredMm);
  const constructionMargin = finite(candidate.constructionMarginMm);
  return {
    candidate_id: requiredString(candidate.id),
    source_rule_id: requiredString(candidate.sourceRuleId) || '',
    source_type: requiredString(candidate.sourceType) || '',
    reason:
      requiredString(candidate.reason || evaluation?.deficiency?.reason || evaluation?.reason) ||
      '',
    mode: 'LOCAL_PRISM',
    face: requiredString(candidate.face),
    support_endpoint: requiredString(evaluation?.supportEndpoint),
    station_origin: 'SUPPORT_JOINT',
    station_direction: 'INWARD',
    station_start_mm: stationStart,
    station_end_mm: stationEnd,
    thickness_mm: thickness,
    raw_required_mm: rawRequired ?? 0,
    construction_margin_mm: constructionMargin ?? 0,
    status: 'ACCEPTED',
  };
}

/**
 * accepted LOCAL_PRISMをStbExtObject 1件へ変換する。
 */
export function buildStbLocalPrismExtensionEntry({ evaluation, modelSource = null } = {}) {
  if (!evaluation) return fail('local-prism-extension-evaluation-missing');
  if (String(modelSource || '') !== 'A') {
    return fail('local-prism-extension-model-source-unsupported', { modelSource });
  }
  if (!accepted(evaluation)) return fail('local-prism-extension-approval-required');

  const candidate = evaluation.candidate || evaluation.plannedCandidate;
  if (!candidate) return fail('local-prism-extension-candidate-missing');
  if (candidate.mode !== 'LOCAL_PRISM') {
    return fail('local-prism-extension-mode-unsupported', { mode: candidate.mode || null });
  }
  if (!HOST_TAGS.has(candidate.hostMemberTag)) {
    return fail('local-prism-extension-host-tag-unsupported', {
      hostMemberTag: candidate.hostMemberTag || null,
    });
  }
  const hostMemberId = requiredString(candidate.hostMemberId);
  if (!hostMemberId || !/^\d+$/.test(hostMemberId) || Number(hostMemberId) < 1) {
    return fail('local-prism-extension-host-id-invalid', { hostMemberId });
  }
  if (!FACES.has(candidate.face)) {
    return fail('local-prism-extension-face-invalid', { face: candidate.face || null });
  }
  if (!['start', 'end'].includes(evaluation.supportEndpoint)) {
    return fail('local-prism-extension-support-endpoint-invalid', {
      supportEndpoint: evaluation.supportEndpoint || null,
    });
  }

  const values = propertyValueMap({ candidate, evaluation });
  if (!values.candidate_id) return fail('local-prism-extension-candidate-id-missing');
  if (
    values.station_start_mm === null ||
    values.station_end_mm === null ||
    !(values.station_end_mm > values.station_start_mm) ||
    values.thickness_mm === null ||
    !(values.thickness_mm > 0)
  ) {
    return fail('local-prism-extension-geometry-invalid');
  }

  const properties = PROPERTY_SCHEMA.map(([key, type]) => ({
    key,
    type,
    value: String(values[key]),
  }));

  return {
    resolved: true,
    persistable: true,
    reason: null,
    entry: {
      identifier: CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER,
      description: CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_DESCRIPTION,
      objectName: candidate.hostMemberTag,
      idObject: hostMemberId,
      candidateId: values.candidate_id,
      properties,
    },
  };
}

function propertiesOf(extObject) {
  const result = new Map();
  for (const property of Array.from(extObject?.children || [])) {
    if (stbLocalName(property) !== 'StbExtProperty') continue;
    const key = property.getAttribute('key');
    if (!key) continue;
    result.set(key, {
      type: property.getAttribute('type') || null,
      value: property.getAttribute('value') ?? '',
    });
  }
  return result;
}

function extensionContainers(document) {
  return stbElementsByLocalName(document, 'StbExtension').filter(
    (element) =>
      element.getAttribute('identifier') ===
      CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER,
  );
}

/**
 * SDV LOCAL_PRISM extensionをcandidate単位で読み戻す。
 */
export function parseStbLocalPrismExtensionEntries(document) {
  const entries = [];
  for (const extension of extensionContainers(document)) {
    for (const object of Array.from(extension.children || [])) {
      if (stbLocalName(object) !== 'StbExtObject') continue;
      const props = propertiesOf(object);
      const candidateId = props.get('candidate_id')?.value || '';
      if (!candidateId) continue;
      entries.push({
        identifier: extension.getAttribute('identifier'),
        description: extension.getAttribute('description') || null,
        objectName: object.getAttribute('object_name') || null,
        idObject: object.getAttribute('id_object') || null,
        candidateId,
        properties: props,
      });
    }
  }
  return entries;
}

export function findStbLocalPrismExtensionEntry(document, candidateId) {
  const wanted = requiredString(candidateId);
  if (!wanted) return null;
  return (
    parseStbLocalPrismExtensionEntries(document).find((entry) => entry.candidateId === wanted) ||
    null
  );
}

export function createStbLocalPrismExtObjectElement(document, entry) {
  if (!document || !entry) return null;
  const namespace = document.documentElement?.namespaceURI || null;
  const create = (tagName) =>
    namespace ? document.createElementNS(namespace, tagName) : document.createElement(tagName);
  const object = create('StbExtObject');
  object.setAttribute('object_name', entry.objectName);
  object.setAttribute('id_object', entry.idObject);
  for (const property of entry.properties || []) {
    const element = create('StbExtProperty');
    element.setAttribute('key', property.key);
    element.setAttribute('type', property.type);
    element.setAttribute('value', property.value);
    object.appendChild(element);
  }
  return object;
}

export const CONCRETE_ACCOMMODATION_LOCAL_PRISM_PROPERTY_SCHEMA = PROPERTY_SCHEMA;
