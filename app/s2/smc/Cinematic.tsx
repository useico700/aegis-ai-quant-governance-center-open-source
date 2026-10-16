"use client";

import { useEffect, useState } from "react";

export function ScrambleText({ text }: { text: string }) {
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      const frame = window.requestAnimationFrame(() => setDisplay(text));
      return () => window.cancelAnimationFrame(frame);
    }

    const glyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      setDisplay(Array.from(text, (character, index) => {
        if (/\s|[\u4e00-\u9fff]/.test(character) || index < frame / 2) return character;
        return glyphs[Math.floor(Math.random() * glyphs.length)];
      }).join(""));
      if (frame >= text.length * 2) {
        window.clearInterval(timer);
        setDisplay(text);
      }
    }, 28);
    return () => window.clearInterval(timer);
  }, [text]);

  return <>{display}</>;
}
