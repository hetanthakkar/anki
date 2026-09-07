"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addNote,
  answerCard,
  createDeck,
  deleteDeck,
  getNextCard,
  initLocalCollection,
  listDecks,
  listNotetypes,
  renameDeck,
  storeMedia
} from "@/lib/db/client";
import type { DeckSummary, LocalCollectionInfo, NoteTypeSummary, ReviewRating, StudyCard } from "@/lib/db/types";
import { CollectionBackup } from "./CollectionBackup";
import { DeckOptionsEditor } from "./DeckOptionsEditor";
import { ImportDeck } from "./ImportDeck";
import { NoteFieldEditor } from "./NoteFieldEditor";
import { nextClozeNumber } from "@/lib/note-editing";
import { emptyImageOcclusionDraft, ImageOcclusionEditor } from "./ImageOcclusionEditor";
import type { ImageOcclusionDraft } from "./ImageOcclusionEditor";
import { StatsDashboard } from "./StatsDashboard";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; info: LocalCollectionInfo; decks: DeckSummary[]; notetypes: NoteTypeSummary[] }
  | { status: "error"; message: string };

type Screen = "decks" | "stats" | "settings" | "deck" | "deck-options" | "create-deck" | "manage-deck" | "add-note" | "review" | "import";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cardDocument(content: string, cardCss: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      :root{color-scheme:light}html,body{margin:0;width:100%;min-height:100%;background:#fff}
      body.card{box-sizing:border-box;min-height:100vh;padding:28px 22px!important;display:flex!important;align-items:center!important;justify-content:center!important;
      font-family:Arial,sans-serif;font-size:21px;line-height:1.45;text-align:center!important;color:#17191c!important;background:#fff!important;overflow-wrap:anywhere}
      .anki-card-content{width:100%;max-width:100%;color:#17191c!important;text-align:center!important}
      hr#answer{width:100%;margin:28px 0;border:0;border-top:1px solid #d8dce3}img,video{max-width:100%;height:auto}
      .anki-audio{width:min(100%,360px);margin:14px auto}.hint{color:#1f6fd1;text-decoration:underline;cursor:help}
      .type-answer-marker{display:inline-block;margin-top:16px;color:#667085;font-size:14px}.type-answer-correct{font-weight:700}
      ${cardCss.replace(/<\/style/gi, "<\\/style")}
      body.card{color:#17191c!important;background:#fff!important;text-align:center!important}
      .anki-card-content{color:#17191c!important;text-align:center!important}
      .anki-card-content .cloze{color:#2badd5!important}
    </style></head><body class="card"><div class="anki-card-content">${content}</div></body></html>`;
}

function occlusionNumber(value: number) {
  if (!Number.isFinite(value) || value === 0) return ".0000";
  return value.toFixed(4).replace(/^0+|0+$/g, "");
}

function imageOcclusionFields(notetype: NoteTypeSummary, draft: ImageOcclusionDraft, filename: string) {
  const indexes = notetype.imageOcclusionFields;
  if (!indexes) throw new Error("This Image Occlusion note type is missing its field mapping");
  const fields = notetype.fields.map(() => "");
  fields[indexes.occlusions] = draft.masks.map((mask, index) => {
    const inactive = draft.hideAllGuessOne ? ":oi=1" : "";
    return `{{c${index + 1}::image-occlusion:rect:left=${occlusionNumber(mask.left)}:top=${occlusionNumber(mask.top)}:width=${occlusionNumber(mask.width)}:height=${occlusionNumber(mask.height)}${inactive}}}<br>`;
  }).join("");
  fields[indexes.image] = `<img src="${encodeURIComponent(filename)}">`;
  fields[indexes.header] = draft.header.trim();
  fields[indexes.backExtra] = draft.backExtra.trim();
  if (indexes.comments !== undefined && indexes.comments < fields.length) fields[indexes.comments] = draft.comments.trim();
  return fields;
}

function leafDeckName(name: string) {
  return name.split("::").at(-1) ?? name;
}

export function LocalCollectionStatus() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [screen, setScreen] = useState<Screen>("decks");
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [deckName, setDeckName] = useState("");
  const [subdeckName, setSubdeckName] = useState("");
  const [noteTypeId, setNoteTypeId] = useState<number | null>(null);
  const [noteFields, setNoteFields] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [imageOcclusion, setImageOcclusion] = useState<ImageOcclusionDraft>(emptyImageOcclusionDraft);
  const [studyCard, setStudyCard] = useState<StudyCard | null>(null);
  const [studyComplete, setStudyComplete] = useState(false);
  const [sessionReviews, setSessionReviews] = useState(0);
  const [answerShown, setAnswerShown] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const shownAt = useRef(Date.now());

  const refreshDecks = useCallback(async () => {
    const decks = await listDecks();
    setState((current) => current.status === "ready" ? { ...current, decks } : current);
    return decks;
  }, []);

  const refreshCollection = useCallback(async () => {
    const [decks, notetypes] = await Promise.all([listDecks(), listNotetypes()]);
    setState((current) => current.status === "ready" ? { ...current, decks, notetypes } : current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const info = await initLocalCollection();
        const [decks, notetypes] = await Promise.all([listDecks(), listNotetypes()]);
        if (!cancelled) {
          setState({ status: "ready", info, decks, notetypes });
          const initial = notetypes.find((notetype) => notetype.name === "Basic") ?? notetypes[0];
          if (initial) {
            setNoteTypeId(initial.id);
            setNoteFields(initial.fields.map(() => ""));
          }
        }
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: errorMessage(error) });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const selectedDeck = useMemo(
    () => state.status === "ready" ? state.decks.find((deck) => deck.id === selectedDeckId) ?? null : null,
    [selectedDeckId, state]
  );
  const selectedNotetype = useMemo(
    () => state.status === "ready" ? state.notetypes.find((notetype) => notetype.id === noteTypeId) ?? null : null,
    [noteTypeId, state]
  );

  const goToDecks = () => {
    setScreen("decks");
    setSelectedDeckId(null);
    setActionError(null);
  };

  const goToDeck = (deckId: number) => {
    setSelectedDeckId(deckId);
    setScreen("deck");
    setActionError(null);
  };

  const openDeckManagement = () => {
    if (!selectedDeck) return;
    setDeckName(leafDeckName(selectedDeck.name));
    setSubdeckName("");
    setActionError(null);
    setScreen("manage-deck");
  };

  const saveDeck = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const deck = await createDeck(deckName);
      await refreshDecks();
      setDeckName("");
      goToDeck(deck.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const saveDeckRename = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedDeck) return;
    const leaf = deckName.trim();
    if (leaf.includes("::")) {
      setActionError("Rename one deck level at a time; use subdecks for hierarchy.");
      return;
    }
    const parent = selectedDeck.name.split("::").slice(0, -1).join("::");
    const fullName = parent ? `${parent}::${leaf}` : leaf;
    setBusy(true);
    setActionError(null);
    try {
      await renameDeck(selectedDeck.id, fullName);
      await refreshDecks();
      setScreen("deck");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const saveSubdeck = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedDeck) return;
    const child = subdeckName.trim();
    if (!child) return;
    if (child.includes("::")) {
      setActionError("Create one subdeck level at a time.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const deck = await createDeck(`${selectedDeck.name}::${child}`);
      await refreshDecks();
      setSubdeckName("");
      goToDeck(deck.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const removeSelectedDeck = async () => {
    if (state.status !== "ready" || !selectedDeck || selectedDeck.id === 1 || busy) return;
    const hasChildren = state.decks.some((deck) => deck.id !== selectedDeck.id && deck.name.toLocaleLowerCase().startsWith(`${selectedDeck.name.toLocaleLowerCase()}::`));
    const scope = hasChildren ? "this deck, its subdecks, and their cards" : "this deck and its cards";
    if (!window.confirm(`Delete ${scope}? Notes that have no cards left will also be deleted. This cannot be undone.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteDeck(selectedDeck.id);
      await refreshDecks();
      goToDecks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedDeckId || !selectedNotetype) return;
    setBusy(true);
    setActionError(null);
    try {
      if (selectedNotetype.kind === "image-occlusion") {
        if (!imageOcclusion.image) throw new Error("Choose an image to occlude");
        if (!imageOcclusion.image.size || imageOcclusion.image.size > 64 * 1024 * 1024) {
          throw new Error("Choose a non-empty image no larger than 64 MiB");
        }
        if (!imageOcclusion.image.type.startsWith("image/")
          && !/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(imageOcclusion.image.name)) {
          throw new Error("Choose a supported image file");
        }
        if (!imageOcclusion.masks.length) throw new Error("Draw at least one mask on the image");
        const filename = await storeMedia(imageOcclusion.image.name, await imageOcclusion.image.arrayBuffer());
        await addNote(selectedDeckId, selectedNotetype.id, imageOcclusionFields(selectedNotetype, imageOcclusion, filename));
        await refreshDecks();
        setImageOcclusion(emptyImageOcclusionDraft);
        setScreen("deck");
        return;
      }
      const mediaMarkup: string[] = [];
      for (const file of attachments) {
        const filename = await storeMedia(file.name, await file.arrayBuffer());
        if (file.type.startsWith("image/")) mediaMarkup.push(`<img src="${filename}">`);
        else if (file.type.startsWith("video/")) mediaMarkup.push(`<video controls src="${filename}"></video>`);
        else mediaMarkup.push(`[sound:${filename}]`);
      }
      const fields = [...noteFields];
      const mediaField = Math.min(1, Math.max(0, fields.length - 1));
      fields[mediaField] = [fields[mediaField], ...mediaMarkup].filter(Boolean).join("<br>");
      await addNote(selectedDeckId, selectedNotetype.id, fields);
      await refreshDecks();
      setNoteFields(selectedNotetype.fields.map(() => ""));
      setAttachments([]);
      setScreen("deck");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const beginStudy = async () => {
    if (!selectedDeckId) return;
    setBusy(true);
    setActionError(null);
    try {
      const card = await getNextCard(selectedDeckId);
      setStudyCard(card);
      setStudyComplete(card === null);
      setSessionReviews(0);
      setAnswerShown(false);
      setTypedAnswer("");
      shownAt.current = Date.now();
      setScreen("review");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const rateCard = async (rating: ReviewRating) => {
    if (!studyCard || !selectedDeckId) return;
    setBusy(true);
    setActionError(null);
    try {
      await answerCard(studyCard.id, rating, Date.now() - shownAt.current);
      setSessionReviews((count) => count + 1);
      const next = await getNextCard(selectedDeckId);
      setStudyCard(next);
      setStudyComplete(next === null);
      setAnswerShown(false);
      setTypedAnswer("");
      shownAt.current = Date.now();
      await refreshDecks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") {
    return <main className="app-shell"><div className="panel collection-loading" role="status"><span className="loading-indicator" aria-hidden="true" /><strong>Opening your collection</strong><span className="muted">Getting your decks ready…</span></div></main>;
  }

  if (state.status === "error") {
    return (
      <main className="app-shell">
        <div className="panel error-panel">
          <strong>Local collection failed to open</strong>
          <span>{state.message}</span>
        </div>
      </main>
    );
  }

  const showBack = screen !== "decks" && screen !== "stats" && screen !== "settings";
  const title = screen === "import" ? "Import"
    : screen === "stats" ? "Stats" : screen === "settings" ? "Settings" : screen === "deck-options" ? "Deck options"
      : screen === "decks" || screen === "create-deck" ? "Decks" : selectedDeck?.name ?? "Deck";

  return (
    <main className="app-shell">
      <header className={screen === "review" ? "top-bar review-top-bar" : "top-bar"}>
        <div className="title-group">
          {showBack && (
            <button className="back-button" type="button" disabled={busy}
              onClick={screen === "deck" || !selectedDeckId ? goToDecks : () => goToDeck(selectedDeckId)} aria-label="Back">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          )}
          <div>
            <p className="eyebrow">ANKI / {screen === "review" ? "STUDY SESSION" : "YOUR COLLECTION"}</p>
            <h1>{title}</h1>
          </div>
        </div>
        {screen === "decks" && (
          <div className="top-actions">
            <button className="secondary-button" type="button" onClick={() => setScreen("import")}>Import</button>
            <button className="primary-button create-deck-button" type="button" onClick={() => { setDeckName(""); setScreen("create-deck"); setActionError(null); }} aria-label="Add deck"><span aria-hidden="true">+</span> Create deck</button>
          </div>
        )}
        {screen === "deck" && (
          <div className="top-actions">
            <button className="secondary-button" type="button" disabled={busy}
              onClick={() => { setScreen("deck-options"); setActionError(null); }}>Options</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={openDeckManagement}>Manage</button>
            <button className="icon-button" type="button" onClick={() => {
              const initial = state.notetypes.find((notetype) => notetype.id === noteTypeId) ?? state.notetypes[0];
              if (initial) {
                setNoteTypeId(initial.id);
                setNoteFields(initial.fields.map(() => ""));
              }
              setAttachments([]);
              setImageOcclusion(emptyImageOcclusionDraft);
              setScreen("add-note");
              setActionError(null);
            }} aria-label="Add card">+</button>
          </div>
        )}
      </header>

      {screen === "decks" && (
        <>
          <div className="storage-banner">
            <span className={state.info.persistent ? "status-dot good" : "status-dot warning"} />
            <span>{state.info.persistent ? "Stored locally on this device" : "Temporary storage fallback"}</span>
            <span className="storage-meta">{state.info.persistent ? "Ready for offline study" : "Export a backup to keep your cards safe"}</span>
          </div>
          <section className="deck-list" aria-label="Decks">
            <div className="deck-list-heading" aria-hidden="true"><span>YOUR DECKS</span><span className="deck-counts"><span>New</span><span>Learning</span><span>Review</span></span></div>
            {state.decks.map((deck) => {
              const depth = Math.max(0, deck.name.split("::").length - 1);
              return (
                <button className="deck-row" key={deck.id} type="button" onClick={() => goToDeck(deck.id)}>
                  <span className="deck-name" style={{ paddingInlineStart: `${depth * 18}px` }}>
                    {depth > 0 ? "↳ " : ""}{leafDeckName(deck.name)}
                  </span>
                  <span className="deck-counts" aria-label={`${deck.newCount} new, ${deck.learningCount} learning, ${deck.reviewCount} to review; ${deck.totalCards} cards total`}>
                    <span className="new-count">{deck.newCount}</span>
                    <span className="learn-count">{deck.learningCount}</span>
                    <span className="review-count">{deck.reviewCount}</span>
                  </span>
                </button>
              );
            })}
          </section>
        </>
      )}

      {screen === "import" && <ImportDeck persistent={state.info.persistent} onBusyChange={setBusy}
        onImported={refreshCollection} onDone={goToDecks} />}

      {screen === "stats" && <StatsDashboard decks={state.decks} />}

      {screen === "settings" && <CollectionBackup persistent={state.info.persistent} onBusyChange={setBusy} />}

      {screen === "create-deck" && (
        <form className="panel form-panel" onSubmit={saveDeck}>
          <label htmlFor="deck-name">Deck name</label>
          <input id="deck-name" autoFocus value={deckName} onChange={(event) => setDeckName(event.target.value)} placeholder="e.g. Spanish" />
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
          <button className="primary-button" type="submit" disabled={busy || !deckName.trim()}>{busy ? "Creating…" : "Create deck"}</button>
        </form>
      )}

      {screen === "manage-deck" && selectedDeck && (
        <section className="settings-list">
          <form className="panel form-panel" onSubmit={saveDeckRename}>
            <div className="form-heading"><strong>Rename deck</strong><span>{selectedDeck.name}</span></div>
            <label htmlFor="manage-deck-name">Name</label>
            <input id="manage-deck-name" autoFocus value={deckName} onChange={(event) => setDeckName(event.target.value)} />
            <button className="primary-button" type="submit" disabled={busy || !deckName.trim()}>{busy ? "Saving…" : "Save name"}</button>
          </form>
          <form className="panel form-panel" onSubmit={saveSubdeck}>
            <div className="form-heading"><strong>Create subdeck</strong><span>Under {selectedDeck.name}</span></div>
            <label htmlFor="subdeck-name">Subdeck name</label>
            <input id="subdeck-name" value={subdeckName} onChange={(event) => setSubdeckName(event.target.value)} placeholder="e.g. Verbs" />
            <button className="secondary-button" type="submit" disabled={busy || !subdeckName.trim()}>{busy ? "Creating…" : "Create subdeck"}</button>
          </form>
          {actionError && <p className="panel form-error" role="alert">{actionError}</p>}
          {selectedDeck.id !== 1 && (
            <div className="panel form-panel">
              <div className="form-heading"><strong>Delete deck</strong><span>{selectedDeck.totalCards} cards including subdecks</span></div>
              <p className="muted">Deleting a deck also deletes its subdecks and cards. Notes are removed only when no cards remain elsewhere.</p>
              <button className="danger-button" type="button" disabled={busy} onClick={() => void removeSelectedDeck()}>Delete deck</button>
            </div>
          )}
        </section>
      )}

      {screen === "deck-options" && selectedDeck && (
        <DeckOptionsEditor deck={selectedDeck} onChanged={async () => { await refreshDecks(); }} />
      )}

      {screen === "deck" && selectedDeck && (
        <section className="deck-overview">
          <div className="count-grid">
            <div><strong className="new-count">{selectedDeck.newCount}</strong><span>New cards</span></div>
            <div><strong className="learn-count">{selectedDeck.learningCount}</strong><span>Learning</span></div>
            <div><strong className="review-count">{selectedDeck.reviewCount}</strong><span>To review</span></div>
          </div>
          {selectedDeck.totalCards === 0 && <p className="deck-empty">Add a card to start studying.</p>}
          {actionError && <p className="form-error panel" role="alert">{actionError}</p>}
          <button className="primary-button study-button" type="button" disabled={busy || selectedDeck.totalCards === 0} onClick={beginStudy}>{busy ? "Opening…" : "Study now"}</button>
          <p className="deck-total">{selectedDeck.totalCards} {selectedDeck.totalCards === 1 ? "card" : "cards"} total, including subdecks</p>
        </section>
      )}

      {screen === "add-note" && selectedDeck && selectedNotetype && (
        <form className="panel form-panel" onSubmit={saveNote}>
          <div className="form-heading"><strong>Add note</strong></div>
          <label htmlFor="note-type">Note type</label>
          <select id="note-type" value={selectedNotetype.id} onChange={(event) => {
            const id = Number(event.target.value);
            const notetype = state.notetypes.find((candidate) => candidate.id === id);
            setNoteTypeId(id);
            setNoteFields(notetype?.fields.map(() => "") ?? []);
            setImageOcclusion(emptyImageOcclusionDraft);
          }}>
            {state.notetypes.map((notetype) => <option value={notetype.id} key={notetype.id}>{notetype.name}</option>)}
          </select>
          {selectedNotetype.kind === "image-occlusion" ? (
            <ImageOcclusionEditor value={imageOcclusion} disabled={busy} onChange={setImageOcclusion} />
          ) : selectedNotetype.fields.map((field, index) => (
            <NoteFieldEditor key={`${selectedNotetype.id}-${field}`} id={`note-field-${index}`} label={field}
              autoFocus={index === 0} disabled={busy} value={noteFields[index] ?? ""}
              clozeNumber={selectedNotetype.kind === "cloze" ? nextClozeNumber(noteFields) : undefined}
              onChange={(html) => setNoteFields((current) => current.map((value, fieldIndex) => fieldIndex === index ? html : value))} />
          ))}
          {selectedNotetype.kind !== "image-occlusion" && <label className="media-picker" htmlFor="media-files">
            <span>Attach image or audio</span>
            <input id="media-files" type="file" accept="image/*,audio/*,video/*" multiple onChange={(event) => setAttachments([...event.target.files ?? []])} />
          </label>}
          {selectedNotetype.kind !== "image-occlusion" && attachments.length > 0 && <p className="attachment-list">{attachments.map((file) => file.name).join(", ")}</p>}
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
          <button className="primary-button" type="submit" disabled={busy || (selectedNotetype.kind === "image-occlusion"
            ? !imageOcclusion.image || !imageOcclusion.masks.length : !noteFields[0]?.trim())}>{busy ? "Saving…" : "Add card"}</button>
        </form>
      )}

      {screen === "review" && (
        <section className="reviewer">
          {studyComplete ? (
            <div className="panel congratulations">
              <span className="complete-mark">✓</span>
              <h2>You’re all caught up.</h2>
              <p className="muted">You have finished this deck for now.</p>
              <button className="secondary-button" type="button" onClick={() => selectedDeckId && goToDeck(selectedDeckId)}>Back to deck</button>
            </div>
          ) : studyCard ? (
            <>
              <div className="review-session-heading"><span>{answerShown ? "Check your answer" : "Take a moment to recall"}</span><span role="status">{sessionReviews} {sessionReviews === 1 ? "review" : "reviews"} completed</span></div>
              <div className={`study-card${answerShown ? " study-card--flipped" : ""}`}>
                <div className="study-card-flipper">
                  <article className="study-card-face study-card-front" aria-hidden={answerShown} inert={answerShown || undefined}>
                    <div className="study-card-heading"><span>QUESTION</span><span>{selectedDeck ? leafDeckName(selectedDeck.name) : "Flashcard"}</span></div>
                    <iframe className="study-card-frame" sandbox="" title="Card question" tabIndex={answerShown ? -1 : 0}
                      srcDoc={cardDocument(studyCard.questionHtml, studyCard.cardCss)} />
                    {!studyCard.typedAnswer ? (
                      <button className="study-card-prompt" type="button" onClick={() => setAnswerShown(true)}>
                        Show answer <span className="prompt-arrow" aria-hidden="true">→</span>
                      </button>
                    ) : <div className="study-card-face-footer">Type your answer below</div>}
                  </article>
                  <article className="study-card-face study-card-back" aria-hidden={!answerShown} inert={!answerShown || undefined}>
                    <div className="study-card-heading"><span>ANSWER</span><span>{selectedDeck ? leafDeckName(selectedDeck.name) : "Flashcard"}</span></div>
                    <iframe className="study-card-frame" sandbox="" title="Card answer" tabIndex={answerShown ? 0 : -1}
                      srcDoc={cardDocument(studyCard.answerHtml, studyCard.cardCss)} />
                    <div className="study-card-face-footer">Choose how well you remembered</div>
                  </article>
                </div>
              </div>
              {!answerShown && studyCard.typedAnswer && (
                <>
                  <label className="typed-answer-panel" htmlFor="typed-answer">
                    <span>Type your answer</span>
                    <input id="typed-answer" autoFocus autoComplete="off" value={typedAnswer}
                      onChange={(event) => setTypedAnswer(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") setAnswerShown(true); }} />
                  </label>
                  <button className="primary-button show-answer" type="button" onClick={() => setAnswerShown(true)}>Show answer</button>
                </>
              )}
              {answerShown && studyCard.typedAnswer && (
                <div className={`typed-answer-result ${typedAnswer.normalize("NFC").trim() === studyCard.typedAnswer.correct.normalize("NFC").trim() ? "correct" : "incorrect"}`}>
                  <span>Your answer</span><strong>{typedAnswer || "(blank)"}</strong>
                  <span>Correct answer</span><strong>{studyCard.typedAnswer.correct}</strong>
                </div>
              )}
              {actionError && <p className="form-error" role="alert">{actionError}</p>}
              {answerShown && (
                <div className="answer-buttons">
                  {studyCard.answerOptions.map((option) => {
                    const labels = ["", "Again", "Hard", "Good", "Easy"];
                    return (
                      <button className={`answer-btn answer-btn--${option.rating}`} type="button" key={option.rating} disabled={busy} onClick={() => void rateCard(option.rating)}>
                        <span className="answer-btn-label">{labels[option.rating]}</span>
                        <span className="answer-btn-interval">{option.intervalLabel}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedDeck && (
                <div className="review-stats-panel">
                  <div className="review-stat">
                    <span className="review-stat-label">Introduced</span>
                    <div className="review-stat-bar"><div className="review-stat-fill review-stat-fill--mastered" style={{ width: selectedDeck.totalCards ? `${((selectedDeck.totalCards - selectedDeck.newCount) / selectedDeck.totalCards) * 100}%` : "0%" }} /></div>
                    <span className="review-stat-count">{selectedDeck.totalCards - selectedDeck.newCount} of {selectedDeck.totalCards}</span>
                  </div>
                  <div className="review-stat">
                    <span className="review-stat-label">Reviewing</span>
                    <div className="review-stat-bar"><div className="review-stat-fill review-stat-fill--reviewing" style={{ width: selectedDeck.totalCards ? `${(selectedDeck.reviewCount / selectedDeck.totalCards) * 100}%` : "0%" }} /></div>
                    <span className="review-stat-count">{selectedDeck.reviewCount} of {selectedDeck.totalCards}</span>
                  </div>
                  <div className="review-stat">
                    <span className="review-stat-label">Learning</span>
                    <div className="review-stat-bar"><div className="review-stat-fill review-stat-fill--learning" style={{ width: selectedDeck.totalCards ? `${(selectedDeck.learningCount / selectedDeck.totalCards) * 100}%` : "0%" }} /></div>
                    <span className="review-stat-count">{selectedDeck.learningCount} of {selectedDeck.totalCards}</span>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </section>
      )}

      {(screen === "decks" || screen === "stats" || screen === "settings") && (
        <nav className="bottom-nav" aria-label="Primary navigation">
          <button className={`nav-item ${screen === "decks" ? "active" : ""}`} aria-current={screen === "decks" ? "page" : undefined} type="button" onClick={goToDecks}>Decks</button>
          <button className={`nav-item ${screen === "stats" ? "active" : ""}`} aria-current={screen === "stats" ? "page" : undefined} type="button"
            onClick={() => { setScreen("stats"); setSelectedDeckId(null); setActionError(null); }}>Stats</button>
          <button className={`nav-item ${screen === "settings" ? "active" : ""}`} aria-current={screen === "settings" ? "page" : undefined} type="button"
            onClick={() => { setScreen("settings"); setSelectedDeckId(null); setActionError(null); }}>Settings</button>
        </nav>
      )}
    </main>
  );
}
