# Third-Party Notices

This product includes third-party software components. The StbDiffViewer
the application code is governed by the accompanying distribution license;
third-party components remain governed by their own licenses.

## Runtime Components

| Component              | Version | License | Purpose                                |
| ---------------------- | ------- | ------- | -------------------------------------- |
| three                  | 0.160.x | MIT     | 3D rendering                           |
| camera-controls        | 3.1.x   | MIT     | Camera controls                        |
| dxf-parser             | 1.1.2   | MIT     | DXF parsing                            |
| encoding-japanese      | 2.2.0   | MIT     | Japanese character encoding conversion |
| html2canvas            | 1.4.1   | MIT     | DOM capture for reports/PDF output     |
| jspdf                  | 4.2.x   | MIT     | PDF generation                         |
| svg2pdf.js (vendored)  | 2.7.0   | MIT     | Offline vector SVG to PDF rendering    |
| ajv                    | 8.17.x  | MIT     | JSON Schema validation                 |
| ajv-formats            | 3.0.x   | MIT     | JSON Schema format validation          |
| web-ifc / web-ifc.wasm | 0.0.74  | MPL-2.0 | IFC parsing and conversion             |
| PDF.js                  | 5.4.624 | Apache-2.0 | PDF parsing and Canvas rendering      |

## Notable Transitive Runtime Components

| Component      | Version | License               | Used By |
| -------------- | ------- | --------------------- | ------- |
| dompurify      | 3.4.x   | MPL-2.0 OR Apache-2.0 | jspdf   |
| fast-png       | 6.4.x   | MIT                   | jspdf   |
| fflate         | 0.8.x   | MIT                   | jspdf   |
| @babel/runtime | 7.29.x  | MIT                   | jspdf   |
| cssesc         | ^3.0.0  | MIT                   | svg2pdf.js bundled build |
| svgpath        | ^2.3.0  | MIT                   | svg2pdf.js bundled build |
| specificity    | ^0.4.1  | MIT                   | svg2pdf.js bundled build |
| font-family-papandreou | ^0.2.0-patch1 | MIT       | svg2pdf.js bundled build |

## Offline vector-PDF packaging (Issue #493)

- The browser renderer is pinned to the **svg2pdf.js v2.7.0 UMD release**
  at `StbDiffViewer/vendor/svg2pdf-v2.7.0.mjs` (an ESM wrapper around
  the original distribution, with no npm dependency or CDN request).
- The original and bundled-components' MIT permission/copyright statements
  are distributed in `vendor/licenses/*.txt`. The npm manifest remains
  unchanged; the package versions shown with `^` are the upstream
  **release manifest ranges**, not a separately audited npm install tree.
- The bundled renderer imports the existing `jspdf` 4.2.x dependency;
  no independent copy of jsPDF is included.
- Japanese PDF fonts are **not bundled** and are **not downloaded**. The
  user may explicitly select a static TTF whose licensing permits PDF
  embedding (e.g. an appropriately licensed SIL OFL font). TTF contents are
  embedded only into the generated PDF, not stored in the source tree.
  The app cannot verify the font's grant of rights. Windows system-font
  redistribution/embedding permission must not be presumed.
- Before release, verify all `vendor/licenses/*.txt` notices correspond to
  the exact code in the upstream v2.7.0 prebundled artifact, and verify
  Web, Vite/Tauri and MSIX package notice inclusion.

## License Obligations

- MIT licensed components require preservation of copyright and permission
  notices in substantial copies of the software.
- `web-ifc` and `web-ifc.wasm` are licensed under MPL-2.0. If MPL-covered
  files are modified, the corresponding modified source files must be made
  available under the MPL-2.0 terms.
- `dompurify` is available under MPL-2.0 or Apache-2.0. This product uses it
  as an unmodified transitive dependency of `jspdf`.
- PDF.js is licensed under Apache-2.0. The fixed local runtime distribution
  preserves the upstream `LICENSE` file alongside the copied runtime assets.

## References

- three: https://github.com/mrdoob/three.js
- camera-controls: https://github.com/yomotsu/camera-controls
- dxf-parser: https://github.com/gdsestimating/dxf-parser
- encoding-japanese: https://github.com/polygonplanet/encoding.js
- html2canvas: https://github.com/niklasvh/html2canvas
- jsPDF: https://github.com/parallax/jsPDF
- svg2pdf.js: https://github.com/yWorks/svg2pdf.js/tree/v2.7.0
- cssesc: https://github.com/mathiasbynens/cssesc
- svgpath: https://github.com/fontello/svgpath
- specificity: https://github.com/keeganstreet/specificity
- font-family-papandreou: https://github.com/papandreou/font-family
- Ajv: https://github.com/ajv-validator/ajv
- web-ifc: https://github.com/ThatOpen/engine_web-ifc
- DOMPurify: https://github.com/cure53/DOMPurify
- PDF.js: https://github.com/mozilla/pdf.js

For a complete dependency inventory, regenerate from the locked dependency
tree before release and attach full license texts where required by the
distribution channel.
