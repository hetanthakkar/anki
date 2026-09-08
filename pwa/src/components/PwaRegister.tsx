"use client";

import { useEffect } from "react";

const HEAL_KEY = "anki-pwa-service-worker-healed";

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      // A previously installed production worker can otherwise serve stale
      // client bundles while developing on the same localhost origin.
      const removeDevelopmentWorker = async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations
          .filter((registration) => registration.scope.startsWith(window.location.origin))
          .map((registration) => registration.unregister()));
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
          .filter((name) => name.startsWith("anki-pwa-shell-"))
          .map((name) => caches.delete(name)));
      };
      void removeDevelopmentWorker();
      return;
    }

    let removeUpdateListeners = () => {};

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (navigator.storage?.persist) {
          await navigator.storage.persist();
        }

        // Service workers normally notice an updated script on their own. An
        // installed iOS app can stay suspended on an old shell for days though,
        // so compare an uncached server build stamp whenever it returns to the
        // foreground. If the ordinary update path has not caught up after five
        // seconds, remove only app-shell caches and reload. Local SQLite/OPFS
        // collection data is not in Cache Storage and is never touched here.
        const checkForDeployment = async () => {
          if (document.visibilityState !== "visible") return;
          void registration.update().catch(() => {});
          try {
            const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
            const current = (await response.json() as { id?: string }).id;
            const running = process.env.NEXT_PUBLIC_APP_BUILD_ID;
            if (!current || !running || current === running) {
              sessionStorage.removeItem(HEAL_KEY);
              return;
            }
            if (sessionStorage.getItem(HEAL_KEY) === current) return;
            sessionStorage.setItem(HEAL_KEY, current);
            window.setTimeout(async () => {
              const registrations = await navigator.serviceWorker.getRegistrations();
              await Promise.all(registrations
                .filter((item) => item.scope.startsWith(window.location.origin))
                .map((item) => item.unregister()));
              const cacheNames = await caches.keys();
              await Promise.all(cacheNames
                .filter((name) => name.startsWith("anki-pwa-shell-"))
                .map((name) => caches.delete(name)));
              window.location.reload();
            }, 5_000);
          } catch {
            // Offline is a valid PWA state. Keep the current local shell.
          }
        };

        document.addEventListener("visibilitychange", checkForDeployment);
        window.addEventListener("pageshow", checkForDeployment);
        window.addEventListener("focus", checkForDeployment);
        const interval = window.setInterval(() => void checkForDeployment(), 60_000);
        removeUpdateListeners = () => {
          document.removeEventListener("visibilitychange", checkForDeployment);
          window.removeEventListener("pageshow", checkForDeployment);
          window.removeEventListener("focus", checkForDeployment);
          window.clearInterval(interval);
        };
        void checkForDeployment();
      } catch (error) {
        console.error("PWA registration failed", error);
      }
    };

    void register();
    return () => removeUpdateListeners();
  }, []);

  return null;
}
