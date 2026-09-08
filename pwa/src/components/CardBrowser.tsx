"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browseCollection, browserMetadata, deleteNote, moveCard, setCardFlag, setCardStatus, updateNote } from "@/lib/db/client";
import type { BrowserCard, BrowserMetadata, BrowserNote, BrowserOptions, BrowserResults, BrowserSort, DeckSummary } from "@/lib/db/types";
import { BrowserSidebar, flagColors, flagNames } from "./BrowserSidebar";
import type { SavedSearch } from "./BrowserSidebar";
import { NoteFieldEditor } from "./NoteFieldEditor";
import { nextClozeNumber } from "@/lib/note-editing";

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function modifiedDate(seconds: number) { return new Date(seconds * 1000).toLocaleDateString(); }
function stateLabel(card: BrowserCard) { return card.status === "active" ? card.state : card.status; }
const savedSearchKey = "anki.browser.saved-searches";

export function CardBrowser({ decks, currentDeckId, onCollectionChanged }: {
  decks: DeckSummary[];
  currentDeckId: number | null;
  onCollectionChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<BrowserOptions>({ query: "", mode: "cards", sort: "sortField", descending: false, offset: 0, currentDeckId });
  const [result, setResult] = useState<BrowserResults | null>(null);
  const [metadata, setMetadata] = useState<BrowserMetadata | null>(null);
  const [selected, setSelected] = useState<BrowserNote | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [tags, setTags] = useState("");
  // Large collections can contain tens of thousands of cards. Opening Browse
  // should feel like arriving at a search tool, not like loading a wall of
  // records the user did not ask to see.
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyCardId, setBusyCardId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [savingSearch, setSavingSearch] = useState(false);
  const [searchName, setSearchName] = useState("");
  const [showSearchHelp, setShowSearchHelp] = useState(false);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!hasSearched) {
      setLoading(false);
      setResult(null);
      return;
    }
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const next = await browseCollection({ ...options, currentDeckId });
      if (version === requestVersion.current) setResult(next);
    } catch (error) {
      if (version === requestVersion.current) { setError(errorMessage(error)); setResult(null); }
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [hasSearched, options, currentDeckId]);

  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [load]);
  useEffect(() => {
    void browserMetadata().then(setMetadata).catch((error) => setError(errorMessage(error)));
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(savedSearchKey) ?? "[]");
      if (Array.isArray(entries)) setSaved(entries.filter((entry): entry is SavedSearch =>
        entry && typeof entry.name === "string" && typeof entry.query === "string"));
    } catch { setNotice("Saved searches could not be loaded."); }
  }, []);

  function storeSearches(next: SavedSearch[]) {
    try { localStorage.setItem(savedSearchKey, JSON.stringify(next)); setSaved(next); }
    catch { setError("Could not save searches on this device."); }
  }
  function runSearch(nextQuery: string) {
    setLoading(true);
    setHasSearched(true);
    setQuery(nextQuery);
    setOptions((current) => ({ ...current, query: nextQuery, offset: 0 }));
    setNotice(null);
  }
  function sortBy(sort: BrowserSort) {
    if (!hasSearched) return;
    setLoading(true);
    setOptions((current) => ({ ...current, sort, descending: current.sort === sort ? !current.descending : false, offset: 0 }));
  }
  function chooseNote(note: BrowserNote) { setSelected(note); setFields([...note.fields]); setTags(note.tags.join(" ")); setError(null); setNotice(null); }
  async function refresh() {
    await Promise.all([load(), onCollectionChanged()]);
    setMetadata(await browserMetadata());
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || busy || busyCardId !== null) return;
    setBusy(true); setError(null);
    try {
      await updateNote(selected.id, fields, tags.split(/[\s,]+/).filter(Boolean));
      setSelected(null); setNotice("Note saved."); await refresh();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || busy || busyCardId !== null || !window.confirm("Delete this note and all its cards? This cannot be undone.")) return;
    setBusy(true); setError(null);
    try { await deleteNote(selected.id); setSelected(null); await refresh(); setNotice("Note deleted."); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  async function changeCard(card: BrowserCard, action: () => Promise<void>, patch: Partial<BrowserCard>) {
    if (busy || busyCardId !== null) return;
    setBusyCardId(card.id); setError(null);
    try {
      await action();
      setSelected((note) => note ? { ...note, cards: note.cards.map((candidate) => candidate.id === card.id ? { ...candidate, ...patch } : candidate) } : note);
      await refresh();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusyCardId(null); }
  }
  const changeCardStatus = (card: BrowserCard, status: BrowserCard["status"]) => changeCard(card, () => setCardStatus(card.id, status), { status });
  const changeCardDeck = (card: BrowserCard, deckId: number) => changeCard(card, () => moveCard(card.id, deckId), { deckId, deckName: decks.find((deck) => deck.id === deckId)?.name ?? card.deckName });
  if (selected) {
    return <section className="browser-editor">
      <div className="browser-editor-heading">
        <button className="secondary-button" type="button" disabled={busy || busyCardId !== null}
          onClick={() => { if (fields.some((value, index) => value !== selected.fields[index]) || tags !== selected.tags.join(" ")) {
            if (!window.confirm("Discard your unsaved note changes?")) return;
          } setSelected(null); setError(null); }}>‹ Results</button>
        <span>{selected.notetypeName}</span>
      </div>
      <form className="panel form-panel" onSubmit={save}>
        <div className="form-heading"><strong>Edit note</strong><span>Modified {modifiedDate(selected.modified)}</span></div>
        {selected.fieldNames.map((name, index) => <NoteFieldEditor key={`${selected.id}-${index}`} id={`browser-field-${index}`} label={name}
          value={fields[index] ?? ""} disabled={busy || busyCardId !== null} clozeNumber={selected.cloze ? nextClozeNumber(fields) : undefined}
          onChange={(html) => setFields((current) => current.map((value, fieldIndex) => fieldIndex === index ? html : value))} />)}
        <label htmlFor="browser-tags">Tags</label>
        <input id="browser-tags" value={tags} disabled={busy} onChange={(event) => setTags(event.target.value)} placeholder="Separate tags with spaces" />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="browser-save-actions">
          <button className="primary-button" type="submit" disabled={busy || busyCardId !== null || !fields[0]?.trim()}>{busy ? "Saving…" : "Save note"}</button>
          <button className="danger-button" type="button" disabled={busy || busyCardId !== null} onClick={() => void remove()}>Delete note</button>
        </div>
      </form>
      <section className="panel browser-cards" aria-label="Cards generated by this note">
        <div className="form-heading"><strong>Cards</strong><span>{selected.cards.length}</span></div>
        {selected.cards.map((card) => <article className="browser-card" key={card.id}>
          <div><strong>{card.templateName}</strong><span>{card.deckName} · {stateLabel(card)} · {card.reviews} reviews</span></div>
          <div className="browser-card-actions">
            <select aria-label={`Flag ${card.templateName}`} value={card.flag} disabled={busy || busyCardId !== null}
              onChange={(event) => { const flag = Number(event.target.value); void changeCard(card, () => setCardFlag(card.id, flag), { flag }); }}>
              {flagNames.map((name, flag) => <option key={flag} value={flag}>{name}</option>)}
            </select>
            <select aria-label={`Move ${card.templateName} to deck`} value={card.deckId} disabled={busy || busyCardId !== null}
              onChange={(event) => void changeCardDeck(card, Number(event.target.value))}>
              {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
            </select>
            {card.status !== "suspended" && <button type="button" disabled={busy || busyCardId !== null} onClick={() => void changeCardStatus(card, "suspended")}>Suspend</button>}
            {card.status !== "buried" && <button type="button" disabled={busy || busyCardId !== null} onClick={() => void changeCardStatus(card, "buried")}>Bury</button>}
            {card.status !== "active" && <button type="button" disabled={busy || busyCardId !== null} onClick={() => void changeCardStatus(card, "active")}>{card.status === "buried" ? "Unbury" : "Resume"}</button>}
          </div>
        </article>)}
      </section>
    </section>;
  }
  return (
    <section className="browser-workspace">
      <BrowserSidebar decks={decks} metadata={metadata} currentDeckId={currentDeckId} query={options.query} hasSearched={hasSearched} saved={saved}
        onSearch={runSearch} onRemove={(name) => storeSearches(saved.filter((entry) => entry.name !== name))} />
      <div className="browser-main">
        <div className="browser-search-area">
          <form className="browser-search-bar" onSubmit={(event) => { event.preventDefault(); runSearch(query); }}>
            <label className="sr-only" htmlFor="browser-mode">Results view</label>
            <select id="browser-mode" value={options.mode} onChange={(event) => setOptions((current) => ({ ...current, mode: event.target.value as "cards" | "notes", offset: 0 }))}>
              <option value="cards">Cards</option><option value="notes">Notes</option>
            </select>
            <label className="sr-only" htmlFor="browser-query">Search cards and notes</label>
            <input id="browser-query" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search text, deck, tag, or card state" />
            <button type="submit" className="primary-button" disabled={loading}>Search</button>
            <button type="button" className="secondary-button" disabled={!options.query.trim() || loading || Boolean(error)} onClick={() => { setSearchName(""); setSavingSearch(!savingSearch); }}>Save search</button>
            <button className="browser-search-help-button" type="button" aria-label="Show search syntax help" aria-expanded={showSearchHelp}
              onClick={() => setShowSearchHelp((current) => !current)}>i</button>
          </form>
          {showSearchHelp && <section className="browser-search-help-popover" role="dialog" aria-labelledby="browser-search-help-title">
            <div><strong id="browser-search-help-title">Search syntax</strong><button type="button" aria-label="Close search syntax help" onClick={() => setShowSearchHelp(false)}>×</button></div>
            <p>Combine terms with spaces to match all of them. Use quotes for names with spaces and a minus sign to exclude a term.</p>
            <p><code>deck:"Spanish" is:review -flag:1</code> · <code>tag:verbs</code> · <code>prop:due=0</code> · <code>added:7</code></p>
          </section>}
        </div>
        {savingSearch && <form className="browser-save-search" onSubmit={(event) => {
          event.preventDefault();
          const name = searchName.trim();
          if (!name) return;
          if (saved.some((entry) => entry.name === name)) { setError("A saved search already has that name."); return; }
          storeSearches([...saved, { name, query: options.query }]); setSavingSearch(false);
        }}>
          <label htmlFor="search-name">Search name</label><input id="search-name" autoFocus maxLength={100} value={searchName} onChange={(event) => setSearchName(event.target.value)} />
          <button className="secondary-button" type="submit" disabled={!searchName.trim()}>Save</button>
        </form>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!hasSearched ? <section className="browser-welcome" aria-labelledby="browse-welcome-title">
          <span className="browser-welcome-icon" aria-hidden="true">⌕</span>
          <h2 id="browse-welcome-title">Find what you need</h2>
          <p>Search by text, deck, tag, or card state. Your collection stays uncluttered until you choose a filter.</p>
          <button className="secondary-button" type="button" onClick={() => runSearch("")}>Browse all cards</button>
        </section> : <>
          <div className="browser-result-heading" role="status">{loading ? "Loading…" : `${result?.total ?? 0} ${options.mode}`}</div>
          <div className="browser-table-scroll" aria-busy={loading}>
            <table className="browser-results-table">
              <thead><tr>{([["sortField", "Sort Field"], ["cardType", "Card Type"], ["due", "Due"], ["deck", "Deck"]] as const).map(([sort, label]) => (
                <th key={sort} scope="col" aria-sort={options.sort === sort ? options.descending ? "descending" : "ascending" : "none"}>
                  <button type="button" onClick={() => sortBy(sort)}>{label}{options.sort === sort ? options.descending ? " ↓" : " ↑" : ""}</button>
                </th>
              ))}</tr></thead>
              <tbody>{!loading && result?.rows.map(({ note, card }) => <tr key={card.id}>
                <td><button className="browser-open-note" type="button" onClick={() => chooseNote(note)}>
                  {card.flag > 0 && <span style={{ color: flagColors[card.flag] }} aria-label={`${flagNames[card.flag]} flag`}>⚑ </span>}{note.preview}
                </button></td>
                <td>{card.templateName}<small>{note.notetypeName}</small></td>
                <td>{card.dueLabel}<small>{stateLabel(card)}</small></td><td>{card.deckName}</td>
              </tr>)}</tbody>
            </table>
            {!loading && result?.total === 0 && <p className="browser-empty">No matching {options.mode}.</p>}
          </div>
          <div className="browser-pagination">
            <button className="secondary-button" type="button" disabled={loading || options.offset === 0} onClick={() => setOptions((current) => ({ ...current, offset: Math.max(0, current.offset - 50) }))}>Previous</button>
            <span>{result?.total ? `${options.offset + 1}–${options.offset + result.rows.length} of ${result.total}` : "0 results"}</span>
            <button className="secondary-button" type="button" disabled={loading || !result?.hasMore} onClick={() => setOptions((current) => ({ ...current, offset: current.offset + 50 }))}>Next</button>
          </div>
        </>}
      </div>
    </section>
  );
}
