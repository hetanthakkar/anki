import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Anki PWA",
    short_name: "Anki",
    description: "Offline-first flashcards with Anki-compatible concepts.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#edf4fa",
    theme_color: "#edf4fa",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      },
      {
        src: "/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable"
      }
    ]
  };
}
