"use client";

import { useEffect, useState } from "react";

import type { StudyCard } from "@/lib/db/types";
import { nextClozeNumber } from "@/lib/note-editing";
import { NoteFieldEditor } from "./NoteFieldEditor";

export type ReviewDialog = null | "edit" | "more" | "due" | "info";
export type ReviewDismissAction = "bury-card" | "bury-note" | "suspend-card" | "suspend-note" | "reset" | "delete";

const flagNames = ["No flag", "Red", "Orange", "Green", "Blue", "Pink", "Turquoise", "Purple"];
const flagColors = ["#94a3b8", "#ef4444", "#f97316", "#22c55e", "#3b82f6", "#ec4899", "#14b8a6", "#8b5cf6"];

type Props = {
  card: StudyCard;
  busy: boolean;
  dialog: ReviewDialog;
  undoAvailable: boolean;
  onDialogChange: (dialog: ReviewDialog) => void;
  onEdit: (fields: string[], tags: string[]) => Promise<boolean>;
  onFlag: (flag: number) => Promise<boolean>;
  onMark: (marked: boolean) => Promise<boolean>;
  onDismiss: (action: ReviewDismissAction) => Promise<boolean>;
  onSetDue: (days: number) => Promise<boolean>;
  onUndo: () => Promise<void>;
  onReplay: () => void;
};

export function ReviewActions({ card, busy, dialog, undoAvailable, onDialogChange, onEdit, onFlag, onMark,
  onDismiss, onSetDue, onUndo, onReplay }: Props) {
  const [fields, setFields] = useState(card.fields);
  const [tags, setTags] = useState(card.tags.join(" "));
  const [dueDays, setDueDays] = useState("1");
  const marked = card.tags.some((tag) => tag.toLocaleLowerCase() === "marked");

  useEffect(() => {
    setFields(card.fields);
    setTags(card.tags.join(" "));
    setDueDays("1");
  }, [card.id, card.fields, card.tags]);

  const close = () => onDialogChange(null);
  const dismiss = async (action: ReviewDismissAction) => {
    if (action === "delete" && !window.confirm("Delete this note and all of its cards? This cannot be undone.")) return;
    if (action === "reset" && !window.confirm("Reset this card to new? Its review history will remain in the collection.")) return;
    if (await onDismiss(action)) close();
  };

  return (
    <>
      <div className="review-toolbar" role="toolbar" aria-label="Review actions">
        <button type="button" disabled={busy || !undoAvailable} onClick={() => void onUndo()} title="Undo last review (Z)">
          <span aria-hidden="true">↶</span> Undo
        </button>
        <button type="button" disabled={busy} onClick={onReplay} title="Replay card audio (R)">
          <span aria-hidden="true">↻</span> Replay
        </button>
        <button type="button" disabled={busy} onClick={() => onDialogChange("edit")} aria-keyshortcuts="E" title="Edit note (E)">
          <span aria-hidden="true">✎</span> Edit
        </button>
        <button type="button" disabled={busy} onClick={() => onDialogChange("more")} aria-expanded={dialog === "more"} title="More actions">
          <span aria-hidden="true">•••</span> More
        </button>
      </div>

      {dialog && (
        <div className="review-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section className={`review-dialog review-dialog--${dialog}`} role="dialog" aria-modal="true"
            aria-labelledby={`review-${dialog}-title`}>
            <header>
              <div><p className="eyebrow">REVIEW</p><h2 id={`review-${dialog}-title`}>{dialog === "edit" ? "Edit note" : dialog === "due" ? "Set due date" : dialog === "info" ? "Card info" : "More actions"}</h2></div>
              <button className="review-dialog-close" type="button" onClick={close} disabled={busy} aria-label="Close"
                autoFocus={dialog === "more" || dialog === "info"}>×</button>
            </header>

            {dialog === "edit" && (
              <form className="review-edit-form" onSubmit={async (event) => {
                event.preventDefault();
                if (await onEdit(fields, tags.split(/[\s,]+/).filter(Boolean))) close();
              }}>
                <p className="muted">{card.notetypeName} · {card.templateName}</p>
                {card.fieldNames.map((name, index) => (
                  <NoteFieldEditor key={`${card.noteId}-${index}`} id={`review-field-${index}`} label={name}
                    value={fields[index] ?? ""} disabled={busy} autoFocus={index === 0}
                    clozeNumber={card.cloze ? nextClozeNumber(fields) : undefined}
                    onChange={(html) => setFields((current) => current.map((value, fieldIndex) => fieldIndex === index ? html : value))} />
                ))}
                <label htmlFor="review-tags">Tags</label>
                <input id="review-tags" value={tags} disabled={busy} onChange={(event) => setTags(event.target.value)} placeholder="Separate tags with spaces" />
                <div className="review-dialog-actions">
                  <button className="secondary-button" type="button" onClick={close} disabled={busy}>Cancel</button>
                  <button className="primary-button" type="submit" disabled={busy || !fields[0]?.trim()}>{busy ? "Saving…" : "Save note"}</button>
                </div>
              </form>
            )}

            {dialog === "more" && (
              <div className="review-more-actions">
                <section>
                  <h3>Flag</h3>
                  <div className="review-flags" role="group" aria-label="Card flag">
                    {flagNames.map((name, flag) => <button key={name} type="button" disabled={busy} aria-label={name}
                      aria-pressed={card.flag === flag} title={`${name}${flag ? ` (Ctrl/⌘+${flag})` : " (Ctrl/⌘+0)"}`}
                      onClick={async () => { if (await onFlag(flag)) close(); }}>
                      <span style={{ background: flagColors[flag] }} aria-hidden="true" />{name}
                    </button>)}
                  </div>
                </section>
                <section className="review-action-grid">
                  <button type="button" disabled={busy} onClick={async () => { if (await onMark(!marked)) close(); }}>
                    <strong>{marked ? "Unmark note" : "Mark note"}</strong><small>M</small>
                  </button>
                  <button type="button" disabled={busy} onClick={() => void dismiss("bury-card")}><strong>Bury card</strong><small>-</small></button>
                  <button type="button" disabled={busy} onClick={() => void dismiss("bury-note")}><strong>Bury note</strong><small>=</small></button>
                  <button type="button" disabled={busy} onClick={() => void dismiss("suspend-card")}><strong>Suspend card</strong><small>@</small></button>
                  <button type="button" disabled={busy} onClick={() => void dismiss("suspend-note")}><strong>Suspend note</strong><small>!</small></button>
                  <button type="button" disabled={busy} onClick={() => onDialogChange("due")}><strong>Set due date</strong><small>D</small></button>
                  <button type="button" disabled={busy} onClick={() => void dismiss("reset")}><strong>Reset card</strong><small>New</small></button>
                  <button type="button" disabled={busy} onClick={() => onDialogChange("info")}><strong>Card info</strong><small>I</small></button>
                  <button className="review-danger-action" type="button" disabled={busy} onClick={() => void dismiss("delete")}><strong>Delete note</strong><small>All cards</small></button>
                </section>
              </div>
            )}

            {dialog === "due" && (
              <form className="review-due-form" onSubmit={async (event) => {
                event.preventDefault();
                const days = Number(dueDays);
                if (Number.isInteger(days) && days >= 0 && days <= 36_500 && await onSetDue(days)) close();
              }}>
                <p>Schedule this card relative to today. Use <strong>0</strong> for today, <strong>1</strong> for tomorrow, and so on.</p>
                <label htmlFor="review-due-days">Days from today</label>
                <input id="review-due-days" type="number" min="0" max="36500" step="1" autoFocus required value={dueDays}
                  onChange={(event) => setDueDays(event.target.value)} disabled={busy} />
                <div className="review-dialog-actions"><button className="secondary-button" type="button" onClick={() => onDialogChange("more")} disabled={busy}>Back</button>
                  <button className="primary-button" type="submit" disabled={busy}>Set due date</button></div>
              </form>
            )}

            {dialog === "info" && (
              <div className="review-card-info">
                <dl>
                  <div><dt>Deck</dt><dd>{card.deckName}</dd></div>
                  <div><dt>Note type</dt><dd>{card.notetypeName}</dd></div>
                  <div><dt>Card type</dt><dd>{card.templateName}</dd></div>
                  <div><dt>State</dt><dd>{card.state}</dd></div>
                  <div><dt>Due</dt><dd>{card.dueLabel}</dd></div>
                  <div><dt>Interval</dt><dd>{card.intervalDays} days</dd></div>
                  <div><dt>Reviews</dt><dd>{card.reviews}</dd></div>
                  <div><dt>Lapses</dt><dd>{card.lapses}</dd></div>
                  <div><dt>Card ID</dt><dd>{card.id}</dd></div>
                  <div><dt>Note ID</dt><dd>{card.noteId}</dd></div>
                  <div className="review-info-wide"><dt>Tags</dt><dd>{card.tags.join(" ") || "None"}</dd></div>
                </dl>
                <div className="review-dialog-actions"><button className="primary-button" type="button" onClick={close}>Done</button></div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
