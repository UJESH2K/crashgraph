"use client";

import { useEffect, useState } from "react";

const KEY = "crashgraph-theme";
type Theme = "dark" | "light";

/**
 * Dark is the default and dark means black — the subject is a vacuum. Light exists for a lit
 * room or a projector, where a black console washes out to grey.
 *
 * The initial value is set by an inline script in the layout, before first paint, so this
 * reads what is already on the element rather than deciding it a frame later.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setTheme(t === "light" ? "light" : "dark");
  }, []);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* private window: this session only */ }
  };

  return (
    <button
      className={className}
      onClick={flip}
      aria-label={`Switch to the ${theme === "dark" ? "light" : "dark"} theme`}
      title={`${theme === "dark" ? "Light" : "Dark"} theme`}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="3" fill="currentColor" />
          <path d="M7 .8v2M7 11.2v2M.8 7h2M11.2 7h2M2.6 2.6l1.4 1.4M10 10l1.4 1.4M11.4 2.6L10 4M4 10l-1.4 1.4"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M12 8.6A5.6 5.6 0 0 1 5.4 2 5.6 5.6 0 1 0 12 8.6z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}
