/**
 * XML Helper Utilities for STB Version Converter
 */

// Root element names (both forms are valid in STB)
export const ROOT_ELEMENT_NAMES = ['ST-Bridge', 'ST_BRIDGE'];

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function createDomParser() {
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser();
  }

  const { DOMParser: XmldomParser } = await import('@xmldom/xmldom');
  return new XmldomParser({
    errorHandler: {
      warning: () => {},
      error: (message) => {
        throw new Error(message);
      },
      fatalError: (message) => {
        throw new Error(message);
      },
    },
  });
}

function parseElement(element) {
  const result = {};

  if (element.attributes?.length) {
    result.$ = {};
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes.item(i);
      result.$[attr.name] = attr.value;
    }
  }

  for (let i = 0; i < (element.childNodes?.length || 0); i++) {
    const child = element.childNodes.item(i);
    if (child.nodeType === 1) {
      const childName = child.nodeName;
      result[childName] ??= [];
      result[childName].push(parseElement(child));
      continue;
    }

    if (child.nodeType === 3 || child.nodeType === 4) {
      const text = child.nodeValue?.trim();
      if (text) {
        result._ = result._ ? `${result._}${text}` : text;
      }
    }
  }

  return result;
}

function buildElement(name, value, depth = 0) {
  const indent = '  '.repeat(depth);

  if (value === null || value === undefined) {
    return `${indent}<${name}/>`;
  }

  if (typeof value !== 'object') {
    return `${indent}<${name}>${escapeXmlText(value)}</${name}>`;
  }

  const attrs = value.$ || {};
  const attrText = Object.entries(attrs)
    .map(([key, attrValue]) => ` ${key}="${escapeXmlAttribute(attrValue)}"`)
    .join('');

  const childEntries = Object.entries(value).filter(([key]) => key !== '$' && key !== '_');
  const text = value._ !== undefined ? escapeXmlText(value._) : '';

  if (!text && childEntries.length === 0) {
    return `${indent}<${name}${attrText}/>`;
  }

  if (childEntries.length === 0) {
    return `${indent}<${name}${attrText}>${text}</${name}>`;
  }

  const children = [];
  for (const [childName, childValue] of childEntries) {
    const childItems = Array.isArray(childValue) ? childValue : [childValue];
    for (const item of childItems) {
      children.push(buildElement(childName, item, depth + 1));
    }
  }

  const content = text ? `${text}\n${children.join('\n')}` : children.join('\n');
  return `${indent}<${name}${attrText}>\n${content}\n${indent}</${name}>`;
}

/**
 * Get the root element from STB object
 * @param {object} stbRoot - Parsed STB XML object
 * @returns {object|null} Root element info { name, element } or null
 */
export function getRootElement(stbRoot) {
  for (const name of ROOT_ELEMENT_NAMES) {
    if (stbRoot[name]) {
      return { name, element: stbRoot[name] };
    }
  }
  return null;
}

/**
 * Get the ST-Bridge root array (handles both ST-Bridge and ST_BRIDGE)
 * @param {object} stbRoot - Parsed STB XML object
 * @returns {Array|null} Root element array or null
 */
export function getStbRoot(stbRoot) {
  const root = getRootElement(stbRoot);
  return root?.element ?? null;
}

/**
 * Get the StbModel container from a parsed STB object
 * @param {object} stbRoot - Parsed STB XML object
 * @returns {object|null} StbModel element or null
 */
function getStbModel(stbRoot) {
  const root = getStbRoot(stbRoot);
  if (!root) return null;
  const rootData = Array.isArray(root) ? root[0] : root;
  return rootData?.['StbModel']?.[0] ?? null;
}

/**
 * Get the StbSections container from a parsed STB object
 * @param {object} stbRoot - Parsed STB XML object
 * @returns {object|null} StbSections element or null
 */
export function getStbSections(stbRoot) {
  return getStbModel(stbRoot)?.['StbSections']?.[0] ?? null;
}

/**
 * Parse XML string to JavaScript object.
 * The returned shape intentionally matches the subset of xml2js used by the
 * converter: element names map to arrays, attributes live under "$", and text
 * content lives under "_".
 * @param {string} xmlString - XML content
 * @returns {Promise<object>} Parsed object
 */
export async function parseXml(xmlString) {
  const parser = await createDomParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parseError = doc.getElementsByTagName?.('parsererror')?.[0];
  if (parseError) {
    throw new Error(parseError.textContent || 'Invalid XML');
  }

  const root = doc.documentElement;
  if (!root) {
    throw new Error('Missing XML document element');
  }

  return { [root.nodeName]: [parseElement(root)] };
}

/**
 * Build XML string from JavaScript object
 * @param {object} obj - JavaScript object
 * @returns {string} XML string
 */
export function buildXml(obj) {
  const roots = Object.entries(obj || {});
  const body = roots
    .flatMap(([name, value]) => {
      const items = Array.isArray(value) ? value : [value];
      return items.map((item) => buildElement(name, item));
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/**
 * Deep clone an object
 * @param {object} obj - Object to clone
 * @returns {object} Cloned object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Rename a key in an object
 * @param {object} obj - Target object
 * @param {string} oldKey - Old key name
 * @param {string} newKey - New key name
 */
export function renameKey(obj, oldKey, newKey) {
  if (obj && obj[oldKey] !== undefined) {
    obj[newKey] = obj[oldKey];
    delete obj[oldKey];
  }
}

/**
 * Navigate through XML structure using an array-based path
 * @param {object|Array} root - Root element (can be array or object)
 * @param {Array<string>} pathArray - Path segments (e.g., ['StbModel', 'StbMembers', 'StbColumns', 'StbColumn'])
 * @returns {Array|null} Array of elements at the path, or null if not found
 * @example
 * // Navigate to all StbColumn elements
 * const columns = navigateXmlPath(root, ['StbModel', 'StbMembers', 'StbColumns', 'StbColumn']);
 */
export function navigateXmlPath(root, pathArray) {
  if (!pathArray || pathArray.length === 0) return null;

  let current = Array.isArray(root) ? root[0] : root;

  // Navigate through all segments except the last one
  for (let i = 0; i < pathArray.length - 1; i++) {
    const segment = pathArray[i];
    if (!current || !current[segment]) return null;

    // XML elements are stored as arrays in xml2js
    current = current[segment][0];
    if (!current) return null;
  }

  // Get the final segment
  const lastSegment = pathArray[pathArray.length - 1];
  const result = current?.[lastSegment];

  // Return as array for consistency
  if (!result) return null;
  return Array.isArray(result) ? result : [result];
}
