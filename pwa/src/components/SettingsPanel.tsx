"use client";

import { useState } from "react";

import type { LocalCollectionInfo } from "@/lib/db/types";
import type { AppPreferences } from "@/lib/preferences";
import { CollectionBackup } from "./CollectionBackup";
import { CloudSyncPanel } from "./CloudSyncPanel";

type Props = {
  info: LocalCollectionInfo;
  preferences: AppPreferences;
  onChange: (patch: Partial<AppPreferences>) => void;
  onReset: () => void;
  onBusyChange: (busy: boolean) => void;
  onManageNoteTypes: () => void;
  onCollectionRestored: () => Promise<void>;
};

type ToggleProps = {
  checked: boolean;
  className?: string;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
};

function PreferenceToggle({ checked, className = "", description, label, onChange }: ToggleProps) {
  return (
    <label className={`preference-toggle ${className}`}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked}
        onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span>
    </label>
  );
}

export function SettingsPanel({ info, preferences, onChange, onReset, onBusyChange, onManageNoteTypes, onCollectionRestored }: Props) {
  const [notice, setNotice] = useState("Changes save automatically on this device.");

  const update = (patch: Partial<AppPreferences>) => {
    onChange(patch);
    setNotice("Preferences saved.");
  };

  const reset = () => {
    onReset();
    setNotice("Default preferences restored.");
  };

  return (
    <section className="settings-page">
      <section className="panel settings-section settings-preferences" aria-labelledby="preferences-settings">
        <div className="settings-section-heading">
          <span className="settings-section-icon" aria-hidden="true">Aa</span>
          <div><h2 id="preferences-settings">Study preferences</h2><p>Appearance, review, and audio in one place.</p></div>
        </div>
        <div className="settings-subsection-heading"><h3>Appearance</h3></div>
        <div className="preference-select-grid">
          <label htmlFor="theme-preference">
            <span>Theme</span>
            <select id="theme-preference" value={preferences.theme}
              onChange={(event) => update({ theme: event.target.value as AppPreferences["theme"] })}>
              <option value="system">Match this device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label htmlFor="density-preference">
            <span>Interface density</span>
            <select id="density-preference" value={preferences.density}
              onChange={(event) => update({ density: event.target.value as AppPreferences["density"] })}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          {/* <label htmlFor="locale-preference">
            <span>Language & regional format</span>
            <select id="locale-preference" value={preferences.locale}
              onChange={(event) => update({ locale: event.target.value as AppPreferences["locale"] })}>
              <option value="system">Match this device</option>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label> */}
        </div>
        <PreferenceToggle label="Reduce motion" checked={preferences.reduceMotion}
          description="Disables card flips and other interface animations."
          onChange={(reduceMotion) => update({ reduceMotion })} />
        <div className="settings-subsection-heading"><h3>Review</h3></div>
        <PreferenceToggle label="Show session progress" checked={preferences.showReviewProgress}
          description="Shows completed reviews and deck progress beneath the card."
          onChange={(showReviewProgress) => update({ showReviewProgress })} />
        <PreferenceToggle label="Show next review times" checked={preferences.showAnswerTimes}
          description="Displays the interval beneath Again, Hard, Good, and Easy."
          onChange={(showAnswerTimes) => update({ showAnswerTimes })} />
        <PreferenceToggle className="keyboard-preference" label="Keyboard shortcuts" checked={preferences.keyboardShortcuts}
          description="Answer, edit, replay, flag, bury, suspend, and undo without leaving the keyboard."
          onChange={(keyboardShortcuts) => update({ keyboardShortcuts })} />
        <div className="shortcut-reference keyboard-shortcut-reference" aria-label="Review keyboard shortcuts">
          <span><kbd>Space</kbd><small>Show / Good</small></span>
          <span><kbd>1</kbd><small>Again</small></span>
          <span><kbd>2</kbd><small>Hard</small></span>
          <span><kbd>3</kbd><small>Good</small></span>
          <span><kbd>4</kbd><small>Easy</small></span>
          <span><kbd>E</kbd><small>Edit</small></span>
          <span><kbd>R</kbd><small>Replay</small></span>
          <span><kbd>M</kbd><small>Mark</small></span>
          <span><kbd>Z</kbd><small>Undo</small></span>
          <span><kbd>Ctrl 1–7</kbd><small>Flag</small></span>
          <span><kbd>- / =</kbd><small>Bury card / note</small></span>
          <span><kbd>@ / !</kbd><small>Suspend card / note</small></span>
        </div>
        <div className="settings-subsection-heading"><h3>Audio</h3></div>
        <PreferenceToggle label="Play audio automatically" checked={preferences.autoPlayAudio}
          description="Starts front and answer audio when that side becomes visible."
          onChange={(autoPlayAudio) => update({ autoPlayAudio })} />
        <PreferenceToggle label="Show audio controls" checked={preferences.showAudioControls}
          description="Keeps replay and playback controls visible on cards."
          onChange={(showAudioControls) => update({ showAudioControls })} />
      </section>

      <section className="panel settings-section collection-settings" aria-labelledby="collection-settings">
        <div className="settings-section-heading">
          <span className="settings-section-icon" aria-hidden="true">S</span>
          <div><h2 id="collection-settings">Collection</h2><p>Storage, backups, media, and your private cloud snapshot.</p></div>
        </div>
        <dl className="storage-details">
          <div><dt>Collection</dt><dd><span className={info.persistent ? "status-dot good" : "status-dot warning"} />{info.persistent ? "Persistent offline storage" : "Temporary memory"}</dd></div>
          <div><dt>Database</dt><dd>Anki schema {info.schemaVersion}</dd></div>
          <div><dt>SQLite</dt><dd>{info.sqliteVersion}</dd></div>
        </dl>
        <CollectionBackup persistent={info.persistent} onBusyChange={onBusyChange} onRestored={onCollectionRestored}
          afterBackup={<CloudSyncPanel embedded onBusyChange={onBusyChange} onRestored={onCollectionRestored} />} />
      </section>

      <section className="panel settings-section" aria-labelledby="note-type-settings">
        <div className="settings-section-heading">
          <span className="settings-section-icon" aria-hidden="true">T</span>
          <div><h2 id="note-type-settings">Note types</h2><p>Create and edit fields, templates, and card styling.</p></div>
        </div>
        <div className="settings-action-row">
          <div><strong>Manage note types</strong><span>Changes are stored in your local Anki collection.</span></div>
          <button className="secondary-button" type="button" onClick={onManageNoteTypes}>Open manager</button>
        </div>
      </section>

      <div className="settings-reset">
        <div><strong>Reset preferences</strong><span>Returns appearance, review, and audio behavior to their defaults. Your cards are not changed.</span></div>
        <button className="secondary-button" type="button" onClick={reset}>Restore defaults</button>
      </div>
    </section>
  );
}
