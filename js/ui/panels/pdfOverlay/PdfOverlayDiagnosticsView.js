/** @fileoverview STB抽出とPDF位置合わせの診断を安全なテキストとして表示する。 */

function make(tag, text = '') {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

export function renderPdfOverlayDiagnostics(container, drawing, registrationResult) {
  container.replaceChildren();
  const details = make('details');
  const diagnostics = drawing?.diagnostics || [];
  details.append(make('summary', `抽出・位置合わせ診断 (${diagnostics.length})`));
  details.append(make('p', `位置合わせ: ${registrationResult || '未設定'}`));
  if (diagnostics.length) {
    const list = make('ul');
    const records = new Map((drawing?.elements || []).map((item) => [item.key, item]));
    for (const item of diagnostics.slice(0, 100)) {
      const record = records.get(item.elementKey);
      const label = record
        ? `${record.ref.elementType} #${record.ref.elementId}${record.mark ? ` (${record.mark})` : ''}`
        : item.elementKey || '図面';
      list.append(make('li', `${label}: ${item.code}${item.detail ? ` / ${item.detail}` : ''}`));
    }
    if (diagnostics.length > 100) list.append(make('li', `ほか ${diagnostics.length - 100} 件`));
    details.append(list);
  } else {
    details.append(make('p', '抽出診断はありません。'));
  }
  container.append(details);
}
