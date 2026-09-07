"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CENTERING_STYLE = `<style id="reviewer-card-centering">
html,body{height:100%!important;min-height:100%!important;}
body.card{box-sizing:border-box!important;margin:0!important;padding:28px 22px!important;}
.review-card-center{box-sizing:border-box;display:flex;min-height:calc(100vh - 56px);width:100%;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
.review-card-center>*{max-width:100%;}
.review-card-center>hr{width:100%;}
.review-card-center img,.review-card-center video,.review-card-center audio{margin-left:auto!important;margin-right:auto!important;}
</style>`;

function parseCount(value: string | null) {
  const match = value?.match(/(\d+)\s+of\s+(\d+)/i);
  return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
}

function remainingCards(reviewer: HTMLElement) {
  const counts = Array.from(reviewer.querySelectorAll<HTMLElement>(".review-stat-count")).map((node) => parseCount(node.textContent));
  if (counts.length >= 3 && counts[0] && counts[1] && counts[2]) {
    const mastered = counts[0];
    const reviewing = counts[1];
    const learning = counts[2];
    const newCards = Math.max(0, mastered.total - mastered.current);
    return Math.max(0, newCards + reviewing.current + learning.current);
  }
  return 0;
}

function centeredDocument(source: string) {
  if (!source || source.includes("reviewer-card-centering")) return source;
  if (!source.includes('<body class="card">') || !source.includes("</body>")) return source;

  return source
    .replace("</head>", `${CENTERING_STYLE}</head>`)
    .replace('<body class="card">', '<body class="card"><div class="review-card-center">')
    .replace("</body>", "</div></body>");
}

function centerReviewerFrames() {
  document.querySelectorAll<HTMLIFrameElement>(".reviewer .study-card-frame").forEach((frame) => {
    const source = frame.srcdoc;
    const centered = centeredDocument(source);
    if (centered !== source) frame.srcdoc = centered;
  });
}

export function ReviewerEnhancements() {
  const [reviewer, setReviewer] = useState<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);
  const activeReviewer = useRef<HTMLElement | null>(null);
  const explored = useRef(0);
  const remaining = useRef(0);

  useEffect(() => {
    const updateProgress = (nextReviewer: HTMLElement) => {
      if (nextReviewer.querySelector(".congratulations")) {
        remaining.current = 0;
        setProgress(1);
        return;
      }

      const actualRemaining = remainingCards(nextReviewer);
      if (actualRemaining || explored.current === 0) remaining.current = actualRemaining;
      const denominator = explored.current + remaining.current;
      setProgress(denominator > 0 ? Math.min(0.98, explored.current / denominator) : 0);
    };

    const sync = () => {
      const nextReviewer = document.querySelector<HTMLElement>(".reviewer");

      if (nextReviewer !== activeReviewer.current) {
        activeReviewer.current = nextReviewer;
        explored.current = 0;
        remaining.current = nextReviewer ? remainingCards(nextReviewer) : 0;
        setReviewer(nextReviewer);
        setProgress(nextReviewer?.querySelector(".congratulations") ? 1 : 0);
      } else if (nextReviewer) {
        updateProgress(nextReviewer);
      }

      centerReviewerFrames();
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["srcdoc"]
    });

    const handleRating = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".reviewer .answer-btn") : null;
      if (!element || element.disabled || !activeReviewer.current) return;

      const rating = [1, 2, 3, 4].find((value) => element.classList.contains(`answer-btn--${value}`));
      if (!rating) return;

      explored.current += 1;

      // Give immediate feedback while the scheduler/database is updating. The
      // MutationObserver replaces this estimate with the real due-card counts.
      if (rating === 2) remaining.current = Math.max(0, remaining.current - 0.5);
      if (rating === 3) remaining.current = Math.max(0, remaining.current - 1);
      if (rating === 4) remaining.current = Math.max(0, remaining.current - 1.25);

      const denominator = explored.current + remaining.current;
      setProgress(denominator > 0 ? Math.min(0.98, explored.current / denominator) : 0);
    };

    document.addEventListener("click", handleRating, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", handleRating, true);
    };
  }, []);

  if (!reviewer) return null;

  const percent = Math.round(progress * 100);
  return createPortal(
    <div className="review-progress" aria-label={`Study progress ${percent}%`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="review-progress-track">
        <div className="review-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>,
    reviewer
  );
}
