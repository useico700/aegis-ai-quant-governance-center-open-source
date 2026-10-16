"use client";

import { useEffect, useRef } from "react";
import styles from "./s1-pro.module.css";

/**
 * Page-wide atmosphere matching the 多空信号流 texture: a faint starfield and a few slow optical
 * fibers drifting across the viewport with dim light packets. Purely decorative; ~30fps,
 * pauses when the tab is hidden, a still frame under reduced motion.
 */
type Fiber = { a: number; b: number; c: number; d: number; phase: number; speed: number; hue: string; width: number };
type Packet = { fiber: number; t: number; speed: number };

export default function AmbientField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, frame = 0, last = 0;
    let seed = 5; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const stars = Array.from({ length: 140 }, () => ({ x: random(), y: random(), r: .3 + random() * 1.1, p: random() * Math.PI * 2 }));
    const fibers: Fiber[] = Array.from({ length: 6 }, (_, index) => ({ a: random(), b: random(), c: random(), d: random(), phase: random() * Math.PI * 2, speed: .00004 + random() * .00005, hue: index % 3 === 2 ? "79,224,214" : "92,200,245", width: .6 + random() * .8 }));
    const packets: Packet[] = [];

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth; height = window.innerHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const curve = (fiber: Fiber, time: number) => {
      const drift = Math.sin(time * fiber.speed + fiber.phase);
      const y0 = height * (.1 + fiber.a * .8), y3 = height * (.1 + fiber.b * .8);
      return [{ x: -60, y: y0 }, { x: width * .35, y: y0 + (fiber.c - .5) * height * .6 + drift * 60 }, { x: width * .65, y: y3 + (fiber.d - .5) * height * .6 - drift * 60 }, { x: width + 60, y: y3 }];
    };
    const point = (p: { x: number; y: number }[], t: number) => {
      const u = 1 - t;
      return { x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x, y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y };
    };
    const draw = (time: number, dt: number) => {
      context.clearRect(0, 0, width, height);
      for (const star of stars) {
        const twinkle = reduced ? .6 : .5 + .5 * Math.sin(time * .0012 + star.p);
        context.fillStyle = `rgba(170,225,255,${.08 + twinkle * .22})`;
        context.beginPath(); context.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2); context.fill();
      }
      fibers.forEach(fiber => {
        const p = curve(fiber, time);
        context.beginPath(); context.moveTo(p[0].x, p[0].y); context.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
        context.strokeStyle = `rgba(${fiber.hue},.05)`; context.lineWidth = fiber.width * 4; context.stroke();
        context.strokeStyle = `rgba(${fiber.hue},.11)`; context.lineWidth = fiber.width; context.stroke();
      });
      if (!reduced) {
        if (packets.length < 7 && Math.random() < dt * .9) packets.push({ fiber: Math.floor(Math.random() * fibers.length), t: 0, speed: .05 + Math.random() * .06 });
        context.globalCompositeOperation = "lighter";
        for (let index = packets.length - 1; index >= 0; index--) {
          const packet = packets[index]; packet.t += dt * packet.speed;
          if (packet.t >= 1) { packets.splice(index, 1); continue; }
          const fiber = fibers[packet.fiber], p = curve(fiber, time);
          for (let tail = 0; tail < 10; tail++) {
            const q = point(p, Math.max(0, packet.t - tail * .004));
            context.fillStyle = `rgba(${fiber.hue},${(1 - tail / 10) * .35})`;
            context.beginPath(); context.arc(q.x, q.y, 1.8 - tail * .12, 0, Math.PI * 2); context.fill();
          }
        }
        context.globalCompositeOperation = "source-over";
      }
    };
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (time - last < 33) return;
      const dt = Math.min(.1, (time - (last || time)) / 1000); last = time;
      draw(time, dt);
    };
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden && !reduced) frame = requestAnimationFrame(loop); };
    const onResize = () => { resize(); if (reduced) draw(0, 0); };
    resize(); draw(0, 0);
    if (!reduced) frame = requestAnimationFrame(loop);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", visibility);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", onResize); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return <canvas ref={ref} className={styles.ambient} aria-hidden="true" />;
}
