"use client";

import { useEffect, useState } from "react";

import {
  applyDeckPreset,
  applyDeckPresetToSubdecks,
  createDeckPreset,
  deleteDeckPreset,
  getDeckOptions,
  listDeckPresets,
  renameDeckPreset,
  resetDeckOptions,
  saveDeckOptions
} from "@/lib/db/client";
import type { DeckOptions, DeckOptionsInput, DeckPresetSummary, DeckSummary } from "@/lib/db/types";

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
  const [fsrsWeights, setFsrsWeights] = useState("");
  const [presets, setPresets] = useState<DeckPresetSummary[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyOptions = (next: DeckOptions) => {
    setOptions(next);
    setLearningSteps(stepsText(next.learningStepsMinutes));
    setRelearningSteps(stepsText(next.relearningStepsMinutes));
    setFsrsWeights(next.fsrsWeights.join(", "));
    setSelectedPresetId(next.presetId);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessage(null);
    Promise.all([getDeckOptions(deck.id), listDeckPresets()]).then(
      ([result, availablePresets]) => {
        if (cancelled) return;
        applyOptions(result);
        setPresets(availablePresets);
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

  const updateOption = <K extends keyof DeckOptionsInput>(field: K, value: DeckOptionsInput[K]) => {
    if (!options) return;
    setOptions({ ...options, [field]: value });
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
        relearningStepsMinutes: parseSteps(relearningSteps, "Relearning steps"),
        newCardGatherOrder: options.newCardGatherOrder,
        newCardSortOrder: options.newCardSortOrder,
        newCardReviewOrder: options.newCardReviewOrder,
        interdayLearningReviewOrder: options.interdayLearningReviewOrder,
        reviewOrder: options.reviewOrder,
        buryNewSiblings: options.buryNewSiblings,
        buryReviewSiblings: options.buryReviewSiblings,
        buryInterdayLearningSiblings: options.buryInterdayLearningSiblings,
        leechThreshold: options.leechThreshold,
        leechAction: options.leechAction,
        minimumLapseIntervalDays: options.minimumLapseIntervalDays,
        maximumAnswerSeconds: options.maximumAnswerSeconds,
        showAnswerTimer: options.showAnswerTimer,
        stopTimerOnAnswer: options.stopTimerOnAnswer,
        fsrsWeights: fsrsWeights.split(/[\s,]+/).filter(Boolean).map(Number),
        newCardInsertOrder: options.newCardInsertOrder,
        secondsToShowQuestion: options.secondsToShowQuestion,
        secondsToShowAnswer: options.secondsToShowAnswer,
        questionTimeAction: options.questionTimeAction,
        answerTimeAction: options.answerTimeAction,
        newCardsIgnoreReviewLimit: options.newCardsIgnoreReviewLimit,
        limitsStartFromTop: options.limitsStartFromTop
      };
      applyOptions(await saveDeckOptions(deck.id, input));
      setPresets(await listDeckPresets());
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
      setPresets(await listDeckPresets());
      await onChanged();
      setMessage("Default options restored.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = async () => {
    if (selectedPresetId === null || selectedPresetId === options?.presetId || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      applyOptions(await applyDeckPreset(deck.id, selectedPresetId));
      setPresets(await listDeckPresets());
      await onChanged();
      setMessage("Preset applied to this deck.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const applyPresetToSubdecks = async () => {
    if (selectedPresetId === null || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      applyOptions(await applyDeckPresetToSubdecks(deck.id, selectedPresetId));
      setPresets(await listDeckPresets());
      await onChanged();
      setMessage("Preset applied to this deck and its subdecks.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const createPreset = async () => {
    if (selectedPresetId === null || saving) return;
    const name = window.prompt("Name the new preset:");
    if (name === null) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const created = await createDeckPreset(name, selectedPresetId);
      applyOptions(await applyDeckPreset(deck.id, created.id));
      setPresets(await listDeckPresets());
      await onChanged();
      setMessage(`Created and applied “${created.name}”.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const renamePreset = async () => {
    const selected = presets.find((preset) => preset.id === selectedPresetId);
    if (!selected || saving) return;
    const name = window.prompt("Rename this preset:", selected.name);
    if (name === null || name.trim() === selected.name) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await renameDeckPreset(selected.id, name);
      const available = await listDeckPresets();
      setPresets(available);
      if (selected.id === options?.presetId) applyOptions(await getDeckOptions(deck.id));
      setMessage("Preset renamed.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const deletePreset = async () => {
    const selected = presets.find((preset) => preset.id === selectedPresetId);
    if (!selected || selected.isDefault || saving) return;
    if (!window.confirm(`Delete “${selected.name}”? Decks using it will switch to the default preset.`)) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await deleteDeckPreset(selected.id);
      applyOptions(await getDeckOptions(deck.id));
      setPresets(await listDeckPresets());
      await onChanged();
      setMessage("Preset deleted. Affected decks now use the default preset.");
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
        <div className="deck-options-preset-summary">
          <div className="deck-options-preset-title">
            <div>
              <p className="eyebrow">SCHEDULING PRESET</p>
              <h2>{options.presetName}</h2>
            </div>
            <span className={options.usingDefaultPreset ? "options-badge" : "options-badge custom"}>
              {options.usingDefaultPreset ? "Default" : "Custom"}
            </span>
          </div>
          <p>{options.usingDefaultPreset
            ? "This deck follows the default preset. Saving creates a new preset for this deck."
            : `Changes to this preset affect all ${presets.find((preset) => preset.id === options.presetId)?.useCount ?? 1} deck(s) using it.`}</p>
        </div>
        <div className="deck-preset-picker">
          <label htmlFor="deck-preset">Preset</label>
          <select id="deck-preset" value={selectedPresetId ?? options.presetId} disabled={saving}
            onChange={(event) => setSelectedPresetId(Number(event.target.value))}>
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} ({preset.useCount})</option>)}
          </select>
          <button className="secondary-button" type="button" disabled={saving || selectedPresetId === options.presetId}
            onClick={() => void applyPreset()}>Apply preset</button>
          <div className="deck-preset-actions">
            <button type="button" disabled={saving} onClick={() => void createPreset()}>Add</button>
            <button type="button" disabled={saving || selectedPresetId === null} onClick={() => void renamePreset()}>Rename</button>
            <button type="button" disabled={saving || presets.find((preset) => preset.id === selectedPresetId)?.isDefault}
              onClick={() => void deletePreset()}>Delete</button>
            <button type="button" disabled={saving || selectedPresetId === null}
              onClick={() => void applyPresetToSubdecks()}>Apply to subdecks</button>
          </div>
        </div>
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
        <div className="deck-option-toggles">
          <label><input type="checkbox" checked={options.newCardsIgnoreReviewLimit} disabled={saving}
            onChange={(event) => updateOption("newCardsIgnoreReviewLimit", event.target.checked)} /><span><strong>New cards ignore review limit</strong><small>Show new cards even after the review limit has been filled.</small></span></label>
          <label><input type="checkbox" checked={options.limitsStartFromTop} disabled={saving}
            onChange={(event) => updateOption("limitsStartFromTop", event.target.checked)} /><span><strong>Limits start from top</strong><small>Apply parent limits when studying an individual subdeck.</small></span></label>
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

      <section className="panel deck-options-section">
        <div className="form-heading">
          <strong>Display order</strong>
          <span>Choose how new, learning, and review cards are gathered</span>
        </div>
        <div className="deck-options-grid">
          <label htmlFor="new-gather-order"><span>New card gather order</span>
            <select id="new-gather-order" value={options.newCardGatherOrder} disabled={saving}
              onChange={(event) => updateOption("newCardGatherOrder", event.target.value as DeckOptions["newCardGatherOrder"])}>
              <option value="deck">Deck, then position</option><option value="deckRandomNotes">Deck, then random notes</option><option value="ascending">Ascending position</option>
              <option value="descending">Descending position</option><option value="randomNotes">Random notes</option>
              <option value="randomCards">Random cards</option>
            </select><small>Controls which new cards enter today&apos;s queue.</small>
          </label>
          <label htmlFor="new-sort-order"><span>New card sort order</span>
            <select id="new-sort-order" value={options.newCardSortOrder} disabled={saving}
              onChange={(event) => updateOption("newCardSortOrder", event.target.value as DeckOptions["newCardSortOrder"])}>
              <option value="template">Card type, then gathered</option><option value="gather">Order gathered</option>
              <option value="templateRandom">Card type, then random</option><option value="randomNote">Random note, then card type</option>
              <option value="randomCard">Random card</option>
            </select><small>Sorts the gathered new cards before display.</small>
          </label>
          <label htmlFor="new-insert-order"><span>New card insertion order</span>
            <select id="new-insert-order" value={options.newCardInsertOrder} disabled={saving}
              onChange={(event) => updateOption("newCardInsertOrder", event.target.value as DeckOptions["newCardInsertOrder"])}>
              <option value="sequential">Sequential</option><option value="random">Random</option>
            </select><small>Controls where newly created cards are placed.</small>
          </label>
          <label htmlFor="new-review-order"><span>New cards</span>
            <select id="new-review-order" value={options.newCardReviewOrder} disabled={saving}
              onChange={(event) => updateOption("newCardReviewOrder", event.target.value as DeckOptions["newCardReviewOrder"])}>
              <option value="mix">Mix with reviews</option><option value="before">Before reviews</option><option value="after">After reviews</option>
            </select><small>Positions new cards relative to reviews.</small>
          </label>
          <label htmlFor="interday-review-order"><span>Interday learning cards</span>
            <select id="interday-review-order" value={options.interdayLearningReviewOrder} disabled={saving}
              onChange={(event) => updateOption("interdayLearningReviewOrder", event.target.value as DeckOptions["interdayLearningReviewOrder"])}>
              <option value="mix">Mix with reviews</option><option value="before">Before reviews</option><option value="after">After reviews</option>
            </select><small>Positions day-based learning cards relative to reviews.</small>
          </label>
          <label className="deck-option-wide" htmlFor="review-order"><span>Review sort order</span>
            <select id="review-order" value={options.reviewOrder} disabled={saving}
              onChange={(event) => updateOption("reviewOrder", event.target.value as DeckOptions["reviewOrder"])}>
              <option value="due">Due date</option><option value="dueDeck">Due date, then deck</option><option value="deckDue">Deck, then due date</option>
              <option value="intervalAscending">Ascending intervals</option><option value="intervalDescending">Descending intervals</option>
              <option value="easeAscending">Ascending ease</option><option value="easeDescending">Descending ease</option>
              <option value="retrievabilityAscending">Ascending retrievability</option><option value="retrievabilityDescending">Descending retrievability</option>
              <option value="relativeOverdueness">Relative overdueness</option><option value="random">Random</option>
              <option value="added">Order added</option><option value="reverseAdded">Reverse order added</option>
            </select><small>FSRS ease ordering uses card difficulty, matching Anki.</small>
          </label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading"><strong>Burying</strong><span>Keep related cards apart until the next study day</span></div>
        <div className="deck-option-toggles">
          <label><input type="checkbox" checked={options.buryNewSiblings} disabled={saving}
            onChange={(event) => updateOption("buryNewSiblings", event.target.checked)} /><span><strong>Bury new siblings</strong><small>Hide other new cards generated by the same note.</small></span></label>
          <label><input type="checkbox" checked={options.buryReviewSiblings} disabled={saving}
            onChange={(event) => updateOption("buryReviewSiblings", event.target.checked)} /><span><strong>Bury review siblings</strong><small>Hide related review cards until tomorrow.</small></span></label>
          <label><input type="checkbox" checked={options.buryInterdayLearningSiblings} disabled={saving}
            onChange={(event) => updateOption("buryInterdayLearningSiblings", event.target.checked)} /><span><strong>Bury interday-learning siblings</strong><small>Also separate related day-based learning cards.</small></span></label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading"><strong>Lapses and leeches</strong><span>Control repeated failures</span></div>
        <div className="deck-options-grid">
          <label htmlFor="minimum-lapse-interval"><span>Minimum lapse interval</span><div className="input-suffix">
            <input id="minimum-lapse-interval" type="number" min="1" max="36500" step="1" value={options.minimumLapseIntervalDays} disabled={saving}
              onChange={(event) => updateNumber("minimumLapseIntervalDays", event.target.value)} /><span>days</span></div>
            <small>Shortest interval after a lapsed card returns to review.</small></label>
          <label htmlFor="leech-threshold"><span>Leech threshold</span><input id="leech-threshold" type="number" min="0" max="99" step="1"
            value={options.leechThreshold} disabled={saving} onChange={(event) => updateNumber("leechThreshold", event.target.value)} />
            <small>Set to 0 to disable leech detection.</small></label>
          <label htmlFor="leech-action"><span>Leech action</span><select id="leech-action" value={options.leechAction} disabled={saving}
            onChange={(event) => updateOption("leechAction", event.target.value as DeckOptions["leechAction"])}>
            <option value="tag">Tag only</option><option value="suspend">Tag and suspend card</option></select>
            <small>Leeches receive the <code>leech</code> tag.</small></label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading"><strong>Timer</strong><span>Measure answer time the same way for every review</span></div>
        <div className="deck-options-grid">
          <label htmlFor="maximum-answer-seconds"><span>Maximum answer time</span><div className="input-suffix">
            <input id="maximum-answer-seconds" type="number" min="1" max="3600" step="1" value={options.maximumAnswerSeconds} disabled={saving}
              onChange={(event) => updateNumber("maximumAnswerSeconds", event.target.value)} /><span>seconds</span></div>
            <small>Longer answers are capped to this time in review history.</small></label>
        </div>
        <div className="deck-option-toggles">
          <label><input type="checkbox" checked={options.showAnswerTimer} disabled={saving}
            onChange={(event) => updateOption("showAnswerTimer", event.target.checked)} /><span><strong>Show on-screen timer</strong><small>Display elapsed time above the card.</small></span></label>
          <label><input type="checkbox" checked={options.stopTimerOnAnswer} disabled={saving || !options.showAnswerTimer}
            onChange={(event) => updateOption("stopTimerOnAnswer", event.target.checked)} /><span><strong>Stop timer when answer is shown</strong><small>Otherwise the timer continues until you rate the card.</small></span></label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading"><strong>Auto advance</strong><span>Optionally move through unattended reviews</span></div>
        <div className="deck-options-grid">
          <label htmlFor="question-seconds"><span>Show question for</span><div className="input-suffix">
            <input id="question-seconds" type="number" min="0" max="3600" step="0.1" value={options.secondsToShowQuestion} disabled={saving}
              onChange={(event) => updateNumber("secondsToShowQuestion", event.target.value)} /><span>seconds</span></div>
            <small>Set to 0 to disable the question action.</small></label>
          <label htmlFor="question-time-action"><span>Question action</span><select id="question-time-action" value={options.questionTimeAction} disabled={saving}
            onChange={(event) => updateOption("questionTimeAction", event.target.value as DeckOptions["questionTimeAction"])}>
            <option value="showAnswer">Show answer</option><option value="reminder">Show reminder</option></select></label>
          <label htmlFor="answer-seconds"><span>Show answer for</span><div className="input-suffix">
            <input id="answer-seconds" type="number" min="0" max="3600" step="0.1" value={options.secondsToShowAnswer} disabled={saving}
              onChange={(event) => updateNumber("secondsToShowAnswer", event.target.value)} /><span>seconds</span></div>
            <small>Set to 0 to disable the answer action.</small></label>
          <label htmlFor="answer-time-action"><span>Answer action</span><select id="answer-time-action" value={options.answerTimeAction} disabled={saving}
            onChange={(event) => updateOption("answerTimeAction", event.target.value as DeckOptions["answerTimeAction"])}>
            <option value="bury">Bury card</option><option value="again">Answer Again</option><option value="hard">Answer Hard</option>
            <option value="good">Answer Good</option><option value="reminder">Show reminder</option></select></label>
        </div>
      </section>

      <section className="panel deck-options-section">
        <div className="form-heading"><strong>FSRS parameters</strong><span>{options.fsrsWeights.length} weights used by the scheduler</span></div>
        <label className="deck-options-weights" htmlFor="fsrs-weights"><span>Parameters</span>
          <textarea id="fsrs-weights" rows={4} value={fsrsWeights} disabled={saving}
            onChange={(event) => { setFsrsWeights(event.target.value); setMessage(null); }} />
          <small>Comma- or space-separated FSRS-6 parameters. Keep the defaults unless you have optimized parameters from Anki.</small>
        </label>
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
