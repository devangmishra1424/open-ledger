import React, { useMemo, useState } from 'react';
import { formatNarrative } from '../../lib/narrative';
import { actionWords } from '../../lib/labels';

function Tokens({ tokens, reasonNames }) {
  return tokens.map((t, i) => {
    if (t.kind === 'text') return <React.Fragment key={i}>{t.text}</React.Fragment>;
    let title;
    if (t.kind === 'code') title = reasonNames[t.text];
    if (t.kind === 'action') title = actionWords(t.text);
    return <span key={i} className={`vb-tok vb-tok-${t.kind}`} title={title}>{t.text}</span>;
  });
}

/**
 * Recorded text, made readable and never shortened: a lead line (the conclusion), then short
 * paragraphs, with codes, amounts and field names marked. Long reasoning shows its first two
 * paragraphs and keeps the rest one click away. See lib/narrative.ts.
 */
export default function Narrative({ text, reasonNames = {}, visibleParagraphs = 2 }) {
  const n = useMemo(() => formatNarrative(text), [text]);
  const [open, setOpen] = useState(false);
  const shown = open ? n.paragraphs : n.paragraphs.slice(0, visibleParagraphs);
  const hidden = n.paragraphs.length - shown.length;

  return (
    <div className="vb-narr">
      {n.label && <div className="vb-narr-label">{n.label}</div>}
      <p className="vb-narr-lead"><Tokens tokens={n.lead} reasonNames={reasonNames} /></p>
      {shown.map((p, i) => <p key={i} className="vb-narr-p"><Tokens tokens={p} reasonNames={reasonNames} /></p>)}
      {n.paragraphs.length > visibleParagraphs && (
        <button type="button" className="vb-link-btn" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show the full reasoning (${hidden} more paragraph${hidden === 1 ? '' : 's'})`}
        </button>
      )}
    </div>
  );
}
