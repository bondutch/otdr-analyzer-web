/**
 * PDF Text Extraction using pdf.js + Tesseract.js OCR fallback
 * Browser-side PDF parsing - replaces Python pdfplumber
 * Falls back to:
 *   1. Server-side extraction for CIDFont PDFs
 *   2. Tesseract.js OCR for fully image-based PDFs (e.g., scanned Anritsu reports)
 */

import * as pdfjsLib from 'pdfjs-dist';

// Configure worker - dynamically match the installed version
if (typeof window !== 'undefined') {
  const version = pdfjsLib.version;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.worker.min.mjs`;
}

export interface PageText {
  pageNum: number;
  text: string;
}

/**
 * Extract text from all pages of a PDF file
 */
export async function extractTextFromPdf(file: File): Promise<string> {
  const pages = await extractPagesFromPdf(file);
  return pages.map(p => p.text).join('\n');
}

/**
 * Try server-side PDF extraction as fallback
 */
async function extractPagesServerSide(file: File): Promise<PageText[]> {
  try {
    const formData = new FormData();
    formData.append('pdf', file);
    const resp = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (data.pages && data.hasText) return data.pages;
    return [];
  } catch {
    return [];
  }
}

/**
 * OCR fallback using Tesseract.js for image-based PDFs.
 * Renders each page to a canvas at 300 DPI and runs OCR.
 */
async function ocrExtractPages(
  file: File,
  onProgress?: (msg: string) => void
): Promise<PageText[]> {
  // Dynamically import tesseract.js so it doesn't break SSR / build
  let Tesseract: any;
  try {
    Tesseract = await import('tesseract.js');
  } catch {
    return [];
  }

  onProgress?.('Loading OCR engine...');

  // Create a persistent worker for all pages (much faster than per-page workers)
  const worker = await Tesseract.createWorker('eng', undefined, {
    // Use CDN for worker/core/data files
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
  });

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages: PageText[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(`OCR page ${i}/${pdf.numPages}...`);
      const page = await pdf.getPage(i);
      // Render at 300 DPI for good OCR accuracy (typical PDF is 72 DPI)
      const scale = 300 / 72;
      const viewport = page.getViewport({ scale });

      // Use OffscreenCanvas if available, otherwise fall back to DOM canvas
      let canvas: HTMLCanvasElement | OffscreenCanvas;
      let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(viewport.width, viewport.height);
        ctx = canvas.getContext('2d');
      } else {
        canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        ctx = canvas.getContext('2d');
      }

      if (!ctx) {
        pages.push({ pageNum: i, text: '' });
        continue;
      }

      await page.render({ canvasContext: ctx as any, viewport }).promise;

      // Convert canvas to image data for Tesseract
      let imageData: Blob | ImageData;
      if (canvas instanceof OffscreenCanvas) {
        imageData = await canvas.convertToBlob({ type: 'image/png' });
      } else {
        // For regular canvas, use toBlob
        imageData = await new Promise<Blob>((resolve) => {
          (canvas as HTMLCanvasElement).toBlob(
            (blob) => resolve(blob!),
            'image/png'
          );
        });
      }

      // Run OCR
      const { data } = await worker.recognize(imageData);
      pages.push({ pageNum: i, text: data.text || '' });
    }

    return pages;
  } finally {
    await worker.terminate();
  }
}

/**
 * Extract text from each page individually (needed for multi-page format detection)
 * Falls back to server-side extraction, then OCR if browser pdf.js returns empty text
 *
 * @param onProgress - Optional callback for progress messages (shown to user during OCR)
 */
export async function extractPagesFromPdf(
  file: File,
  onProgress?: (msg: string) => void
): Promise<PageText[]> {
  const arrayBuffer = await file.arrayBuffer();
  const version = pdfjsLib.version;
  const pdf = await pdfjsLib.getDocument({
    data: arrayBuffer,
    cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/standard_fonts/`,
  }).promise;
  const pages: PageText[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // Reconstruct text with line breaks based on Y position changes
    let lastY: number | null = null;
    let text = '';

    for (const item of content.items) {
      if ('str' in item) {
        const y = (item as any).transform?.[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          text += '\n';
        } else if (lastY !== null && text.length > 0 && !text.endsWith('\n') && !text.endsWith(' ')) {
          text += ' ';
        }
        text += item.str;
        lastY = y;
      }
    }

    pages.push({ pageNum: i, text });
  }

  // Check if browser extraction got any text
  const hasText = pages.some(p => p.text.trim().length > 10);
  if (!hasText && typeof window !== 'undefined') {
    // Fallback 1: server-side extraction (handles CIDFont)
    onProgress?.('No embedded text — trying server-side extraction...');
    const serverPages = await extractPagesServerSide(file);
    if (serverPages.length > 0 && serverPages.some(p => p.text.trim().length > 10)) {
      return serverPages;
    }

    // Fallback 2: OCR with Tesseract.js (handles image-based / scanned PDFs)
    onProgress?.('Image-based PDF detected — starting OCR...');
    const ocrPages = await ocrExtractPages(file, onProgress);
    if (ocrPages.length > 0 && ocrPages.some(p => p.text.trim().length > 10)) {
      return ocrPages;
    }
  }

  return pages;
}

/**
 * Get the total number of pages in a PDF
 */
export async function getPdfPageCount(file: File): Promise<number> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  return pdf.numPages;
}
