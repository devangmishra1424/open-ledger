import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../services/api';
import { Banner, Spinner } from '../ui';
import { DocumentPreview, ReadingFacts } from '../DocumentIntake';

/**
 * The file an invoice was entered from: how it was read (digital or OCR, its confidence, what was done to the page),
 * how sure the reading was, and the original itself, so anyone can compare what was booked with what was sent.
 */
export default function SourceDocument({ documentId }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    api.getDocument(documentId).then((d) => alive && setDoc(d)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [documentId]);

  const open = async () => {
    setOpening(true);
    try {
      const { blob } = await api.getDocumentFile(documentId);
      const url = URL.createObjectURL(new Blob([blob], { type: doc.mediaType }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e.message);
    } finally {
      setOpening(false);
    }
  };

  if (error) return <Banner kind="error">Could not load the source document: {error}</Banner>;
  if (!doc) return <div style={{ padding: 16 }}><Spinner label="Loading the source document…" /></div>;

  const x = doc.extraction;
  const reading = { ...doc.reading, filename: doc.filename, mediaType: doc.mediaType };
  const conf = x?.submission?.confidence;
  return (
    <div className="vb-source-doc">
      <div className="vb-source-head">
        <ReadingFacts reading={reading} />
        <button type="button" className="vb-btn vb-btn-sm" onClick={open} disabled={opening}><ExternalLink size={14} aria-hidden="true" /> Open the original</button>
      </div>
      {x && (
        <p className="vb-muted" style={{ margin: 0, fontSize: 13 }}>
          Read {x.method === 'llm' ? 'by the layout rules with the AI filling gaps' : 'by the layout rules (no AI)'}
          {conf != null ? `, ${Math.round(conf * 100)}% sure before a person checked it` : ''}. What the person saved, and anything they corrected, is in the trail below.
        </p>
      )}
      <details>
        <summary className="vb-tech" style={{ cursor: 'pointer' }}>Show the document here</summary>
        <div style={{ marginTop: 10 }}>
          <DocumentPreview result={{ documentId, reading: { ...reading, text: doc.reading.text } }} />
        </div>
      </details>
    </div>
  );
}
