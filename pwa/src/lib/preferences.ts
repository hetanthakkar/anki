export type ThemePreference = "system" | "light" | "dark";
export type DensityPreference = "comfortable" | "compact";
export type LocalePreference = "system" | "en" | "es";

export type AppPreferences = {
  theme: ThemePreference;
  density: DensityPreference;
  locale: LocalePreference;
  reduceMotion: boolean;
  showReviewProgress: boolean;
  showAnswerTimes: boolean;
  keyboardShortcuts: boolean;
  autoPlayAudio: boolean;
  showAudioControls: boolean;
};

export const APP_PREFERENCES_KEY = "anki-pwa.preferences.v1";

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  theme: "light",
  density: "comfortable",
  locale: "system",
  reduceMotion: false,
  showReviewProgress: true,
  showAnswerTimes: true,
  keyboardShortcuts: true,
  autoPlayAudio: true,
  showAudioControls: true
};

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizePreferences(value: unknown): AppPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<AppPreferences> : {};
  return {
    theme: candidate.theme === "system" || candidate.theme === "light" || candidate.theme === "dark"
      ? candidate.theme
      : DEFAULT_APP_PREFERENCES.theme,
    density: candidate.density === "compact" ? "compact" : "comfortable",
    locale: candidate.locale === "en" || candidate.locale === "es" ? candidate.locale : "system",
    reduceMotion: booleanValue(candidate.reduceMotion, DEFAULT_APP_PREFERENCES.reduceMotion),
    showReviewProgress: booleanValue(candidate.showReviewProgress, DEFAULT_APP_PREFERENCES.showReviewProgress),
    showAnswerTimes: booleanValue(candidate.showAnswerTimes, DEFAULT_APP_PREFERENCES.showAnswerTimes),
    keyboardShortcuts: booleanValue(candidate.keyboardShortcuts, DEFAULT_APP_PREFERENCES.keyboardShortcuts),
    autoPlayAudio: booleanValue(candidate.autoPlayAudio, DEFAULT_APP_PREFERENCES.autoPlayAudio),
    showAudioControls: booleanValue(candidate.showAudioControls, DEFAULT_APP_PREFERENCES.showAudioControls)
  };
}

export function loadPreferences(): AppPreferences {
  if (typeof window === "undefined") return DEFAULT_APP_PREFERENCES;
  try {
    const value = window.localStorage.getItem(APP_PREFERENCES_KEY);
    return value ? normalizePreferences(JSON.parse(value)) : DEFAULT_APP_PREFERENCES;
  } catch {
    return DEFAULT_APP_PREFERENCES;
  }
}

export function savePreferences(preferences: AppPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still apply for this tab when storage is unavailable.
  }
}

export function resolvedTheme(theme: ThemePreference, systemDark: boolean) {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function applyPreferences(preferences: AppPreferences, systemDark: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(preferences.theme, systemDark);
  root.dataset.themePreference = preferences.theme;
  root.dataset.density = preferences.density;
  root.lang = preferences.locale === "system" ? navigator.language : preferences.locale;
  root.dataset.reduceMotion = String(preferences.reduceMotion);
}
