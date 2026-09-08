"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  APP_PREFERENCES_KEY,
  applyPreferences,
  DEFAULT_APP_PREFERENCES,
  loadPreferences,
  normalizePreferences,
  resolvedTheme,
  savePreferences
} from "@/lib/preferences";
import type { AppPreferences } from "@/lib/preferences";

export function useAppPreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const stored = loadPreferences();
    setSystemDark(media.matches);
    setPreferences(stored);
    applyPreferences(stored, media.matches);

    const handleSchemeChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== APP_PREFERENCES_KEY) return;
      setPreferences(loadPreferences());
    };
    media.addEventListener("change", handleSchemeChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      media.removeEventListener("change", handleSchemeChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    applyPreferences(preferences, systemDark);
  }, [preferences, systemDark]);

  const updatePreferences = useCallback((patch: Partial<AppPreferences>) => {
    setPreferences((current) => {
      const next = normalizePreferences({ ...current, ...patch });
      savePreferences(next);
      return next;
    });
  }, []);

  const resetPreferences = useCallback(() => {
    const next = { ...DEFAULT_APP_PREFERENCES };
    savePreferences(next);
    setPreferences(next);
  }, []);

  return useMemo(() => ({
    preferences,
    resolvedTheme: resolvedTheme(preferences.theme, systemDark),
    updatePreferences,
    resetPreferences
  }), [preferences, resetPreferences, systemDark, updatePreferences]);
}
