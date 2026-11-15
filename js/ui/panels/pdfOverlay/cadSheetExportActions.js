/**
 * One event/exception policy for the four sheet export commands. The existing
 * SVG/DXF/PDF/ZIP producers stay independent and remain responsible for STB
 * revision checks, export contents and download names.
 */
const EXPORT_ACTIONS = Object.freeze([
  ['save-svg', 'saveSheetSvg'],
  ['save-dxf', 'saveSheetDxf'],
  ['save-pdf', 'saveSheetPdf'],
  ['save-all-zip', 'saveAllSheetsZip'],
]);

export function bindCadSheetExportActions({ getButton, runExport, onError }) {
  for (const [suffix, method] of EXPORT_ACTIONS) {
    const button = getButton(suffix);
    if (!button) throw new Error(`シート出力ボタンがありません: ${suffix}`);
    let pending = false;
    button.addEventListener('click', async () => {
      // A second click (including scripted dispatches) cannot start the same
      // download while the first asynchronous export is still in progress.
      if (pending || button.disabled) return;
      pending = true;
      button.disabled = true;
      try {
        await runExport(method);
      } catch (error) {
        onError(error?.message || String(error));
      } finally {
        pending = false;
        button.disabled = false;
      }
    });
  }
}
