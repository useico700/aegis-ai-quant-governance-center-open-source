"use client";

import { memo, useEffect, useState } from "react";
import Image from "next/image";
import styles from "./MonitorNavigation.module.css";

const destinations = [
  { id: "overview", label: "概览", path: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z" },
  { id: "equity", label: "权益", path: "M3 3v18h18 M7 15l4-5 4 3 6-8" },
  { id: "positions", label: "持仓", path: "M3 7h18v14H3z M8 7V3h8v4 M3 12h18 M10 12v3h4v-3" },
  { id: "fills", label: "成交", path: "M4 5h16v14H4z M7 9h10 M7 13h6 M7 17h4" },
  { id: "candidates", label: "候选", path: "M5 4h14v17H5z M9 4V2h6v2 M9 9h6 M9 13h6 M9 17h3" },
  { id: "risk-calendar", label: "事件", path: "M3 5h18v16H3z M7 3v4 M17 3v4 M3 10h18 M8 14h2 M14 14h2 M8 17h2" },
] as const;
const s2Destinations = [...destinations.slice(0, 2), { id: "smc", label: "SMC", path: "M3 17l5-9 5 6 8-11 M3 21h18" }, ...destinations.slice(2)];

function MonitorNavigation({ accountLabel = "S1" }: { accountLabel?: "S1" | "S2" }) {
  const items = accountLabel === "S2" ? s2Destinations : destinations;
  const [active, setActive] = useState<string>("overview");

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const chrome = document.getElementById("monitor-chrome");
      const chromeBounds = chrome?.getBoundingClientRect();
      if (chromeBounds) chrome?.closest("main")?.style.setProperty("--monitor-chrome-height", `${chromeBounds.height}px`);
      const offset = (chromeBounds?.bottom ?? 82) + 24;
      const sections = items.filter(({ id }) => id !== "smc").map(({ id }) => ({ id, top: id === "overview" ? -window.scrollY : document.getElementById(id)?.getBoundingClientRect().top }));
      let current: string = "overview";
      for (const section of sections.sort((a, b) => (a.top ?? Infinity) - (b.top ?? Infinity))) {
        if (section.top !== undefined && section.top <= offset) current = section.id;
      }
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = "risk-calendar";
      }
      setActive(current);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    const chrome = document.getElementById("monitor-chrome");
    if (chrome) observer.observe(chrome);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
      observer.disconnect();
    };
  }, [items]);

  return <nav id="s1-navigation" className={styles.navigation} aria-label={`${accountLabel} 页面导航`}>
    <div className={styles.identity} aria-hidden="true"><Image src={`/${accountLabel.toLowerCase()}-logo.svg`} width={44} height={44} alt="" priority /></div>
    <ul className={styles.links}>
      {items.map(({ id, label, path }) => <li key={id}>
        <a className={styles.link} href={id === "smc" ? "/s2/smc" : `#${id}`} aria-current={active === id ? "location" : undefined}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
          <span>{label}</span>
        </a>
      </li>)}
    </ul>
  </nav>;
}

export default memo(MonitorNavigation);
