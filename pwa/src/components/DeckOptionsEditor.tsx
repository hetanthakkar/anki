"use client";

import { useEffect, useState } from "react";

import { getDeckOptions, resetDeckOptions, saveDeckOptions } from "@/lib/db/client";
import type { DeckOptions, DeckOptionsInput, DeckSummary } from "@/lib/db/types";

type Props = {
  deck: DeckSummary;
  onChanged: () => void | Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stepsText(steps: number[]) {
  return steps.join(" ");
}

function parseSteps(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const tokens = trimmed.split(/[\s,]+/);
  if (tokens.length > 10) throw new Error(`${label} can contain at most 10 steps`);
  return tokens.map((token) => {
    const minutes = Number(token);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) {
      throw new Error(`${label} must use whole minutes from 1 to 43200`);
    }
    return minutes;
  });
}

export function DeckOptionsEditor({ deck, onChanged }: Props) {
  const [options, setOptions] = useState<DeckOptions | null>(null);
  const [learningSteps, setLearningSteps] = useState("");
  const [relearningSteps, setRelearningSteps] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyOptions = (next: DeckOptions) => {
    setOptions(next);
    setLearningSteps(stepsText(next.learningStepsMinutes));
    setRelearningSteps(stepsText(next.relearningStepsMinutes));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessage(null);
    getDeckOptions(deck.id).then(
      (result) => {
        if (cancelled) return;
        applyOptions(result);
        setLoading(false);
      },
      (reason) => {
        if (cancelled) return;
        setError(errorMessage(reason));
        setLoading(false);
      }
    );
    return () => { cancelled = true; };
  }, [deck.id]);

  const updateNumber = (field: keyof DeckOptionsInput, value: string) => {
    if (!options) return;
    setOptions({ ...options, [field]: value === "" ? 0 : Number(value) });
    setMessage(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!options || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const input: DeckOptionsInput = {
        newCardsPerDay: options.newCardsPerDay,
        maximumReviewsPerDay: options.maximumReviewsPerDay,
        desiredRetentionPercent: options.desiredRetentionPercent,
        maximumIntervalDays: options.maximumIntervalDays,
        learningStepsMinutes: parseSteps(learningSteps, "Learning steps"),
        relearningStepsMinutes: parseSteps(relearningSteps, "Relearning steps")
      };
      applyOptions(await saveDeckOptions(deck.id, input));
      await onChanged();
      setMessage("Deck options saved.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaults = async () => {
    if (!options || options.usingDefaultPreset || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      applyOptions(await resetDeckOptions(deck.id));
      await onChanged();
      setMessage("Default options restored.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="panel deck-options-loading" role="status">Loading deck options...</div>;
  }

  if (!options) {
    return (
      <div className="panel error-panel" role="alert">
        <strong>Deck options could not be loaded</strong>
        <span>{error ?? "Try opening this screen again."}</span>
      </div>
    );
  }

  return (
    <form className="deck-options" onSubmit={save}>
      <section className="panel deck-options-intro">
        <div>
          <p className="eyebrow">SCHEDULING PRESET</p>
          <h2>{options.presetName}</h2>
          <p>{options.usingDefaultPreset
            ? "This deck currently follows the default preset. Saving creates an independent preset for this deck."
            : "This custom preset applies only to this deck. Subdecks keep their own presets."}</p>
        </div>
        <span className={options.usingDefaultPreset ? "options-badge" : "options-badge custom"}>
          {options.usingDefaultPreset ? "Default" : "Custom"}
        </span>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading">
          <strong>Daily limits</strong>
          <span>Control how much appears each day</span>
        </div>
        <div className="deck-options-grid">
          <label htmlFor="new-cards-per-day">
            <span>New cards per day</span>
            <input id="new-cards-per-day" type="number" min="0" max="9999" step="1"
              value={options.newCardsPerDay} disabled={saving}
              onChange={(event) => updateNumber("newCardsPerDay", event.target.value)} />
            <small>Set to 0 to pause new cards.</small>
          </label>
          <label htmlFor="reviews-per-day">
            <span>Maximum reviews per day</span>
            <input id="reviews-per-day" type="number" min="0" max="9999" step="1"
              value={options.maximumReviewsPerDay} disabled={saving}
              onChange={(event) => updateNumber("maximumReviewsPerDay", event.target.value)} />
            <small>Learning cards are never blocked by this limit.</small>
          </label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading">
          <strong>FSRS</strong>
          <span>Balance memory and workload</span>
        </div>
        <div className="deck-options-grid">
          <label htmlFor="desired-retention">
            <span>Desired retention</span>
            <div className="input-suffix">
              <input id="desired-retention" type="number" min="70" max="99" step="0.1"
                value={options.desiredRetentionPercent} disabled={saving}
                onChange={(event) => updateNumber("desiredRetentionPercent", event.target.value)} />
              <span>%</span>
            </div>
            <small>Higher retention schedules reviews more often.</small>
          </label>
          <label htmlFor="maximum-interval">
            <span>Maximum interval</span>
            <div className="input-suffix">
              <input id="maximum-interval" type="number" min="1" max="36500" step="1"
                value={options.maximumIntervalDays} disabled={saving}
                onChange={(event) => updateNumber("maximumIntervalDays", event.target.value)} />
              <span>days</span>
            </div>
            <small>No review interval will exceed this value.</small>
          </label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading">
          <strong>Learning steps</strong>
          <span>Whole minutes, separated by spaces</span>
        </div>
        <div className="deck-options-grid">
          <label htmlFor="learning-steps">
            <span>New cards</span>
            <input id="learning-steps" inputMode="numeric" value={learningSteps} disabled={saving}
              onChange={(event) => { setLearningSteps(event.target.value); setMessage(null); }} placeholder="1 10" />
            <small>Example: 1 10 means one minute, then ten minutes.</small>
          </label>
          <label htmlFor="relearning-steps">
            <span>After a lapse</span>
            <input id="relearning-steps" inputMode="numeric" value={relearningSteps} disabled={saving}
              onChange={(event) => { setRelearningSteps(event.target.value); setMessage(null); }} placeholder="10" />
            <small>Leave blank to return lapsed cards directly to review.</small>
          </label>
        </div>
      </section>

      {error && <p className="panel form-error" role="alert">{error}</p>}
      {message && <p className="panel form-success" role="status">{message}</p>}
      <div className="deck-options-actions">
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save options"}
        </button>
        <button className="secondary-button" type="button" disabled={saving || options.usingDefaultPreset}
          onClick={() => void restoreDefaults()}>Restore defaults</button>
      </div>
    </form>
  );
}

