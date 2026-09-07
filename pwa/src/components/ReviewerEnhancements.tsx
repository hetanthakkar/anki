"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function parseCount(value: string | null) {
  const match = value?.match(/(\d+)\s+of\s+(\d+)/i);
  return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
}

function sessionTarget(reviewer: HTMLElement) {
  const counts = Array.from(reviewer.querySelectorAll<HTMLElement>(".review-stat-count")).map((node) => parseCount(node.textContent));
  if (counts.length >= 3 && counts[0] && counts[1] && counts[2]) {
    const mastered = counts[0];
    const reviewing = counts[1];
    const learning = counts[2];
    const newCards = Math.max(0, mastered.total - mastered.current);
    return Math.max(1, newCards + reviewing.current + learning.current);
  }
  return 8;
}

export function ReviewerEnhancements() {
  const [reviewer, setReviewer] = useState<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);
  const activeReviewer = useRef<HTMLElement | null>(null);
  const target = useRef(8);
  const ratings = useRef(0);

  useEffect(() => {
    const sync = () => {
      const nextReviewer = document.querySelector<HTMLElement>(".reviewer");

      if (nextReviewer !== activeReviewer.current) {
        activeReviewer.current = nextReviewer;
        ratings.current = 0;
        setProgress(nextReviewer?.querySelector(".congratulations") ? 1 : 0);
        if (nextReviewer) target.current = sessionTarget(nextReviewer);
        setReviewer(nextReviewer);
      } else if (nextReviewer) {
        if (ratings.current === 0) target.current = sessionTarget(nextReviewer);
        if (nextReviewer.querySelector(".congratulations")) setProgress(1);
      }
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    const handleRating = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".reviewer .answer-btn") : null;
      if (!element || element.disabled) return;

      const rating = [1, 2, 3, 4].find((value) => element.classList.contains(`answer-btn--${value}`));
      if (!rating) return;

      ratings.current += 1;
      const step = 1 / Math.max(1, target.current);
      setProgress((current) => {
        if (rating === 1) return Math.max(0, current - step * 0.35);
        const credit = rating === 2 ? 0.55 : rating === 3 ? 1 : 1.15;
        return Math.min(0.96, current + step * credit);
      });
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
