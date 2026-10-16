"use client";

import { useEffect, useRef } from "react";
import styles from "./s1-pro.module.css";

type Pair = { cx: number; cy: number; angle: number; spread: number; drift: number; phase: number; born: number; life: number };

/**
 * Ambient backdrop: a perspective grid floor and slow pairs of trend lines that converge,
 * flare at their intersection and fade — the S1 4H × 1H signature as atmosphere only.
 * Not market data. Pauses when hidden; one still frame under reduced motion.
 */
export default function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, frame = 0, last = 0, next = 600;
    const pairs: Pair[] = [];

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const spawn = (time: number) => {
      pairs.push({ cx: width * (.15 + Math.random() * .7), cy: height * (.12 + Math.random() * .45), angle: (Math.random() - .5) * .5, spread: .16 + Math.random() * .14, drift: (Math.random() - .5) * .012, phase: Math.random() * Math.PI * 2, born: time, life: 5200 + Math.random() * 2600 });
      if (pairs.length > 4) pairs.shift();
    };

    const floor = (time: number) => {
      const horizon = height * .62;
      const vanishX = width / 2;
      context.lineWidth = 1;
      for (let index = -18; index <= 18; index++) {
        const x = vanishX + index * width * .08;
        const gradient = context.createLinearGradient(0, horizon, 0, height);
        gradient.addColorStop(0, "rgba(118,222,234,0)");
        gradient.addColorStop(1, "rgba(118,222,234,.10)");
        context.strokeStyle = gradient;
        context.beginPath(); context.moveTo(vanishX, horizon); context.lineTo(x * 3 - vanishX * 2, height); context.stroke();
      }
      const offset = reduced ? 0 : (time * .00004) % 1;
      for (let index = 0; index < 14; index++) {
        const t = (index + offset) / 14;
        const y = horizon + Math.pow(t, 2.2) * (height - horizon);
        context.strokeStyle = `rgba(118,222,234,${.015 + t * .09})`;
        context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
      }
      const glow = context.createLinearGradient(0, horizon - 60, 0, horizon + 20);
      glow.addColorStop(0, "rgba(118,222,234,0)");
      glow.addColorStop(.75, "rgba(118,222,234,.06)");
      glow.addColorStop(1, "rgba(118,222,234,0)");
      context.fillStyle = glow;
      context.fillRect(0, horizon - 60, width, 80);
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      floor(time);
      for (const pair of pairs) {
        const age = Math.min(1, Math.max(0, (time - pair.born) / pair.life));
        const fade = Math.sin(Math.PI * age);
        const converge = 1 - Math.min(1, age * 1.6); // lines close in, meet, then hold
        const reach = Math.max(width, height) * .55;
        context.save();
        context.translate(pair.cx, pair.cy);
        context.rotate(pair.angle + pair.drift * Math.sin(time * .0004 + pair.phase));
        [[1, "rgba(118,222,234,"], [-1, "rgba(232,243,248,"]].forEach(([sign, color]) => {
          const slope = (sign as number) * pair.spread * (.25 + converge * .75);
          const gradient = context.createLinearGradient(-reach, 0, reach * .2, 0);
          gradient.addColorStop(0, `${color}0)`);
          gradient.addColorStop(.85, `${color}${(.42 * fade).toFixed(3)})`);
          gradient.addColorStop(1, `${color}0)`);
          context.strokeStyle = gradient;
          context.lineWidth = sign === 1 ? 1.4 : 1;
          context.beginPath(); context.moveTo(-reach, -reach * slope); context.lineTo(reach * .2, reach * .2 * slope); context.stroke();
        });
        if (age > .55) {
          const flare = Math.sin(Math.PI * Math.min(1, (age - .55) / .45));
          const radius = 3 + flare * 22;
          const halo = context.createRadialGradient(0, 0, 0, 0, 0, radius);
          halo.addColorStop(0, `rgba(232,250,255,${.8 * flare})`);
          halo.addColorStop(.3, `rgba(118,222,234,${.35 * flare})`);
          halo.addColorStop(1, "rgba(118,222,234,0)");
          context.fillStyle = halo;
          context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill();
        }
        context.restore();
      }
    };

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (time - last < 33) return;
      last = time;
      if (time > next) { spawn(time); next = time + 2600 + Math.random() * 2400; }
      for (let index = pairs.length - 1; index >= 0; index--) if (time - pairs[index].born > pairs[index].life) pairs.splice(index, 1);
      draw(time);
    };

    const fadeOnScroll = () => { canvas.style.opacity = String(Math.max(.28, 1 - window.scrollY / 640)); };
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden && !reduced) frame = requestAnimationFrame(loop); };
    const onResize = () => { resize(); if (reduced) draw(0); };

    resize();
    if (reduced) { spawn(0); pairs[0].born = -3000; }
    draw(0);
    if (!reduced) frame = requestAnimationFrame(loop);
    fadeOnScroll();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", fadeOnScroll, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", fadeOnScroll);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.backdrop} aria-hidden="true" />;
}
