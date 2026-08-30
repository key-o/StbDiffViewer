/**
 * 要素/属性の XPath 情報を生成する。
 *
 * @param {Element} element
 * @param {string|null|undefined} attributeName
 * @param {{ useNameAnchor?: boolean }} [options]
 * @returns {{ xpath?: string, idXPath?: string, anchorElementType?: string, anchorElementId?: string }}
 */
export function buildIssueLocation(element, attributeName, options = {}) {
  if (!element || element.nodeType !== 1) return {};

  const segments = [];
  let current = element;
  while (current && current.nodeType === 1) {
    const name = current.localName || current.nodeName.replace(/^.*:/, '');
    const id = current.getAttribute ? current.getAttribute('id') : null;
    segments.unshift({ name, id: id || '' });
    current = current.parentNode;
  }

  if (segments.length === 0) return {};

  const fullElementXPath = `/${segments.map(buildXPathSegment).join('/')}`;
  const xpath = attributeName ? `${fullElementXPath}/@${attributeName}` : fullElementXPath;

  let idXPath = xpath;
  let anchorElementType;
  let anchorElementId;

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!segments[i].id) continue;

    const head = `//${buildXPathSegment(segments[i])}`;
    const tail = segments
      .slice(i + 1)
      .map(buildXPathSegment)
      .join('/');
    const base = tail ? `${head}/${tail}` : head;
    idXPath = attributeName ? `${base}/@${attributeName}` : base;
    anchorElementType = segments[i].name;
    anchorElementId = segments[i].id;
    break;
  }

  if (!anchorElementId && options.useNameAnchor && element.getAttribute) {
    const nameValue = element.getAttribute('name');
    const lastSegment = segments.at(-1);
    if (nameValue && lastSegment) {
      anchorElementId = nameValue;
      anchorElementType = lastSegment.name;
      const base = `//${lastSegment.name}[@name=${toXPathLiteral(nameValue)}]`;
      idXPath = attributeName ? `${base}/@${attributeName}` : base;
    }
  }

  return { xpath, idXPath, anchorElementType, anchorElementId };
}

function buildXPathSegment(segment) {
  if (!segment.id) return segment.name;
  return `${segment.name}[@id=${toXPathLiteral(segment.id)}]`;
}

export function toXPathLiteral(value) {
  const stringValue = String(value);
  if (!stringValue.includes("'")) return `'${stringValue}'`;
  if (!stringValue.includes('"')) return `"${stringValue}"`;

  const parts = stringValue.split("'").map((part) => `'${part}'`);
  return `concat(${parts.join(`, "'", `)})`;
}
