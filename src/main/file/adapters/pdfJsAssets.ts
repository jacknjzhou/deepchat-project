import { createRequire } from 'node:module'
import path from 'node:path'

export interface PdfJsAssetDirs {
  cMapUrl: string
  standardFontDataUrl: string
  wasmUrl: string
}

let cached: PdfJsAssetDirs | undefined

// PDF.js fetches CMap / standard-font / wasm resources lazily. In packaged
// builds pdfjs-dist lives inside app.asar, whose paths the asar fs layer
// cannot reliably serve (pdf-to-img even joins them with node:path/posix,
// producing mixed separators that break the asar header lookup) — the result
// is "Unable to load CMap data" warnings and garbled text for CJK PDFs.
// electron-builder unpacks those resource dirs next to the asar, so resolve
// against app.asar.unpacked there and against node_modules in development.
// pdf.js validates factory urls with `endsWith('/')` and then concatenates
// `baseUrl + filename` before fs.readFile, so dirs must use forward slashes
// and end with one (fs accepts those on Windows too).
export function resolvePdfJsAssetDirs(): PdfJsAssetDirs {
  cached ??= (() => {
    const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    const baseDir = pdfjsDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    const assetUrl = (...segments: string[]) =>
      `${path.join(baseDir, ...segments).replaceAll('\\', '/')}/`
    return {
      cMapUrl: assetUrl('cmaps'),
      standardFontDataUrl: assetUrl('standard_fonts'),
      wasmUrl: assetUrl('wasm')
    }
  })()
  return cached
}
