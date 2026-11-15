/**
 * Validate ST-Bridge 2.1 StbStory required attributes before XML serialization.
 * Missing IFC elevation or classification is not silently converted to 0 or
 * "GENERAL" merely to produce schema-valid XML.
 */
const STORY_KINDS = new Set([
  'GENERAL',
  'BASEMENT',
  'ROOF',
  'PENTHOUSE',
  'ISOLATION',
  'DEPENDENCE',
]);
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateStbStoryRecords(stories) {
  if (!Array.isArray(stories)) throw new TypeError('STB stories must be an array');
  const ids = new Set();
  for (const [index, story] of stories.entries()) {
    if (!story || typeof story !== 'object' || Array.isArray(story)) {
      throw new TypeError(`STB story at index ${index} is invalid`);
    }
    const id = story.id;
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      (typeof id === 'number' && !Number.isSafeInteger(id)) ||
      !/^\+?\d+$/.test(String(id).trim()) ||
      BigInt(String(id).trim()) <= 0n
    ) {
      throw new Error(`Invalid positive STB story id at index ${index}`);
    }
    const canonical = BigInt(String(id).trim()).toString();
    if (ids.has(canonical)) throw new Error(`Duplicate STB story id: ${id}`);
    ids.add(canonical);

    if (typeof story.name !== 'string') throw new Error(`STB story ${id}: missing name`);
    if (typeof story.height !== 'number' && typeof story.height !== 'string') {
      throw new Error(`STB story ${id}: invalid measured height`);
    }
    if (!DECIMAL.test(String(story.height).trim()) || !Number.isFinite(Number(story.height))) {
      throw new Error(`STB story ${id}: invalid measured height`);
    }
    if (!STORY_KINDS.has(story.kind)) {
      throw new Error(`STB story ${id}: missing or unsupported kind`);
    }
  }
}
