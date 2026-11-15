/**
 * STB-only story identity/classification provenance encoded in an IFC storey's
 * Description. IFCBUILDINGSTOREY itself does not define STB kind or story ID.
 * This marker only exists on STB-origin IFC; generic IFC keeps the documented
 * conversion classification policy and is not treated as losslessly sourced.
 */
const PREFIX = 'STBSTORY_META:';
const STORY_KINDS = new Set([
  'GENERAL',
  'BASEMENT',
  'ROOF',
  'PENTHOUSE',
  'ISOLATION',
  'DEPENDENCE',
]);

function positiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const token = String(value).trim();
  if (!/^\+?\d+$/.test(token) || BigInt(token) <= 0n) return null;
  return token;
}

export function encodeStoryMetadata(story) {
  const id = positiveId(story?.id);
  if (id === null || !STORY_KINDS.has(story?.kind)) {
    throw new Error('STB story source requires a positive ID and explicit valid kind');
  }
  // Name and elevation are standard IFC properties and are not overridden.
  return `${PREFIX}${JSON.stringify({ id, kind: story.kind })}`;
}

export function decodeStoryMetadata(description) {
  if (typeof description !== 'string' || !description.startsWith(PREFIX)) return null;
  let source;
  try {
    source = JSON.parse(description.slice(PREFIX.length));
  } catch {
    throw new Error('Invalid STB story provenance JSON');
  }
  const id = positiveId(source?.id);
  if (id === null || !STORY_KINDS.has(source?.kind)) {
    throw new Error('Invalid STB story provenance ID/kind');
  }
  return { id, kind: source.kind };
}
