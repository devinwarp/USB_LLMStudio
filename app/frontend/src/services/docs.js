// Document chat (local RAG) client. Routes and limits are shared with
// scripts/server/doc-chat.cjs through config/doc-chat.json.
import DOC_CHAT from "../config/doc-chat.json" with { type: "json" };

export { DOC_CHAT };

async function readJson(res, fallbackMessage) {
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error(fallbackMessage);
  }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || fallbackMessage);
  return data;
}

const postJson = (url, body) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function listDocuments() {
  const data = await readJson(await fetch(DOC_CHAT.routes.list), "The local server returned an invalid document list.");
  return data.documents || [];
}

// pages: [{ page, text }]; page is null for plain text files
export async function addDocument(name, pages) {
  const data = await readJson(await postJson(DOC_CHAT.routes.add, { name, pages }), "The local server could not index this document.");
  return data.document;
}

export async function deleteDocument(id) {
  return await readJson(await postJson(DOC_CHAT.routes.delete, { id }), "The local server could not remove this document.");
}

export async function searchDocuments(query, { topK = DOC_CHAT.limits.defaultTopK, docIds } = {}) {
  const data = await readJson(await postJson(DOC_CHAT.routes.search, { query, topK, docIds }), "The local server could not search your documents.");
  return data.results || [];
}

export const formatDocumentCitation = (hit) => (hit.page ? `${hit.name}, page ${hit.page}` : hit.name);

// System prompt block with numbered excerpts the model must cite as [n].
export function buildDocumentContext(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return "";
  const excerpts = hits.map((hit) => `[${hit.index}] ${formatDocumentCitation(hit)}\n${hit.text}`).join("\n\n");
  return [
    "Answer using the document excerpts below. Cite the excerpts you use with their number in square brackets, like [1].",
    "If the excerpts do not contain the answer, say so instead of guessing.",
    "",
    "Document excerpts:",
    excerpts,
  ].join("\n");
}
