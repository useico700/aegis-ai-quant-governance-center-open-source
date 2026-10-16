"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./motion";
import styles from "./s1-pro.module.css";

const GLYPHS = "0123456789ABCDEF<>/#%$+=-*";

/** Decodes text glyph-by-glyph whenever `text` changes (terminal "resolve" effect). */
export function ScrambleText({ text, duration = 520, className }: { text: string; duration?: number; className?: string }) {
  const [shown, setShown] = useState(text);
  const reduced = useReducedMotion();
  const previous = useRef(text);

  useEffect(() => {
    let frame = 0;
    if (reduced || previous.current === text) {
      previous.current = text;
      frame = requestAnimationFrame(() => setShown(text));
      return () => cancelAnimationFrame(frame);
    }
    previous.current = text;
    const start = performance.now();
    const chars = Array.from(text);
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const settled = Math.floor(progress * chars.length);
      setShown(chars.map((char, index) => index < settled || char === " " ? char : /[一-鿿]/.test(char) && progress > .55 ? char : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join(""));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, duration, reduced]);

  return <span className={className} aria-label={text}><span aria-hidden="true">{shown}</span></span>;
}

/**
 * One-per-session opening: a slow 4H line and a fast 1H line draw in and meet at Px,
 * the intersection flares, "S1" resolves, and a heartbeat trace sweeps out.
 * Skippable by click or key; never shown under reduced motion.
 */
export function IntroSequence({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotion();
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    if (reduced) { doneRef.current(); return; }
    const leave = window.setTimeout(() => setLeaving(true), 2600);
    const done = window.setTimeout(() => doneRef.current(), 3200);
    const skip = () => { setLeaving(true); window.setTimeout(() => doneRef.current(), 380); };
    window.addEventListener("keydown", skip, { once: true });
    return () => { clearTimeout(leave); clearTimeout(done); window.removeEventListener("keydown", skip); };
  }, [reduced]);

  const skip = () => { setLeaving(true); window.setTimeout(() => doneRef.current(), 380); };
  if (reduced) return null;
  return <div className={styles.intro} data-leaving={leaving} onClick={skip} role="presentation">
    <svg className={styles.introLines} viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="s1IntroSlow" x1="0" x2="1"><stop offset="0" stopColor="#76deea" stopOpacity="0" /><stop offset=".8" stopColor="#76deea" /><stop offset="1" stopColor="#e8faff" /></linearGradient>
        <linearGradient id="s1IntroFast" x1="0" x2="1"><stop offset="0" stopColor="#e8f3f8" stopOpacity="0" /><stop offset=".8" stopColor="#e8f3f8" /><stop offset="1" stopColor="#ffffff" /></linearGradient>
      </defs>
      <path className={styles.introSlow} d="M-40 760 L800 450 L1640 140" pathLength={1} stroke="url(#s1IntroSlow)" />
      <path className={styles.introFast} d="M-40 170 L800 450 L1640 730" pathLength={1} stroke="url(#s1IntroFast)" />
      <circle className={styles.introFlare} cx="800" cy="450" r="60" />
      <circle className={styles.introCore} cx="800" cy="450" r="5" />
      <path className={styles.introPulse} d="M0 640 H560 L600 640 L620 600 L640 690 L668 520 L700 700 L724 640 H1040 L1060 628 L1080 652 L1100 640 H1600" pathLength={1} />
    </svg>
    <div className={styles.introCopy}>
      <small>LIVE ACCOUNT 1 · BINANCE USDⓈ-M</small>
      <h1><ScrambleText text="S1" duration={700} /></h1>
      <p><span>4H</span> × <span>1H</span> 交汇 · 15M 收线确认</p>
    </div>
    <button type="button" className={styles.introSkip} onClick={event => { event.stopPropagation(); skip(); }}>跳过</button>
  </div>;
}
