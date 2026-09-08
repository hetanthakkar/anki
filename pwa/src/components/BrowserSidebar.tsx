"use client";

import { useState } from "react";
import type { BrowserMetadata, DeckSummary } from "@/lib/db/types";
import { quoteSearch } from "@/lib/db/browser-search";

export const flagNames = ["No Flag", "Red", "Orange", "Green", "Blue", "Pink", "Turquoise", "Purple"];
export const flagColors = ["#64748b", "#dc4444", "#d97706", "#16864a", "#2679cc", "#d54b91", "#078f98", "#9251c5"];
export type SavedSearch = { name: string; query: string };

export function BrowserSidebar({ decks, metadata, currentDeckId, query, hasSearched, saved, onSearch, onRemove }: {
  decks: DeckSummary[];
  metadata: BrowserMetadata | null;
  currentDeckId: number | null;
  query: string;
  hasSearched: boolean;
  saved: SavedSearch[];
  onSearch: (query: string) => void;
  onRemove: (name: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const matches = (label: string) => label.toLowerCase().includes(filter.toLowerCase());
  const item = (label: string, search: string, color?: string, disabled = false) => (
    <button key={search} type="button" className={hasSearched && query === search ? "selected" : ""} aria-pressed={hasSearched && query === search}
      disabled={disabled} onClick={() => onSearch(search)} title={disabled ? "Open a deck first" : search}>
      {color && <span className="browser-filter-dot" style={{ background: color }} aria-hidden="true" />}{label}
    </button>
  );
  const group = (name: string, items: { name: string; query: string; color?: string; disabled?: boolean }[]) => {
    const visible = items.filter((entry) => matches(name) || matches(entry.name));
    if (!visible.length) return null;
    return <details key={name} open><summary>{name}</summary>{visible.map((entry) => item(entry.name, entry.query, entry.color, entry.disabled))}</details>;
  };
  return (
    <aside className="browser-sidebar" aria-label="Browse filters">
      <label className="sr-only" htmlFor="sidebar-filter">Sidebar filter</label>
      <input id="sidebar-filter" type="search" placeholder="Filter sidebar" value={filter} onChange={(event) => setFilter(event.target.value)} />
      {item("All cards", "")}
      <details open><summary>Saved Searches</summary>
        {saved.filter((entry) => matches("Saved Searches") || matches(entry.name)).map((entry) => <div className="saved-search-row" key={entry.name}>
          {item(entry.name, entry.query)}<button className="remove-saved-search" type="button" aria-label={`Remove saved search ${entry.name}`} onClick={() => onRemove(entry.name)}>×</button>
        </div>)}
        {!saved.length && <p>Save a search to reuse it here.</p>}
      </details>
      {group("Today", [
        { name: "Due", query: "prop:due=0" }, { name: "Added", query: "added:1" },
        { name: "Edited", query: "edited:1" }, { name: "Studied", query: "rated:1" },
        { name: "First Review", query: "introduced:1" }, { name: "Rescheduled", query: "resched:1" },
        { name: "Again", query: "rated:1:1" }, { name: "Overdue", query: "is:due -prop:due=0" },
      ])}
      {group("Flags", flagNames.map((name, flag) => ({ name, query: `flag:${flag}`, color: flagColors[flag] })))}
      {group("Card State", [
        { name: "New", query: "is:new" }, { name: "Learning", query: "is:learn" }, { name: "Review", query: "is:review" },
        { name: "Suspended", query: "is:suspended" }, { name: "Buried", query: "is:buried" },
      ])}
      {group("Decks", [{ name: "Current Deck", query: "deck:current", disabled: currentDeckId === null },
        ...decks.map((deck) => ({ name: deck.name, query: `deck:${quoteSearch(deck.name)}` }))])}
      <details open><summary>Note Types</summary>
        {metadata?.notetypes.filter((note) => matches("Note Types") || matches(note.name) || note.templates.some((template) => matches(template.name))).map((note) => (
          <details className="browser-template-group" key={note.id} open={Boolean(filter)}>
            <summary>{note.name}</summary>
            {item(`All ${note.name}`, `mid:${note.id}`)}
            {note.templates.map((template) => item(template.name, `mid:${note.id} card:${template.ordinal + 1}`))}
          </details>
        ))}
      </details>
      {group("Tags", [{ name: "Untagged", query: "tag:none" }, ...(metadata?.tags ?? []).map((tag) => ({ name: tag, query: `tag:${quoteSearch(tag)}` }))])}
    </aside>
  );
}
