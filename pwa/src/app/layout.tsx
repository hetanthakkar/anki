import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { PwaRegister } from "@/components/PwaRegister";
import { ReviewerEnhancements } from "@/components/ReviewerEnhancements";

import "./globals.css";
import "./reviewer.css";

export const metadata: Metadata = {
  title: "Anki PWA",
  description: "Offline-first flashcards in a browser-installed PWA.",
  applicationName: "Anki PWA",
  appleWebApp: {
    capable: true,
    title: "Anki PWA",
    statusBarStyle: "default"
  },
  formatDetection: {
    telephone: false
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1f6fd1"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PwaRegister />
        <ReviewerEnhancements />
        {children}
      </body>
    </html>
  );
}
