import React, { useCallback, useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, Plus, X } from "lucide-react";
import { DOC_CHAT, addDocument, deleteDocument, listDocuments } from "../services/docs";
import { extractPdfPages } from "../utils/pdf";
import "../styles/docs.css";

const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

async function readDocumentPages(file) {
  if (isPdf(file)) return await extractPdfPages(file);
  return [{ page: null, text: await file.text() }];
}

// Documents indexed on this drive for chat. Shown above the composer while Docs is on.
export default function DocLibrary({ onDocumentsChange, showAlert, disabled }) {
  const [documents, setDocuments] = useState([]);
  const [adding, setAdding] = useState("");
  const fileInputRef = useRef(null);

  const update = useCallback((next) => {
    setDocuments(next);
    onDocumentsChange?.(next);
  }, [onDocumentsChange]);

  useEffect(() => {
    listDocuments().then(update).catch((err) => {
      showAlert?.({ title: "Couldn't load your documents", message: err.message || String(err), danger: true });
    });
  }, [update, showAlert]);

  const handleFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    let next = documents;
    for (const file of files) {
      setAdding(file.name);
      try {
        const doc = await addDocument(file.name, await readDocumentPages(file));
        next = [...next, doc];
        update(next);
      } catch (err) {
        showAlert?.({ title: `Couldn't add ${file.name}`, message: err.message || String(err), danger: true });
      }
    }
    setAdding("");
  };

  const handleRemove = async (doc) => {
    try {
      await deleteDocument(doc.id);
      update(documents.filter((item) => item.id !== doc.id));
    } catch (err) {
      showAlert?.({ title: `Couldn't remove ${doc.name}`, message: err.message || String(err), danger: true });
    }
  };

  return (
    <div className="chat-attachments doc-library" aria-label="Documents for chat">
      {documents.length === 0 && !adding && (
        <span className="doc-library-hint">Add PDFs or text files. They are indexed on this drive and answers cite them.</span>
      )}
      {documents.map((doc) => (
        <div key={doc.id} className="chat-attachment" title={`${doc.name} (${doc.chunks} passages)`}>
          <FileText size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          <span className="chat-attachment-name">{doc.name}</span>
          <button type="button" className="chat-attachment-remove" onClick={() => handleRemove(doc)} aria-label={`Remove ${doc.name}`}>
            <X size={14} />
          </button>
        </div>
      ))}
      <input type="file" ref={fileInputRef} style={{ display: "none" }} multiple accept={DOC_CHAT.acceptedFileTypes} onChange={handleFiles} />
      <button
        type="button"
        className="chat-composer-chip"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || Boolean(adding)}
        title="Add documents to chat with"
      >
        {adding ? <LoaderCircle size={15} className="progress-spinner" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
        <span>{adding ? `Indexing ${adding}…` : "Add documents"}</span>
      </button>
    </div>
  );
}
