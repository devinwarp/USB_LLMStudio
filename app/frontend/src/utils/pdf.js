import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Extracts the text of each page of a PDF file: [{ page, text }], skipping empty pages.
export async function extractPdfPages(file) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("").trim();
    if (text) pages.push({ page: pageNumber, text });
  }
  await pdf.destroy();
  return pages;
}
