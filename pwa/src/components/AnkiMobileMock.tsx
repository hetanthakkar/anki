"use client";

import { useState } from "react";

type Screen = "decks" | "study" | "browse" | "settings" | "stats" | "add" | "edit" | "tools" | "help";

const decks = [
  { name: "German B1", review: 42, newCards: 20 },
  { name: "Computer Science", review: 7, newCards: 5 },
  { name: "Japanese", review: 0, newCards: 12 },
  { name: "Default", review: 0, newCards: 0 },
];

const browserRows = [
  ["der Hund", "the dog"],
  ["die Erfahrung", "experience"],
  ["zuverlässig", "reliable"],
  ["die Herausforderung", "challenge"],
  ["sich erinnern", "to remember"],
  ["wahrscheinlich", "probably"],
];

function ToolbarButton({ label, glyph, onClick }: { label: string; glyph: string; onClick?: () => void }) {
  return (
    <button className="anki-icon-button" type="button" aria-label={label} title={label} onClick={onClick}>
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

function NavigationBar({
  title,
  back,
  onBack,
  trailing,
}: {
  title: string;
  back?: string;
  onBack?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <header className="anki-nav-bar">
      <div className="anki-nav-side anki-nav-left">
        {back ? (
          <button className="anki-text-button back-button" type="button" onClick={onBack}>
            <span aria-hidden="true">‹</span>{back}
          </button>
        ) : null}
      </div>
      <h1 className="anki-nav-title">{title}</h1>
      <div className="anki-nav-side anki-nav-right">{trailing}</div>
    </header>
  );
}

function DeckList({ setScreen, setDeck }: { setScreen: (screen: Screen) => void; setDeck: (deck: string) => void }) {
  const [showAddMenu, setShowAddMenu] = useState(false);

  return (
    <section className="anki-screen deck-screen">
      <NavigationBar
        title="Decks"
        trailing={
          <div className="deck-top-actions">
            <ToolbarButton label="Help" glyph="?" onClick={() => setScreen("help")} />
            <ToolbarButton label="Statistics" glyph="▥" onClick={() => setScreen("stats")} />
            <ToolbarButton label="Browse" glyph="⌕" onClick={() => setScreen("browse")} />
            <ToolbarButton label="Preferences" glyph="⚙" onClick={() => setScreen("settings")} />
          </div>
        }
      />

      <div className="deck-table" role="list" aria-label="Decks">
        {decks.map((deck) => (
          <button
            className="mobile-deck-row"
            type="button"
            role="listitem"
            key={deck.name}
            onClick={() => {
              setDeck(deck.name);
              setScreen("study");
            }}
          >
            <span className="mobile-deck-title">{deck.name}</span>
            <span className="mobile-deck-counts" aria-label={`${deck.review} review, ${deck.newCards} new`}>
              <strong className="deck-review-count">{deck.review}</strong>
              <strong className="deck-new-count">{deck.newCards}</strong>
            </span>
          </button>
        ))}
      </div>

      <div className="deck-spacer" />

      <footer className="anki-bottom-toolbar deck-bottom-toolbar">
        <button className="anki-bottom-text" type="button" onClick={() => setShowAddMenu(true)}>Add/Export</button>
        <button className="anki-bottom-text sync-button" type="button">Synchronize</button>
      </footer>

      {showAddMenu ? (
        <div className="sheet-backdrop" role="presentation" onClick={() => setShowAddMenu(false)}>
          <div className="anki-action-sheet" role="dialog" aria-label="Add and export" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-group">
              <button type="button">Shared Deck List</button>
              <button type="button">Add / Create Deck</button>
              <button type="button">Import</button>
              <button type="button">Export</button>
            </div>
            <button className="sheet-cancel" type="button" onClick={() => setShowAddMenu(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StudyScreen({ deck, setScreen }: { deck: string; setScreen: (screen: Screen) => void }) {
  const [answerShown, setAnswerShown] = useState(false);

  return (
    <section className="anki-screen study-screen">
      <NavigationBar
        title={deck}
        back="Decks"
        onBack={() => setScreen("decks")}
        trailing={
          <div className="study-nav-actions">
            <button type="button" onClick={() => setScreen("add")}>Add</button>
            <button type="button" onClick={() => setScreen("edit")}>Edit</button>
            <button type="button" onClick={() => setScreen("browse")}>Browse</button>
          </div>
        }
      />

      <button className="review-card-area" type="button" onClick={() => setAnswerShown(true)}>
        <article className="review-card-content">
          <p className="review-prompt">der Hund</p>
          {answerShown ? (
            <>
              <hr />
              <p className="review-answer">the dog</p>
              <p className="review-example">Der Hund schläft unter dem Tisch.</p>
            </>
          ) : null}
        </article>
      </button>

      <footer className="study-bottom">
        {!answerShown ? (
          <button className="show-answer-button" type="button" onClick={() => setAnswerShown(true)}>Show Answer</button>
        ) : (
          <div className="answer-grid" aria-label="Answer choices">
            <button className="answer-button again" type="button"><span>1m</span>Again</button>
            <button className="answer-button hard" type="button"><span>6m</span>Hard</button>
            <button className="answer-button good" type="button"><span>10m</span>Good</button>
            <button className="answer-button easy" type="button"><span>4d</span>Easy</button>
          </div>
        )}
        <div className="study-status-bar">
          <div className="study-counts" aria-label="Card counts">
            <span className="count-new">20</span>
            <span className="count-learn">0</span>
            <span className="count-review">42</span>
          </div>
          <ToolbarButton label="Tools" glyph="⚙" onClick={() => setScreen("tools")} />
        </div>
      </footer>
    </section>
  );
}

function BrowseScreen({ setScreen }: { setScreen: (screen: Screen) => void }) {
  return (
    <section className="anki-screen list-screen">
      <NavigationBar title="Browse" back="Decks" onBack={() => setScreen("decks")} trailing={<button className="anki-text-button" type="button">Select</button>} />
      <div className="browse-controls">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input defaultValue="deck:current" aria-label="Search cards" />
        </label>
        <div className="browse-toolbar">
          <button type="button">Filter</button>
          <button type="button">Options</button>
          <button type="button">Cards</button>
        </div>
      </div>
      <div className="browser-table">
        <div className="browser-header"><span>Front</span><span>Back</span></div>
        {browserRows.map(([front, back]) => (
          <button className="browser-row" type="button" key={front}>
            <span>{front}</span><span>{back}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function EditorScreen({ mode, deck, setScreen }: { mode: "Add" | "Edit"; deck: string; setScreen: (screen: Screen) => void }) {
  return (
    <section className="anki-screen editor-screen">
      <NavigationBar title={mode} back="Cancel" onBack={() => setScreen("study")} trailing={<button className="anki-text-button save-button" type="button">Save</button>} />
      <div className="editor-options">
        {mode === "Add" ? <button type="button"><span>Type</span><strong>Basic</strong><span>›</span></button> : null}
        {mode === "Add" ? <button type="button"><span>Deck</span><strong>{deck}</strong><span>›</span></button> : null}
        {mode === "Edit" ? <button type="button"><span>Tools</span><strong>Card actions</strong><span>›</span></button> : null}
      </div>
      <div className="field-editor">
        <label><span>Front</span><textarea defaultValue="der Hund" /></label>
        <label><span>Back</span><textarea defaultValue="the dog" /></label>
        <label><span>Tags</span><input defaultValue="german animals" /></label>
      </div>
      <div className="format-toolbar" aria-label="Formatting toolbar">
        <button type="button"><b>B</b></button>
        <button type="button"><i>I</i></button>
        <button type="button"><u>U</u></button>
        <button type="button">Fx</button>
        <button type="button">●</button>
        <button type="button">⌕+</button>
        <button type="button">√</button>
        <button type="button">◉</button>
        <button type="button">&lt;/&gt;</button>
      </div>
    </section>
  );
}

function SettingsScreen({ setScreen }: { setScreen: (screen: Screen) => void }) {
  const sections = [
    ["Syncing", "Sync Sounds & Images", "One-Way Sync"],
    ["Review", "Feedback Ticks", "Tools Overlay Button", "Audio Buttons", "Answer Keeps Zoom"],
    ["General", "Theme", "Profiles", "Backups", "Notifications"],
  ];

  return (
    <section className="anki-screen grouped-screen">
      <NavigationBar title="Preferences" back="Decks" onBack={() => setScreen("decks")} />
      <div className="grouped-content">
        {sections.map(([title, ...rows]) => (
          <section className="settings-section" key={title}>
            <h2>{title}</h2>
            <div className="settings-group">
              {rows.map((row, index) => (
                <button type="button" key={row}>
                  <span>{row}</span>
                  {row.includes("Ticks") || row.includes("Button") || row.includes("Audio") ? <span className="ios-switch on" /> : <span className="disclosure">›</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function StatsScreen({ setScreen }: { setScreen: (screen: Screen) => void }) {
  return (
    <section className="anki-screen grouped-screen">
      <NavigationBar title="Statistics" back="Decks" onBack={() => setScreen("decks")} />
      <div className="stats-content">
        <section className="stats-summary">
          <p>Today</p>
          <strong>126</strong>
          <span>reviews</span>
          <div className="stats-grid">
            <div><strong>18.4m</strong><span>Studied</span></div>
            <div><strong>8.7s</strong><span>Average</span></div>
            <div><strong>91%</strong><span>Again-free</span></div>
          </div>
        </section>
        <section className="chart-card">
          <h2>Reviews</h2>
          <div className="bar-chart" aria-label="Review chart placeholder">
            {[42, 68, 50, 86, 72, 92, 62].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
          </div>
          <div className="chart-labels"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
        </section>
        <section className="settings-group stats-links">
          <button type="button"><span>Card Counts</span><span className="disclosure">›</span></button>
          <button type="button"><span>Review Intervals</span><span className="disclosure">›</span></button>
          <button type="button"><span>Answer Buttons</span><span className="disclosure">›</span></button>
          <button type="button"><span>Future Due</span><span className="disclosure">›</span></button>
        </section>
      </div>
    </section>
  );
}

function ToolsScreen({ setScreen }: { setScreen: (screen: Screen) => void }) {
  const actions = ["Add", "Card Info", "Card Template", "Study Options", "Bury Card", "Bury Note", "Suspend Card", "Suspend Note", "Set Due Date", "Replay Audio", "Scratchpad", "Unbury Deck"];
  return (
    <section className="anki-screen grouped-screen">
      <NavigationBar title="Tools" back="Study" onBack={() => setScreen("study")} trailing={<div className="text-size-tools"><button type="button">A−</button><button type="button">A+</button></div>} />
      <div className="grouped-content">
        <section className="settings-section">
          <h2>Frequent Actions</h2>
          <div className="frequent-actions">
            {actions.slice(0, 4).map((action) => <button type="button" key={action}>{action}</button>)}
          </div>
        </section>
        <section className="settings-section">
          <h2>Actions</h2>
          <div className="settings-group">
            {actions.slice(4).map((action) => <button type="button" key={action}><span>{action}</span><span className="disclosure">›</span></button>)}
          </div>
        </section>
      </div>
    </section>
  );
}

function HelpScreen({ setScreen }: { setScreen: (screen: Screen) => void }) {
  return (
    <section className="anki-screen grouped-screen">
      <NavigationBar title="Help" back="Decks" onBack={() => setScreen("decks")} />
      <div className="help-content">
        <div className="anki-mark">A</div>
        <h2>AnkiMobile</h2>
        <p>This is the UI-only PWA recreation. Buttons navigate between representative AnkiMobile screens; study data and scheduling are intentionally still dummy data.</p>
        <div className="settings-group">
          <button type="button"><span>AnkiMobile Manual</span><span className="disclosure">›</span></button>
          <button type="button"><span>Support</span><span className="disclosure">›</span></button>
          <button type="button"><span>About</span><span className="disclosure">›</span></button>
        </div>
      </div>
    </section>
  );
}

export function AnkiMobileMock() {
  const [screen, setScreen] = useState<Screen>("decks");
  const [deck, setDeck] = useState("German B1");

  return (
    <main className="anki-mobile-app">
      {screen === "decks" ? <DeckList setScreen={setScreen} setDeck={setDeck} /> : null}
      {screen === "study" ? <StudyScreen deck={deck} setScreen={setScreen} /> : null}
      {screen === "browse" ? <BrowseScreen setScreen={setScreen} /> : null}
      {screen === "settings" ? <SettingsScreen setScreen={setScreen} /> : null}
      {screen === "stats" ? <StatsScreen setScreen={setScreen} /> : null}
      {screen === "add" ? <EditorScreen mode="Add" deck={deck} setScreen={setScreen} /> : null}
      {screen === "edit" ? <EditorScreen mode="Edit" deck={deck} setScreen={setScreen} /> : null}
      {screen === "tools" ? <ToolsScreen setScreen={setScreen} /> : null}
      {screen === "help" ? <HelpScreen setScreen={setScreen} /> : null}
    </main>
  );
}
