"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addNote,
  answerCard,
  createDeck,
  deleteNote,
  deleteDeck,
  getNextCard,
  getStudyCard,
  initLocalCollection,
  listDecks,
  listNotetypes,
  renameDeck,
  resetCard,
  setCardDue,
  setCardFlag,
  setCardStatus,
  setNoteMarked,
  setNoteStatus,
  storeMedia,
  undoLastReview,
  updateNote
} from "@/lib/db/client";
import type { DeckSummary, LocalCollectionInfo, NoteTypeSummary, ReviewRating, StudyCard } from "@/lib/db/types";
import { CardBrowser } from "./CardBrowser";
import { DeckOptionsEditor } from "./DeckOptionsEditor";
import { ImportDeck } from "./ImportDeck";
import { NoteFieldEditor } from "./NoteFieldEditor";
import { NoteTypeManager } from "./NoteTypeManager";
import { nextClozeNumber } from "@/lib/note-editing";
import { emptyImageOcclusionDraft, ImageOcclusionEditor } from "./ImageOcclusionEditor";
import type { ImageOcclusionDraft } from "./ImageOcclusionEditor";
import { SettingsPanel } from "./SettingsPanel";
import { StatsDashboard } from "./StatsDashboard";
import { useAppPreferences } from "./useAppPreferences";
import { ReviewActions } from "./ReviewActions";
import type { ReviewDialog, ReviewDismissAction } from "./ReviewActions";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; info: LocalCollectionInfo; decks: DeckSummary[]; notetypes: NoteTypeSummary[] }
  | { status: "error"; message: string };

type Screen = "decks" | "browse" | "stats" | "settings" | "note-types" | "deck-options" | "create-deck" | "manage-deck" | "add-note" | "review" | "import";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type CardDocumentOptions = {
  theme: "light" | "dark";
  autoPlayAudio: boolean;
  showAudioControls: boolean;
};

function configureCardAudio(content: string, options: CardDocumentOptions) {
  return content.replace(/<audio\b([^>]*)>/gi, (_match, attributes: string) => {
    const clean = attributes.replace(/\s(?:autoplay|controls)(?:=[^\s>]*)?/gi, "");
    return "<audio" + clean
      + (options.showAudioControls ? " controls" : "")
      + (options.autoPlayAudio ? " autoplay" : "") + ">";
  });
}

function cardDocument(content: string, cardCss: string, options: CardDocumentOptions) {
  const dark = options.theme === "dark";
  const pageBackground = dark ? "#2e2e2e" : "#ffffff";
  const cardText = dark ? "#f2f2f2" : "#1c2e23";
  const mutedText = dark ? "#b3b3b3" : "#64748b";
  const divider = dark ? "#464646" : "#d8eadc";
  const preparedContent = configureCardAudio(content, options);
  const nightClass = dark ? " nightMode night_mode" : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      :root{color-scheme:${options.theme}}html,body{margin:0;width:100%;min-height:100%;background:${pageBackground}}
      body.card{box-sizing:border-box;min-height:100vh;padding:28px 22px!important;display:flex!important;align-items:center!important;justify-content:center!important;
      font-family:Arial,sans-serif;font-size:21px;line-height:1.45;text-align:center!important;color:${cardText}!important;background:${pageBackground}!important;overflow-wrap:anywhere}
      .anki-card-content{width:100%;max-width:100%;color:${cardText}!important;text-align:center!important}
      hr#answer{width:100%;margin:28px 0;border:0;border-top:1px solid ${divider}}img,video{max-width:100%;height:auto}
      .anki-audio{width:min(100%,360px);margin:14px auto}.hint{color:#4d9ae9;text-decoration:underline;cursor:help}
      .type-answer-marker{display:inline-block;margin-top:16px;color:${mutedText};font-size:14px}.type-answer-correct{font-weight:700}
      ${cardCss.replace(/<\/style/gi, "<\\/style")}
      body.card{color:${cardText}!important;background:${pageBackground}!important;text-align:center!important}
      .anki-card-content{color:${cardText}!important;text-align:center!important}
      .anki-card-content .cloze{color:${dark ? "#f585a0" : "#16a34a"}!important}
    </style></head><body class="card${nightClass}"><div class="anki-card-content">${preparedContent}</div></body></html>`;
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

function reviewTimerLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function LocalCollectionStatus() {
  const { preferences, resolvedTheme, updatePreferences, resetPreferences } = useAppPreferences();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [screen, setScreen] = useState<Screen>("decks");
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const lastDeckId = useRef<number | null>(null);
  useEffect(() => { if (selectedDeckId !== null) lastDeckId.current = selectedDeckId; }, [selectedDeckId]);
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
  const [reviewDialog, setReviewDialog] = useState<ReviewDialog>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [audioReplayKey, setAudioReplayKey] = useState(0);
  const [reviewElapsedSeconds, setReviewElapsedSeconds] = useState(0);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const shownAt = useRef(Date.now());
  const answerShownAt = useRef<number | null>(null);

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

  const openDeckManagement = (deck: DeckSummary) => {
    setSelectedDeckId(deck.id);
    setDeckName(leafDeckName(deck.name));
    setSubdeckName("");
    setActionError(null);
    setScreen("manage-deck");
  };

  const openDeckOptions = (deck: DeckSummary) => {
    setSelectedDeckId(deck.id);
    setActionError(null);
    setScreen("deck-options");
  };

  const openAddCard = (deck: DeckSummary) => {
    const initial = state.status === "ready" ? state.notetypes.find((notetype) => notetype.id === noteTypeId) ?? state.notetypes[0] : null;
    if (!initial) return;
    setSelectedDeckId(deck.id);
    setNoteTypeId(initial.id);
    setNoteFields(initial.fields.map(() => ""));
    setAttachments([]);
    setImageOcclusion(emptyImageOcclusionDraft);
    setActionError(null);
    setScreen("add-note");
  };

  const saveDeck = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      await createDeck(deckName);
      await refreshDecks();
      setDeckName("");
      goToDecks();
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
      goToDecks();
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
      await createDeck(`${selectedDeck.name}::${child}`);
      await refreshDecks();
      setSubdeckName("");
      goToDecks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const removeSelectedDeck = async () => {
    if (state.status !== "ready" || !selectedDeck || busy) return;
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
        goToDecks();
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
      goToDecks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const beginStudy = async (deckId = selectedDeckId) => {
    if (!deckId) return;
    setBusy(true);
    setActionError(null);
    try {
      setSelectedDeckId(deckId);
      const card = await getNextCard(deckId);
      setStudyCard(card);
      setStudyComplete(card === null);
      setSessionReviews(0);
      setAnswerShown(false);
      setTypedAnswer("");
      setReviewDialog(null);
      setUndoAvailable(false);
      setReviewElapsedSeconds(0);
      setReviewNotice(null);
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
      const outcome = await answerCard(studyCard.id, rating, Date.now() - shownAt.current);
      setUndoAvailable(true);
      setReviewNotice(outcome.leeched
        ? outcome.suspended ? "Leech detected: the note was tagged and this card was suspended." : "Leech detected: the note was tagged."
        : null);
      setSessionReviews((count) => count + 1);
      const next = await getNextCard(selectedDeckId);
      setStudyCard(next);
      setStudyComplete(next === null);
      setAnswerShown(false);
      setTypedAnswer("");
      setReviewDialog(null);
      setReviewElapsedSeconds(0);
      shownAt.current = Date.now();
      await refreshDecks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const refreshCurrentStudyCard = async (cardId = studyCard?.id) => {
    if (!cardId || !selectedDeckId) return null;
    const card = await getStudyCard(cardId);
    if (card) {
      setStudyCard(card);
      setStudyComplete(false);
    } else {
      const next = await getNextCard(selectedDeckId);
      setStudyCard(next);
      setStudyComplete(next === null);
      setAnswerShown(false);
      setTypedAnswer("");
      setReviewElapsedSeconds(0);
      shownAt.current = Date.now();
    }
    return card;
  };

  const runReviewChange = async (change: () => Promise<void>, keepCard: boolean) => {
    if (!studyCard || !selectedDeckId || busy) return false;
    setBusy(true);
    setActionError(null);
    try {
      await change();
      setUndoAvailable(false);
      setReviewNotice(null);
      if (keepCard) {
        await refreshCurrentStudyCard();
      } else {
        const next = await getNextCard(selectedDeckId);
        setStudyCard(next);
        setStudyComplete(next === null);
        setAnswerShown(false);
        setTypedAnswer("");
        setReviewElapsedSeconds(0);
        shownAt.current = Date.now();
      }
      await refreshDecks();
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const editReviewNote = (fields: string[], tags: string[]) => studyCard
    ? runReviewChange(() => updateNote(studyCard.noteId, fields, tags), true) : Promise.resolve(false);
  const flagReviewCard = (flag: number) => studyCard
    ? runReviewChange(() => setCardFlag(studyCard.id, flag), true) : Promise.resolve(false);
  const markReviewNote = (marked: boolean) => studyCard
    ? runReviewChange(() => setNoteMarked(studyCard.noteId, marked), true) : Promise.resolve(false);
  const setReviewDue = (days: number) => studyCard
    ? runReviewChange(() => setCardDue(studyCard.id, days), false) : Promise.resolve(false);
  const dismissReviewCard = (action: ReviewDismissAction) => {
    if (!studyCard) return Promise.resolve(false);
    const cardId = studyCard.id;
    const noteId = studyCard.noteId;
    const change = action === "bury-card" ? () => setCardStatus(cardId, "buried")
      : action === "bury-note" ? () => setNoteStatus(noteId, "buried")
        : action === "suspend-card" ? () => setCardStatus(cardId, "suspended")
          : action === "suspend-note" ? () => setNoteStatus(noteId, "suspended")
            : action === "reset" ? () => resetCard(cardId)
              : () => deleteNote(noteId);
    return runReviewChange(change, false);
  };

  const undoReview = async () => {
    if (busy || !undoAvailable) return;
    setBusy(true);
    setActionError(null);
    try {
      const cardId = await undoLastReview();
      if (cardId === null) {
        setUndoAvailable(false);
        setActionError("There is no review to undo.");
        return;
      }
      const card = await getStudyCard(cardId);
      if (!card) throw new Error("The reviewed card is no longer available");
      setStudyCard(card);
      setStudyComplete(false);
      setSessionReviews((count) => Math.max(0, count - 1));
      setAnswerShown(false);
      setTypedAnswer("");
      setReviewDialog(null);
      setUndoAvailable(false);
      setReviewElapsedSeconds(0);
      setReviewNotice(null);
      shownAt.current = Date.now();
      await refreshDecks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const replayCardAudio = () => setAudioReplayKey((key) => key + 1);

  useEffect(() => {
    answerShownAt.current = answerShown ? answerShownAt.current ?? Date.now() : null;
  }, [answerShown]);

  useEffect(() => {
    if (screen !== "review" || studyComplete || !studyCard?.timer.show) return;
    const update = () => setReviewElapsedSeconds(Math.floor(((answerShown && studyCard.timer.stopOnAnswer
      ? answerShownAt.current ?? Date.now() : Date.now()) - shownAt.current) / 1000));
    update();
    if (answerShown && studyCard.timer.stopOnAnswer) return;
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [answerShown, screen, studyCard, studyComplete]);

  useEffect(() => {
    if (screen !== "review" || studyComplete || !studyCard || busy || reviewDialog) return;
    const seconds = answerShown ? studyCard.timer.secondsToShowAnswer : studyCard.timer.secondsToShowQuestion;
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => {
      if (!answerShown) {
        if (studyCard.timer.questionTimeAction === "showAnswer") setAnswerShown(true);
        else setReviewNotice("Auto advance reminder: reveal the answer when you are ready.");
        return;
      }
      const action = studyCard.timer.answerTimeAction;
      if (action === "reminder") setReviewNotice("Auto advance reminder: choose an answer to continue.");
      else if (action === "bury") void dismissReviewCard("bury-card");
      else void rateCard(action === "again" ? 1 : action === "hard" ? 2 : 3);
    }, seconds * 1_000);
    return () => window.clearTimeout(timer);
  }, [answerShown, busy, reviewDialog, screen, studyCard, studyComplete]);

  useEffect(() => {
    if (screen !== "review" || !preferences.keyboardShortcuts || busy) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target;
      if (reviewDialog) {
        if (event.key === "Escape") {
          event.preventDefault();
          setReviewDialog(null);
        }
        return;
      }
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (isEditing) return;
      const key = event.key;
      const lowerKey = key.toLocaleLowerCase();
      if (!event.metaKey && !event.ctrlKey && !event.altKey && lowerKey === "z" && undoAvailable) {
        event.preventDefault();
        void undoReview();
        return;
      }
      if (!studyCard || studyComplete) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && /^[0-7]$/.test(key)) {
        event.preventDefault();
        void flagReviewCard(Number(key));
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (lowerKey === "e") { event.preventDefault(); setReviewDialog("edit"); return; }
      if (lowerKey === "m" || key === "*") {
        event.preventDefault();
        void markReviewNote(!studyCard.tags.some((tag) => tag.toLocaleLowerCase() === "marked"));
        return;
      }
      if (lowerKey === "r") { event.preventDefault(); replayCardAudio(); return; }
      if (lowerKey === "d") { event.preventDefault(); setReviewDialog("due"); return; }
      if (lowerKey === "i") { event.preventDefault(); setReviewDialog("info"); return; }
      if (key === "-") { event.preventDefault(); void dismissReviewCard("bury-card"); return; }
      if (key === "=") { event.preventDefault(); void dismissReviewCard("bury-note"); return; }
      if (key === "@") { event.preventDefault(); void dismissReviewCard("suspend-card"); return; }
      if (key === "!") { event.preventDefault(); void dismissReviewCard("suspend-note"); return; }
      if (!answerShown) {
        if ((key === " " || key === "Enter") && !(target instanceof HTMLButtonElement)) {
          event.preventDefault();
          setAnswerShown(true);
        }
        return;
      }
      if (target instanceof HTMLButtonElement && (key === " " || key === "Enter")) return;
      const rating = key === "1" ? 1 : key === "2" ? 2 : key === "3" || key === " " || key === "Enter" ? 3 : key === "4" ? 4 : null;
      if (rating === null) return;
      event.preventDefault();
      void rateCard(rating);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [answerShown, busy, preferences.keyboardShortcuts, reviewDialog, screen, studyCard, studyComplete, undoAvailable]);

  if (state.status === "loading") {
    return <><a className="skip-link" href="#main-content">Skip to content</a><main id="main-content" className="app-shell" tabIndex={-1}><div className="panel collection-loading" role="status"><span className="loading-indicator" aria-hidden="true" /><strong>Opening your collection</strong><span className="muted">Getting your decks ready…</span></div></main></>;
  }

  if (state.status === "error") {
    return (
      <><a className="skip-link" href="#main-content">Skip to content</a><main id="main-content" className="app-shell" tabIndex={-1}>
        <div className="panel error-panel">
          <strong>Local collection failed to open</strong>
          <span>{state.message}</span>
        </div>
      </main></>
    );
  }

  const showBack = screen !== "decks" && screen !== "browse" && screen !== "stats" && screen !== "settings";
  const title = screen === "browse" ? "Browse" : screen === "import" ? "Import"
    : screen === "stats" ? "Stats" : screen === "settings" ? "Settings" : screen === "note-types" ? "Note types" : screen === "deck-options" ? "Deck options"
      : "Decks";

  return (
    <><a className="skip-link" href="#main-content">Skip to content</a><main id="main-content" className="app-shell" tabIndex={-1}>
      <header className={screen === "review" ? "top-bar review-top-bar" : "top-bar"}>
        <div className="title-group">
          {showBack && (
            <button className="back-button" type="button" disabled={busy}
              onClick={screen === "note-types" ? () => setScreen("settings") : goToDecks} aria-label="Back">
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
      </header>

      {screen === "decks" && (
        <>

          <section className="deck-list" aria-label="Decks">
            <div className="deck-list-heading" aria-hidden="true"><span>YOUR DECKS</span><span className="deck-counts"><span>New</span><span>Learning</span><span>Review</span></span></div>
            {state.decks.map((deck) => {
              const depth = Math.max(0, deck.name.split("::").length - 1);
              return (
                <div className="deck-row" data-deck-id={deck.id} key={deck.id}>
                  <button className="deck-study-button" type="button" disabled={busy || deck.totalCards === 0}
                    onClick={() => void beginStudy(deck.id)} aria-label={`Study ${deck.name}`}>
                    <span className="deck-name" style={{ paddingInlineStart: `${depth * 18}px` }}>
                      {depth > 0 ? "↳ " : ""}{leafDeckName(deck.name)}
                    </span>
                    <span className="deck-counts" aria-label={`${deck.newCount} new, ${deck.learningCount} learning, ${deck.reviewCount} to review; ${deck.totalCards} cards total`}>
                      <span className="new-count">{deck.newCount}</span>
                      <span className="learn-count">{deck.learningCount}</span>
                      <span className="review-count">{deck.reviewCount}</span>
                    </span>
                  </button>
                  <details className="deck-row-actions">
                    <summary aria-label={`Actions for ${deck.name}`}>Actions</summary>
                    <div className="deck-row-menu">
                      <button type="button" aria-label={`Add card to ${deck.name}`} onClick={() => openAddCard(deck)}>Add card</button>
                      <button type="button" onClick={() => openDeckOptions(deck)}>Options</button>
                      <button type="button" onClick={() => openDeckManagement(deck)}>Manage</button>
                    </div>
                  </details>
                </div>
              );
            })}
          </section>
        </>
      )}

      {screen === "import" && <ImportDeck persistent={state.info.persistent} onBusyChange={setBusy}
        onImported={refreshCollection} onDone={goToDecks} />}

      {screen === "browse" && <CardBrowser decks={state.decks} currentDeckId={lastDeckId.current} onCollectionChanged={refreshCollection} />}

      {screen === "stats" && <StatsDashboard decks={state.decks} />}

      {screen === "settings" && <SettingsPanel info={state.info} preferences={preferences}
        onChange={updatePreferences} onReset={resetPreferences} onBusyChange={setBusy}
        onManageNoteTypes={() => { setScreen("note-types"); setActionError(null); }}
        onCollectionRestored={async () => {
          setSelectedDeckId(null);
          setStudyCard(null);
          setStudyComplete(false);
          setReviewDialog(null);
          setUndoAvailable(false);
          setActionError(null);
          await refreshCollection();
        }} />}

      {screen === "note-types" && <NoteTypeManager onCollectionChanged={refreshCollection} />}

      {screen === "create-deck" && (
        <form className="panel form-panel" onSubmit={saveDeck}>
          <label htmlFor="deck-name">Deck name</label>
          <input id="deck-name" autoFocus value={deckName} onChange={(event) => setDeckName(event.target.value)} placeholder="e.g. Spanish" />
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
          <button className="primary-button" type="submit" disabled={busy || !deckName.trim()}>{busy ? "Creating…" : "Create deck"}</button>
        </form>
      )}

      {screen === "manage-deck" && selectedDeck && (
        <section className="deck-management">
          <div className="deck-management-grid">
            <form className="panel form-panel deck-management-card" onSubmit={saveDeckRename}>
              <div className="form-heading"><strong>Rename deck</strong><span>{selectedDeck.name}</span></div>
              <label htmlFor="manage-deck-name">Name</label>
              <input id="manage-deck-name" autoFocus value={deckName} onChange={(event) => setDeckName(event.target.value)} />
              <button className="primary-button" type="submit" disabled={busy || !deckName.trim()}>{busy ? "Saving…" : "Save name"}</button>
            </form>
            <form className="panel form-panel deck-management-card" onSubmit={saveSubdeck}>
              <div className="form-heading"><strong>Create subdeck</strong><span>Under {selectedDeck.name}</span></div>
              <label htmlFor="subdeck-name">Subdeck name</label>
              <input id="subdeck-name" value={subdeckName} onChange={(event) => setSubdeckName(event.target.value)} placeholder="e.g. Verbs" />
              <button className="secondary-button" type="submit" disabled={busy || !subdeckName.trim()}>{busy ? "Creating…" : "Create subdeck"}</button>
            </form>
          </div>
          {actionError && <p className="panel form-error" role="alert">{actionError}</p>}
          <div className="panel form-panel deck-management-delete">
            <div className="form-heading"><strong>Delete deck</strong><span>{selectedDeck.totalCards} cards including subdecks</span></div>
            <p className="muted">Deleting a deck also deletes its subdecks and cards. Notes are removed only when no cards remain elsewhere.</p>
            <button className="danger-button" type="button" disabled={busy} onClick={() => void removeSelectedDeck()}>Delete deck</button>
          </div>
        </section>
      )}

      {screen === "deck-options" && selectedDeck && (
        <DeckOptionsEditor deck={selectedDeck} onChanged={async () => { await refreshDecks(); }} />
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
              {reviewNotice && <p className="review-notice" role="status">{reviewNotice}</p>}
              <div className="congratulations-actions">
                {undoAvailable && <button className="secondary-button" type="button" disabled={busy} aria-keyshortcuts="Z" onClick={() => void undoReview()}>Undo last review</button>}
                <button className="secondary-button" type="button" onClick={goToDecks}>Back to decks</button>
              </div>
            </div>
          ) : studyCard ? (
            <>
              <div className="review-session-heading">
                <span>{answerShown ? "Check your answer" : "Take a moment to recall"}</span>
                <div className="review-session-meta">
                  {studyCard.timer.show && <span className="review-answer-timer" role="timer"
                    aria-label={`${reviewElapsedSeconds} seconds elapsed`}>{reviewTimerLabel(Math.min(reviewElapsedSeconds, studyCard.timer.maximumSeconds))}</span>}
                  {preferences.showReviewProgress && <span role="status">{sessionReviews} {sessionReviews === 1 ? "review" : "reviews"} completed</span>}
                </div>
              </div>
              <ReviewActions card={studyCard} busy={busy} dialog={reviewDialog} undoAvailable={undoAvailable}
                onDialogChange={setReviewDialog} onEdit={editReviewNote} onFlag={flagReviewCard} onMark={markReviewNote}
                onDismiss={dismissReviewCard} onSetDue={setReviewDue} onUndo={undoReview} onReplay={replayCardAudio} />
              {reviewNotice && <p className="review-notice" role="status">{reviewNotice}</p>}
              <div className={`study-card${answerShown ? " study-card--flipped" : ""}`}>
                <div className="study-card-flipper">
                  <article className="study-card-face study-card-front" aria-hidden={answerShown} inert={answerShown || undefined}>
                    <div className="study-card-heading"><span>QUESTION</span><span>{selectedDeck ? leafDeckName(selectedDeck.name) : "Flashcard"}</span></div>
                    <iframe key={`question-${studyCard.id}-${audioReplayKey}`} className="study-card-frame" sandbox="" title="Card question" tabIndex={answerShown ? -1 : 0}
                      srcDoc={cardDocument(studyCard.questionHtml, studyCard.cardCss, {
                        theme: resolvedTheme, autoPlayAudio: preferences.autoPlayAudio && !answerShown,
                        showAudioControls: preferences.showAudioControls
                      })} />
                    {!studyCard.typedAnswer ? (
                      <button className="study-card-prompt" type="button" aria-keyshortcuts="Space Enter" onClick={() => setAnswerShown(true)}>
                        Show answer <span className="prompt-arrow" aria-hidden="true">→</span>
                      </button>
                    ) : <div className="study-card-face-footer">Type your answer below</div>}
                  </article>
                  <article className="study-card-face study-card-back" aria-hidden={!answerShown} inert={!answerShown || undefined}>
                    <div className="study-card-heading"><span>ANSWER</span><span>{selectedDeck ? leafDeckName(selectedDeck.name) : "Flashcard"}</span></div>
                    <iframe key={`answer-${studyCard.id}-${audioReplayKey}`} className="study-card-frame" sandbox="" title="Card answer" tabIndex={answerShown ? 0 : -1}
                      srcDoc={cardDocument(studyCard.answerHtml, studyCard.cardCss, {
                        theme: resolvedTheme, autoPlayAudio: preferences.autoPlayAudio && answerShown,
                        showAudioControls: preferences.showAudioControls
                      })} />
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
                      onKeyDown={(event) => { if (preferences.keyboardShortcuts && event.key === "Enter") setAnswerShown(true); }} />
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
                      <button className={`answer-btn answer-btn--${option.rating}`} type="button" key={option.rating} aria-keyshortcuts={String(option.rating)} disabled={busy} onClick={() => void rateCard(option.rating)}>
                        <span className="answer-btn-label">{labels[option.rating]}</span>
                        {preferences.showAnswerTimes && <span className="answer-btn-interval">{option.intervalLabel}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {preferences.showReviewProgress && selectedDeck && (
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

      {(screen === "decks" || screen === "browse" || screen === "stats" || screen === "settings") && (
        <nav className="bottom-nav" aria-label="Primary navigation">
          <button className={`nav-item ${screen === "decks" ? "active" : ""}`} aria-current={screen === "decks" ? "page" : undefined} type="button" onClick={goToDecks}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="13" rx="2" /><path d="M7 5h10M9 2h6" /></svg>
            <span>Decks</span>
          </button>
          <button className={`nav-item ${screen === "browse" ? "active" : ""}`} aria-current={screen === "browse" ? "page" : undefined} type="button"
            onClick={() => { setScreen("browse"); setActionError(null); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
            <span>Browse</span>
          </button>
          <button className={`nav-item ${screen === "stats" ? "active" : ""}`} aria-current={screen === "stats" ? "page" : undefined} type="button"
            onClick={() => { setScreen("stats"); setSelectedDeckId(null); setActionError(null); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M6 16v-5M12 16V4M18 16V8" /></svg>
            <span>Stats</span>
          </button>
          <button className={`nav-item ${screen === "settings" ? "active" : ""}`} aria-current={screen === "settings" ? "page" : undefined} type="button"
            onClick={() => { setScreen("settings"); setSelectedDeckId(null); setActionError(null); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.5 2-2 1.2-2-.6-2 3.4L4 10.5v3L2.5 15l2 3.4 2-.6 2 1.2.5 2h4l.5-2 2-1.2 2 .6 2-3.4-1.5-1.5v-3L20 9l-2-3.4-2 .6L14 5l-.5-2Z" /><circle cx="11.25" cy="12" r="3" /></svg>
            <span>Settings</span>
          </button>
        </nav>
      )}
    </main></>
  );
}
