"use client";

import { useEffect, useMemo, useState } from "react";

import { createNoteType, deleteNoteType, listNoteTypeDetails, updateNoteType } from "@/lib/db/client";
import type { NoteTypeDetails, NoteTypeField, NoteTypeInput, NoteTypeTemplate } from "@/lib/db/types";
import { renderAnkiCard } from "@/lib/anki/template";

type Props = {
  onCollectionChanged: () => void | Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function draftFor(noteType: NoteTypeDetails): NoteTypeInput {
  return {
    id: noteType.id,
    name: noteType.name,
    fields: noteType.fields.map((field) => ({ ...field })),
    templates: noteType.templates.map((template) => ({ ...template })),
    css: noteType.css
  };
}

function previewDocument(content: string, css: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    html,body{margin:0;min-height:100%;background:#fff;color:#182230}body{box-sizing:border-box;padding:22px;font:18px/1.45 Arial,sans-serif;overflow-wrap:anywhere}.card{min-height:180px;display:grid;place-items:center;text-align:center}img,video{max-width:100%;height:auto}${css.replace(/<\/style/gi, "<\\/style")}
  </style></head><body><main class="card">${content}</main></body></html>`;
}

function emptyField(): NoteTypeField {
  return { name: "New field", sourceOrdinal: null, rtl: false, font: "Arial", size: 20 };
}

function templateFor(fields: NoteTypeField[], number: number): NoteTypeTemplate {
  const field = fields[0]?.name || "Front";
  return { name: `Card ${number}`, sourceOrdinal: null, qfmt: `{{${field}}}`, afmt: `{{FrontSide}}<hr id=answer>{{${field}}}`, deckId: null };
}

export function NoteTypeManager({ onCollectionChanged }: Props) {
  const [noteTypes, setNoteTypes] = useState<NoteTypeDetails[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<NoteTypeInput | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState(0);
  const [samples, setSamples] = useState<string[]>([]);
  const [showAnswer, setShowAnswer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = (noteType: NoteTypeDetails) => {
    setSelectedId(noteType.id);
    setDraft(draftFor(noteType));
    setSelectedTemplate(0);
    setSamples(noteType.fields.map((field, index) => noteType.kind === "cloze" && index === 0
      ? `{{c1::Example ${field.name}}}` : `Example ${field.name}`));
    setShowAnswer(false);
    setMessage(null);
    setError(null);
  };

  const reload = async (pickId = selectedId) => {
    const available = await listNoteTypeDetails();
    setNoteTypes(available);
    const next = available.find((noteType) => noteType.id === pickId) ?? available[0] ?? null;
    if (next) select(next);
    else { setSelectedId(null); setDraft(null); }
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    void listNoteTypeDetails().then((available) => {
      if (cancelled) return;
      setNoteTypes(available);
      if (available[0]) select(available[0]);
      setLoading(false);
    }, (reason) => {
      if (cancelled) return;
      setError(errorMessage(reason));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const selected = noteTypes.find((noteType) => noteType.id === selectedId) ?? null;
  const kind = selected?.kind ?? "standard";
  const currentTemplate = draft?.templates[selectedTemplate] ?? null;
  const preview = useMemo(() => {
    if (!draft || !currentTemplate) return null;
    try {
      const values = draft.fields.map((_field, index) => samples[index] || "");
      const rendered = renderAnkiCard({ id: draft.id, name: draft.name, type: kind === "cloze" ? 1 : 0,
        flds: draft.fields.map((field, index) => ({ name: field.name, ord: index })),
        tmpls: draft.templates.map((template, index) => ({ name: template.name, ord: index, qfmt: template.qfmt, afmt: template.afmt })),
        css: draft.css }, values, selectedTemplate);
      return showAnswer ? rendered.answerHtml : rendered.questionHtml;
    } catch (reason) {
      return `<p>Preview error: ${errorMessage(reason).replaceAll("<", "&lt;")}</p>`;
    }
  }, [currentTemplate, draft, kind, samples, selectedTemplate, showAnswer]);

  const changeField = (index: number, patch: Partial<NoteTypeField>) => {
    setDraft((current) => current ? { ...current, fields: current.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field) } : current);
  };
  const moveField = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      if (!current || index + direction < 0 || index + direction >= current.fields.length) return current;
      const fields = [...current.fields];
      [fields[index], fields[index + direction]] = [fields[index + direction], fields[index]];
      return { ...current, fields };
    });
  };
  const changeTemplate = (index: number, patch: Partial<NoteTypeTemplate>) => {
    setDraft((current) => current ? { ...current, templates: current.templates.map((template, templateIndex) => templateIndex === index ? { ...template, ...patch } : template) } : current);
  };
  const moveTemplate = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      if (!current || index + direction < 0 || index + direction >= current.templates.length) return current;
      const templates = [...current.templates];
      [templates[index], templates[index + direction]] = [templates[index + direction], templates[index]];
      return { ...current, templates };
    });
    setSelectedTemplate((current) => current === index ? index + direction : current === index + direction ? index : current);
  };

  const create = async (newKind: "standard" | "cloze", clone = false) => {
    const defaultName = clone && selected ? `${selected.name} copy` : newKind === "cloze" ? "New Cloze" : "New Note Type";
    const name = window.prompt("Name the note type:", defaultName);
    if (name === null) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      const created = await createNoteType(name, newKind, clone && selected?.kind === newKind ? selected.id : null);
      await reload(created.id);
      await onCollectionChanged();
      setMessage("Note type created. Edit its fields and templates, then save.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setSaving(false); }
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      const saved = await updateNoteType(draft);
      await reload(saved.id);
      await onCollectionChanged();
      setMessage("Note type saved. Existing notes and cards were updated safely.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!selected || !selected.canDelete || saving) return;
    const noun = `${selected.noteCount} note${selected.noteCount === 1 ? "" : "s"} and ${selected.cardCount} card${selected.cardCount === 1 ? "" : "s"}`;
    if (!window.confirm(`Delete “${selected.name}” and its ${noun}? This cannot be undone.`)) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      await deleteNoteType(selected.id);
      await reload(null);
      await onCollectionChanged();
      setMessage("Note type and its notes were deleted.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setSaving(false); }
  };

  if (loading) return <div className="panel" role="status">Loading note types…</div>;
  if (!draft || !selected) return <div className="panel error-panel" role="alert">{error ?? "No note types are available."}</div>;

  return (
    <section className="note-type-manager">
      <aside className="panel note-type-list" aria-label="Note types">
        <div className="form-heading"><strong>Note types</strong><span>{noteTypes.length}</span></div>
        <div className="note-type-create-actions">
          <button className="secondary-button" type="button" disabled={saving} onClick={() => void create("standard")}>New standard</button>
          <button className="secondary-button" type="button" disabled={saving} onClick={() => void create("cloze")}>New cloze</button>
        </div>
        <div className="note-type-list-items">{noteTypes.map((noteType) => <button key={noteType.id} type="button"
          className={noteType.id === selected.id ? "selected" : ""} onClick={() => select(noteType)} disabled={saving}>
          <strong>{noteType.name}</strong><small>{noteType.kind === "cloze" ? "Cloze" : noteType.kind === "image-occlusion" ? "Image Occlusion" : "Standard"} · {noteType.noteCount} notes</small>
        </button>)}</div>
      </aside>

      <div className="note-type-editor">
        <section className="panel note-type-intro">
          <div><p className="eyebrow">NOTE TYPE EDITOR</p><h2>{selected.name}</h2><p>Changes update existing notes and preserve matching card scheduling when templates are reordered.</p></div>
          <div className="note-type-intro-actions">
            {kind !== "image-occlusion" && <button className="secondary-button" type="button" disabled={saving} onClick={() => void create(kind, true)}>Clone</button>}
            {selected.canDelete && <button className="danger-button" type="button" disabled={saving} onClick={() => void remove()}>Delete</button>}
          </div>
        </section>

        {kind === "image-occlusion" ? <section className="panel note-type-readonly"><strong>Image Occlusion is managed by its dedicated editor.</strong><span>Its fields and template structure are protected so masks remain compatible with Anki.</span></section> : <>
          <section className="panel note-type-section">
            <div className="form-heading"><strong>General</strong><span>{kind === "cloze" ? "Cloze note type" : "Standard note type"}</span></div>
            <label htmlFor="note-type-name">Name<input id="note-type-name" value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          </section>

          <section className="panel note-type-section">
            <div className="form-heading"><strong>Fields</strong><span>Reorder safely; removed fields are removed from all notes.</span></div>
            <div className="note-type-fields">{draft.fields.map((field, index) => <div className="note-type-field-row" key={`${field.sourceOrdinal ?? "new"}-${index}`}>
              <div className="note-type-reorder"><button type="button" disabled={saving || index === 0} onClick={() => moveField(index, -1)} aria-label={`Move ${field.name} up`}>↑</button><button type="button" disabled={saving || index === draft.fields.length - 1} onClick={() => moveField(index, 1)} aria-label={`Move ${field.name} down`}>↓</button></div>
              <label><span>Name</span><input value={field.name} disabled={saving} onChange={(event) => changeField(index, { name: event.target.value })} /></label>
              <label><span>Font</span><input value={field.font} disabled={saving} onChange={(event) => changeField(index, { font: event.target.value })} /></label>
              <label><span>Size</span><input type="number" min="8" max="96" value={field.size} disabled={saving} onChange={(event) => changeField(index, { size: Number(event.target.value) })} /></label>
              <label className="note-type-checkbox"><input type="checkbox" checked={field.rtl} disabled={saving} onChange={(event) => changeField(index, { rtl: event.target.checked })} />RTL</label>
              <button className="note-type-remove" type="button" disabled={saving || draft.fields.length === 1} onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, fieldIndex) => fieldIndex !== index) })}>Remove</button>
            </div>)}</div>
            <button className="secondary-button" type="button" disabled={saving || draft.fields.length >= 100} onClick={() => setDraft({ ...draft, fields: [...draft.fields, emptyField()] })}>Add field</button>
          </section>

          <section className="panel note-type-section">
            <div className="form-heading"><strong>Card templates</strong><span>{kind === "cloze" ? "Cloze notes generate cards from their deletions." : "Cards are generated when a front template has content."}</span></div>
            <div className="note-type-template-tabs">{draft.templates.map((template, index) => <div key={`${template.sourceOrdinal ?? "new"}-${index}`} className={index === selectedTemplate ? "active" : ""}>
              <button type="button" onClick={() => { setSelectedTemplate(index); setShowAnswer(false); }} disabled={saving}>{template.name || `Card ${index + 1}`}</button>
              {kind === "standard" && <span><button type="button" disabled={saving || index === 0} onClick={() => moveTemplate(index, -1)} aria-label="Move template left">←</button><button type="button" disabled={saving || index === draft.templates.length - 1} onClick={() => moveTemplate(index, 1)} aria-label="Move template right">→</button></span>}
            </div>)}</div>
            {currentTemplate && <div className="template-editor-grid">
              <label htmlFor="template-name">Template name<input id="template-name" value={currentTemplate.name} disabled={saving} onChange={(event) => changeTemplate(selectedTemplate, { name: event.target.value })} /></label>
              <div className="template-field-insert"><span>Insert field</span>{draft.fields.map((field) => <button key={field.name} type="button" disabled={saving} onClick={() => changeTemplate(selectedTemplate, { qfmt: `${currentTemplate.qfmt}{{${field.name}}}` })}>{field.name}</button>)}</div>
              <label htmlFor="template-front">Front template<textarea id="template-front" rows={8} value={currentTemplate.qfmt} disabled={saving} onChange={(event) => changeTemplate(selectedTemplate, { qfmt: event.target.value })} /></label>
              <label htmlFor="template-back">Back template<textarea id="template-back" rows={8} value={currentTemplate.afmt} disabled={saving} onChange={(event) => changeTemplate(selectedTemplate, { afmt: event.target.value })} /></label>
            </div>}
            {kind === "standard" && <div className="note-type-template-actions"><button className="secondary-button" type="button" disabled={saving || draft.templates.length >= 100} onClick={() => { setDraft({ ...draft, templates: [...draft.templates, templateFor(draft.fields, draft.templates.length + 1)] }); setSelectedTemplate(draft.templates.length); }}>Add card template</button><button className="secondary-button" type="button" disabled={saving || draft.templates.length === 1} onClick={() => { setDraft({ ...draft, templates: draft.templates.filter((_, index) => index !== selectedTemplate) }); setSelectedTemplate((index) => Math.max(0, index - 1)); }}>Remove selected template</button></div>}
          </section>

          <section className="panel note-type-section"><div className="form-heading"><strong>Styling</strong><span>Applied to every card generated by this note type.</span></div><label htmlFor="note-type-css">CSS<textarea id="note-type-css" rows={8} value={draft.css} disabled={saving} spellCheck={false} onChange={(event) => setDraft({ ...draft, css: event.target.value })} /></label></section>

          <section className="panel note-type-section note-type-preview"><div className="form-heading"><strong>Preview</strong><span>Uses sample field content and runs in a sandbox.</span></div><div className="note-type-samples">{draft.fields.map((field, index) => <label key={`${field.sourceOrdinal ?? "new"}-${index}`}>{field.name}<input value={samples[index] ?? ""} onChange={(event) => setSamples((current) => current.map((value, sampleIndex) => sampleIndex === index ? event.target.value : value))} /></label>)}</div><div className="note-type-preview-actions"><button className={showAnswer ? "secondary-button" : "primary-button"} type="button" onClick={() => setShowAnswer(false)}>Question</button><button className={showAnswer ? "primary-button" : "secondary-button"} type="button" onClick={() => setShowAnswer(true)}>Answer</button></div>{preview && <iframe title="Card preview" className="note-type-preview-frame" sandbox="" srcDoc={previewDocument(preview, draft.css)} />}</section>

          {error && <p className="panel form-error" role="alert">{error}</p>}
          {message && <p className="panel form-success" role="status">{message}</p>}
          <div className="note-type-save-actions"><button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save note type"}</button></div>
        </>}
      </div>
    </section>
  );
}
