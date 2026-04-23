import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('pdf') as File;
    if (!file) {
      return NextResponse.json({ error: 'No PDF file provided' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // pdf-parse bundles its own pdf.js with better CIDFont support
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);

    // pdf-parse gives us concatenated text and page count
    // For per-page extraction, we split by page markers or re-extract
    const pages: { pageNum: number; text: string }[] = [];

    // Use pdf-parse's internal pdf.js for per-page extraction
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
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

    // If per-page extraction also failed, try using pdf-parse's full text split by rough page markers
    const hasText = pages.some(p => p.text.trim().length > 10);
    if (!hasText && data.text && data.text.trim().length > 0) {
      // Fallback: put all text on page 1
      pages.length = 0;
      pages.push({ pageNum: 1, text: data.text });
    }

    return NextResponse.json({
      pages,
      totalPages: data.numpages,
      hasText: pages.some(p => p.text.trim().length > 0),
    });
  } catch (error: any) {
    console.error('PDF parse error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to parse PDF' },
      { status: 500 }
    );
  }
}
