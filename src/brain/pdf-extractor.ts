import { PDFParse } from 'pdf-parse';

/**
 * Extract plaintext from a PDF buffer. Mirrors the pattern used by the
 * ad-scanner PDF parser — instantiate, getText, destroy.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.text || '').trim();
  } finally {
    await parser.destroy();
  }
}
