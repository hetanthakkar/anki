"use client";

import { useEffect, useMemo, useState } from "react";

import { getCollectionStats } from "@/lib/db/client";
import type { CollectionStats, DeckSummary } from "@/lib/db/types";

type StatsState =
  | { status: "loading" }
  | { status: "ready"; data: CollectionStats }
  | { status: "error"; message: string };

function duration(timeMs: number) {
  if (timeMs < 60_000) return timeMs ? Math.max(1, Math.round(timeMs / 1_000)) + " sec" : "0 min";
  const minutes = Math.round(timeMs / 60_000);
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours + "h" + (remainder ? " " + remainder + "m" : "");
}

function dayLabel(date: string) {
  return new Date(date + "T12:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
}

export function StatsDashboard({ decks }: { decks: DeckSummary[] }) {
  const [deckId, setDeckId] = useState<number | null>(null);
  const [state, setState] = useState<StatsState>({ status: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getCollectionStats(deckId).then(
      (data) => { if (!cancelled) setState({ status: "ready", data }); },
      (error) => {
        if (!cancelled) setState({
          status: "error",
          message: error instanceof Error ? error.message : "Statistics could not be loaded."
        });
      }
    );
    return () => { cancelled = true; };
  }, [deckId, reload]);

  const maxDaily = useMemo(() => state.status === "ready"
    ? Math.max(1, ...state.data.daily.map((day) => day.reviews)) : 1, [state]);

  return (
    <section className="stats-dashboard">
      <div className="stats-toolbar">
        <label htmlFor="stats-deck">Showing</label>
        <select id="stats-deck" value={deckId ?? ""} onChange={(event) => {
          setDeckId(event.target.value ? Number(event.target.value) : null);
        }}>
          <option value="">Entire collection</option>
          {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
        </select>
        <button className="secondary-button" type="button" disabled={state.status === "loading"}
          onClick={() => setReload((value) => value + 1)}>Refresh</button>
      </div>

      {state.status === "loading" && <div className="panel stats-loading" role="status">Calculating your progress...</div>}
      {state.status === "error" && (
        <div className="panel error-panel" role="alert">
          <strong>Statistics could not be loaded</strong>
          <span>{state.message}</span>
          <button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
        </div>
      )}
      {state.status === "ready" && (
        <>
          <p className="stats-scope">{state.data.scopeName}</p>
          <div className="stats-summary-grid">
            <article className="panel stats-summary">
              <span>Reviews today</span>
              <strong>{state.data.today.reviews}</strong>
              <small>{duration(state.data.today.timeMs)} studied</small>
            </article>
            <article className="panel stats-summary">
              <span>30-day retention</span>
              <strong>{state.data.last30Days.retentionPercent === null ? "-" : state.data.last30Days.retentionPercent + "%"}</strong>
              <small>{state.data.last30Days.reviews} answers</small>
            </article>
            <article className="panel stats-summary">
              <span>Current streak</span>
              <strong>{state.data.streak.current}</strong>
              <small>{state.data.streak.current === 1 ? "day" : "days"} (best {state.data.streak.longest})</small>
            </article>
            <article className="panel stats-summary">
              <span>30-day study time</span>
              <strong>{duration(state.data.last30Days.timeMs)}</strong>
              <small>{state.data.last30Days.reviews} reviews</small>
            </article>
          </div>

          <article className="panel stats-section">
            <div className="stats-section-heading">
              <div><h2>Daily activity</h2><p>Reviews completed over the last 14 days</p></div>
              <strong>{state.data.last30Days.reviews}</strong>
            </div>
            <div className="stats-chart" role="img" aria-label="Daily reviews for the last 14 days">
              {state.data.daily.map((day) => (
                <div className="stats-chart-day" key={day.date}
                  aria-label={day.date + ": " + day.reviews + " reviews, " + duration(day.timeMs)}>
                  <span className="stats-bar-value">{day.reviews || ""}</span>
                  <span className={day.reviews ? "stats-bar" : "stats-bar stats-bar-empty"}
                    style={{ height: Math.max(day.reviews ? 8 : 3, day.reviews / maxDaily * 100) + "%" }} />
                  <span className="stats-day-label">{dayLabel(day.date)}</span>
                </div>
              ))}
            </div>
          </article>

          <div className="stats-detail-grid">
            <article className="panel stats-section">
              <div className="stats-section-heading"><div><h2>Answers</h2><p>Last 30 days</p></div></div>
              <div className="stats-answer-list">
                {([
                  ["Again", state.data.last30Days.answers.again, "again"],
                  ["Hard", state.data.last30Days.answers.hard, "hard"],
                  ["Good", state.data.last30Days.answers.good, "good"],
                  ["Easy", state.data.last30Days.answers.easy, "easy"]
                ] as const).map(([label, count, kind]) => (
                  <div className="stats-answer" key={kind}>
                    <span>{label}</span>
                    <span className="stats-answer-track"><span className={"stats-answer-fill stats-answer-" + kind}
                      style={{ width: (state.data.last30Days.reviews ? count / state.data.last30Days.reviews * 100 : 0) + "%" }} /></span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel stats-section">
              <div className="stats-section-heading"><div><h2>Card states</h2><p>{state.data.cards.total} cards total</p></div></div>
              <dl className="stats-card-states">
                <div><dt>New</dt><dd>{state.data.cards.new}</dd></div>
                <div><dt>Learning</dt><dd>{state.data.cards.learning}</dd></div>
                <div><dt>Review</dt><dd>{state.data.cards.review}</dd></div>
                <div><dt>Suspended</dt><dd>{state.data.cards.suspended}</dd></div>
                <div><dt>Buried</dt><dd>{state.data.cards.buried}</dd></div>
              </dl>
            </article>
          </div>
        </>
      )}
    </section>
  );
}
