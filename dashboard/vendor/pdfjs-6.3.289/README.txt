Vendored for Orchy's file viewer (dashboard/js/viewer.mjs; no CDN at runtime).
pdfjs-dist 6.3.289 (released 2026-08-29; package.json devDependencies pins it): build/pdf.min.mjs, build/pdf.worker.min.mjs,
standard_fonts/, cmaps/, iccs/, wasm/{openjpeg,jbig2,qcms_bg}.wasm with their licences. Scripting (quickjs) is left out: the
viewer opens PDFs with scripting off. To update: npm i -D pdfjs-dist@<version> --save-exact, copy the same files into
dashboard/vendor/pdfjs-<version>/, change PDFJS in viewers/pdf.mjs, delete the old folder.
