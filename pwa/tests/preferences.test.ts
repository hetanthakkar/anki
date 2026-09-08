import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_APP_PREFERENCES,
  normalizePreferences,
  resolvedTheme
} from "../src/lib/preferences";

test("preferences use complete defaults for missing or corrupt values", () => {
  assert.deepEqual(normalizePreferences(null), DEFAULT_APP_PREFERENCES);
  assert.deepEqual(normalizePreferences("not an object"), DEFAULT_APP_PREFERENCES);
});

test("preferences preserve supported choices and boolean overrides", () => {
  assert.deepEqual(normalizePreferences({
    theme: "dark",
    density: "compact",
    locale: "es",
    reduceMotion: true,
    showReviewProgress: false,
    showAnswerTimes: false,
    keyboardShortcuts: false,
    autoPlayAudio: false,
    showAudioControls: false
  }), {
    theme: "dark",
    density: "compact",
    locale: "es",
    reduceMotion: true,
    showReviewProgress: false,
    showAnswerTimes: false,
    keyboardShortcuts: false,
    autoPlayAudio: false,
    showAudioControls: false
  });
});

test("preferences reject unsupported enum and non-boolean values", () => {
  assert.deepEqual(normalizePreferences({
    theme: "purple",
    density: "tiny",
    reduceMotion: "yes",
    showAnswerTimes: 0
  }), DEFAULT_APP_PREFERENCES);
});

test("system theme follows the device while explicit themes win", () => {
  assert.equal(resolvedTheme("system", true), "dark");
  assert.equal(resolvedTheme("system", false), "light");
  assert.equal(resolvedTheme("light", true), "light");
  assert.equal(resolvedTheme("dark", false), "dark");
});
