import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";

import { PwaRegister } from "@/components/PwaRegister";

import "./globals.css";
import "./reviewer.css";

export const metadata: Metadata = {
  title: "Anki PWA",
  description: "Offline-first flashcards in a browser-installed PWA.",
  applicationName: "Anki PWA",
  appleWebApp: {
    capable: true,
    title: "Anki PWA",
    statusBarStyle: "black-translucent"
  },
  formatDetection: {
    telephone: false
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f0fdf4"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Script id="standalone-viewport-height" strategy="beforeInteractive">{`
          (() => {
            if (!navigator.standalone) return;
            const setHeight = () => {
              const portrait = matchMedia("(orientation: portrait)").matches;
              const screenHeight = portrait
                ? Math.max(screen.width, screen.height)
                : Math.min(screen.width, screen.height);
              document.documentElement.style.setProperty(
                "--app-height", Math.max(window.innerHeight, screenHeight) + "px"
              );
            };
            setHeight();
            addEventListener("resize", setHeight);
            addEventListener("orientationchange", setHeight);
          })();
        `}</Script>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
