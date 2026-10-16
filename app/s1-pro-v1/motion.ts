"use client";

import { useEffect, useRef, useState } from "react";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

const easeOutExpo = (t: number) => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);

/** Smoothly tweens a number toward its latest target. Null stays null (unknown is never animated to zero). */
export function useTween(target: number | null | undefined, duration = 900): number | null {
  const [value, setValue] = useState<number | null>(target ?? null);
  const current = useRef<number | null>(target ?? null);
  const reduced = useReducedMotion();

  useEffect(() => {
    let frame = 0;
    const settle = (next: number | null) => { current.current = next; frame = requestAnimationFrame(() => setValue(next)); };
    if (target == null || !Number.isFinite(target)) { settle(null); return () => cancelAnimationFrame(frame); }
    const from = current.current;
    if (from == null || reduced || from === target) { settle(target); return () => cancelAnimationFrame(frame); }
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const next = from + (target - from) * easeOutExpo(progress);
      current.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);

  return value;
}

/** Pointer-follow spotlight: writes --mx/--my on the element, no React re-render. */
export function spotlight(event: React.PointerEvent<HTMLElement>) {
  const element = event.currentTarget;
  const rect = element.getBoundingClientRect();
  element.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  element.style.setProperty("--my", `${event.clientY - rect.top}px`);
}
