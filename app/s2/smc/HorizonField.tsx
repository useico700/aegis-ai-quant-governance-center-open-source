"use client";

import { useEffect, useRef } from "react";
import styles from "./smc-workspace.module.css";

type Streak = { y: number; born: number; life: number; width: number; thickness: number };

/**
 * Ambient backdrop: black space, a breathing planet-limb horizon and occasional light streaks.
 * Pauses when the tab is hidden; renders one still frame under prefers-reduced-motion.
 */
export default function HorizonField({ pulseKey }: { pulseKey: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef(pulseKey);
  const burstRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (pulseRef.current !== pulseKey) { pulseRef.current = pulseKey; burstRef.current?.(); }
  }, [pulseKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, frame = 0, last = 0, nextStreak = 1200;
    const streaks: Streak[] = [];
    const pointer = { x: .5, tx: .5 };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const spawn = (time: number, burst = false) => {
      const count = burst ? 3 : 1;
      for (let index = 0; index < count; index++) {
        streaks.push({ y: height * (.12 + Math.random() * .55), born: time + index * 90, life: burst ? 1100 : 1700 + Math.random() * 900, width: width * (.5 + Math.random() * .5), thickness: burst ? 1.4 + index * .6 : .8 + Math.random() * 1.4 });
      }
    };
    burstRef.current = () => { if (!reduced) spawn(performance.now(), true); };

    const draw = (time: number) => {
      pointer.x += (pointer.tx - pointer.x) * .03;
      context.clearRect(0, 0, width, height);

      // Planet limb horizon
      const breath = reduced ? .5 : (Math.sin(time * .0007) + 1) / 2;
      const radius = Math.max(width * 1.25, 1400);
      const cx = width * (.5 + (pointer.x - .5) * .03);
      const cy = height + radius - Math.min(height * .16, 150);
      const halo = context.createRadialGradient(cx, cy, radius * .96, cx, cy, radius * 1.09);
      halo.addColorStop(0, "rgba(0,0,0,0)");
      halo.addColorStop(.3, `rgba(120,150,255,${.05 + breath * .04})`);
      halo.addColorStop(.36, `rgba(210,225,255,${.16 + breath * .1})`);
      halo.addColorStop(.42, `rgba(120,140,230,${.06 + breath * .03})`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = halo;
      context.fillRect(0, height * .4, width, height * .6);
      context.beginPath();
      context.arc(cx, cy, radius, Math.PI * 1.15, Math.PI * 1.85);
      context.strokeStyle = `rgba(235,242,255,${.28 + breath * .2})`;
      context.lineWidth = 1.2;
      context.shadowColor = "rgba(170,195,255,.9)";
      context.shadowBlur = 18;
      context.stroke();
      context.shadowBlur = 0;
      // dark planet body
      context.beginPath();
      context.arc(cx, cy, radius - .6, 0, Math.PI * 2);
      context.fillStyle = "rgba(2,3,6,.92)";
      context.fill();

      // Light streaks (violet → white → gold)
      for (let index = streaks.length - 1; index >= 0; index--) {
        const streak = streaks[index];
        const age = (time - streak.born) / streak.life;
        if (age < 0) continue;
        if (age > 1) { streaks.splice(index, 1); continue; }
        const head = -streak.width + (width + streak.width * 2) * age;
        const alpha = Math.sin(Math.PI * age);
        const gradient = context.createLinearGradient(head - streak.width, 0, head, 0);
        gradient.addColorStop(0, "rgba(120,110,255,0)");
        gradient.addColorStop(.45, `rgba(150,140,255,${.35 * alpha})`);
        gradient.addColorStop(.75, `rgba(245,245,255,${.75 * alpha})`);
        gradient.addColorStop(1, `rgba(255,196,110,${.5 * alpha})`);
        context.fillStyle = gradient;
        context.fillRect(head - streak.width, streak.y, streak.width, streak.thickness);
      }
    };

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (time - last < 33) return;
      last = time;
      if (time > nextStreak) { spawn(time); nextStreak = time + 5200 + Math.random() * 4800; }
      draw(time);
    };

    const move = (event: PointerEvent) => { pointer.tx = event.clientX / Math.max(width, 1); };
    const fadeOnScroll = () => { canvas.style.opacity = String(Math.max(.3, 1 - window.scrollY / 520)); };
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden && !reduced) frame = requestAnimationFrame(loop); };

    resize();
    draw(0);
    if (!reduced) frame = requestAnimationFrame(loop);
    const onResize = () => { resize(); if (reduced) draw(0); };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("scroll", fadeOnScroll, { passive: true });
    fadeOnScroll();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      burstRef.current = null;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("scroll", fadeOnScroll);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.horizon} aria-hidden="true" />;
}
