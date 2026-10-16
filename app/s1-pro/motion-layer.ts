"use client";

import { useEffect } from "react";

/**
 * Motion added around the classic S1 page without touching its components:
 *  - panels rise in on first view (staggered), never left hidden if script fails;
 *  - a number flashes mint/rose when its value goes up/down;
 *  - countdowns under one hour glow;
 *  - the equity curve draws itself in once.
 * Everything here only reads the DOM and runs Web Animations; it never changes text or data.
 */
const UP = "#4fe0d6", DOWN = "#ff86b4";
const COUNTDOWN = /^(?:\d+天\s)?(\d{2}):(\d{2}):(\d{2})$/;
const NUMERIC = /^[+\-−]?\s?[\d,]+(?:\.\d+)?\s?%?$/;

export function useMotionLayer(hostRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ease = "cubic-bezier(.2,.8,.2,1)";

    /* ---------- staggered reveal ---------- */
    const revealed = new WeakSet<Element>();
    let revealIndex = 0;
    const reveal = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || revealed.has(entry.target)) continue;
        revealed.add(entry.target); reveal.unobserve(entry.target);
        if (reduced) continue;
        const delay = Math.min(6, revealIndex++) * 70;
        entry.target.animate([{ opacity: 0, transform: "translateY(22px) scale(.99)", filter: "blur(8px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 760, delay, easing: ease, fill: "backwards" });
        window.setTimeout(() => { revealIndex = Math.max(0, revealIndex - 1); }, 400);
      }
    }, { threshold: .08 });
    const attachReveal = () => {
      const main = host.querySelector("main");
      if (!main) return;
      main.querySelectorAll(":scope > section, :scope > div:not([id='monitor-chrome']) > section, :scope > div > div > section, :scope > div > aside > section, #more-data > details, #more-data > section").forEach(element => {
        if (!revealed.has(element) && !element.closest("#monitor-chrome")) reveal.observe(element);
      });
    };

    /* ---------- number flash + countdown glow ---------- */
    const previous = new WeakMap<Element, number>();
    const inspect = (element: Element | null) => {
      if (!element || !(element instanceof HTMLElement) || element.closest("#monitor-chrome")) return;
      const text = (element.textContent ?? "").trim();
      const countdown = COUNTDOWN.exec(text);
      if (countdown) {
        const soon = !text.includes("天") && Number(countdown[1]) === 0;
        if (soon) element.dataset.proSoon = "true"; else delete element.dataset.proSoon;
        return;
      }
      if (element.dataset.proSoon) delete element.dataset.proSoon;
      if (!NUMERIC.test(text) || element.children.length > 1) return;
      const value = Number(text.replace(/[,\s%+]/g, "").replace("−", "-"));
      if (!Number.isFinite(value)) return;
      const before = previous.get(element);
      previous.set(element, value);
      if (before === undefined || before === value || reduced) return;
      const color = value > before ? UP : DOWN;
      element.animate([{ color, textShadow: `0 0 16px ${color}`, transform: "translateY(-1px)" }, { color: "", textShadow: "0 0 0 transparent", transform: "none" }], { duration: 1100, easing: ease });
    };
    const scanAll = () => host.querySelectorAll("main dd, main strong, main b, main td, main dd > span").forEach(inspect);
    // heartbeat health read from the classic page's own wording, not from its class names
    const markHeartbeats = () => host.querySelectorAll<HTMLElement>('section[aria-labelledby="heartbeat-title"] article').forEach(article => {
      const ok = (article.querySelector("strong")?.textContent ?? "").trim().startsWith("正常");
      if (article.dataset.proOk !== String(ok)) article.dataset.proOk = String(ok);
    });

    /* ---------- equity curve draw-in (once) ---------- */
    let drew = false;
    const drawEquity = () => {
      if (drew || reduced) return;
      const paths = host.querySelectorAll<SVGPathElement>('#equity svg path[class*="curve"]');
      if (!paths.length) return;
      drew = true;
      paths.forEach((path, index) => {
        const length = path.getTotalLength();
        if (!length) return;
        path.animate([{ strokeDasharray: `${length}`, strokeDashoffset: `${length}` }, { strokeDasharray: `${length}`, strokeDashoffset: "0" }], { duration: 1800, delay: 200 + index * 120, easing: ease });
      });
      host.querySelectorAll('#equity svg path[class*="area"]').forEach(area => area.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 1300, easing: "ease", fill: "backwards" }));
    };

    let pending = 0;
    const changed = new Set<Element>();
    const mutations = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target as Element;
        if (target) changed.add(target);
      }
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        changed.forEach(element => { inspect(element); element.querySelectorAll?.("dd, strong, b, td").forEach(inspect); });
        changed.clear();
        attachReveal(); drawEquity(); markHeartbeats();
      });
    });
    mutations.observe(host, { subtree: true, childList: true, characterData: true });
    const start = requestAnimationFrame(() => { attachReveal(); scanAll(); drawEquity(); markHeartbeats(); });
    return () => { cancelAnimationFrame(start); cancelAnimationFrame(pending); mutations.disconnect(); reveal.disconnect(); };
  }, [hostRef]);
}
