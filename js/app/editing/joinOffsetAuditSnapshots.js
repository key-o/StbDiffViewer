/**
 * @fileoverview RC取り合いCommandのUndo用スナップショットから、診断用の変更前offsetを抽出する。
 *
 * null はSTB属性/節点offsetが未設定であることを表し、明示的な "0" と区別する。
 * 記録対象は今回変更するoffsetキーだけ。XML/Commandは変更しない。
 */

function elementName(element) {
  return element?.localName || element?.nodeName?.split(':').pop() || '';
}

export function captureJoinBeforeOffsets(command, targetOffsets) {
  if (command?.type === 'setMemberOffset') {
    return Object.fromEntries(
      Object.keys(targetOffsets || {}).map((attribute) => [
        attribute,
        command.before?.[attribute] ?? null,
      ]),
    );
  }
  const childName =
    command?.type === 'setWallNodeOffsets'
      ? 'StbWallOffset'
      : command?.type === 'setSlabNodeOffsets'
        ? 'StbSlabOffset'
        : null;
  if (!childName) throw new TypeError('未対応の取り合いoffset Commandです。');

  const existing = new Map(
    Array.from(command.before?.children || [])
      .filter((element) => elementName(element) === childName)
      .map((element) => [element.getAttribute('id_node'), element]),
  );
  return Object.fromEntries(
    Object.entries(targetOffsets || {}).map(([nodeId, values]) => {
      const prior = existing.get(nodeId);
      return [
        nodeId,
        Object.fromEntries(
          Object.keys(values || {}).map((attribute) => [
            attribute,
            prior?.getAttribute(attribute) ?? null,
          ]),
        ),
      ];
    }),
  );
}
