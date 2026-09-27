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
- Ajv: https://github.com/ajv-validator/ajv
- web-ifc: https://github.com/ThatOpen/engine_web-ifc
- DOMPurify: https://github.com/cure53/DOMPurify
- PDF.js: https://github.com/mozilla/pdf.js

For a complete dependency inventory, regenerate from the locked dependency
tree before release and attach full license texts where required by the
distribution channel.
