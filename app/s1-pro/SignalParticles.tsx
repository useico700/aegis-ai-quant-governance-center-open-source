"use client";

import { useEffect, useRef } from "react";
import styles from "./s1-pro.module.css";

/**
 * Particle-fiber layer drawn over the classic 多空信号流 section (which stays untouched underneath).
 * Route: brain (结构扫描) → 15M confirmation → cube (结构待确认) → long / short outcome.
 * Flow rates follow the real counts already printed by the classic section; the layer reads them
 * from the DOM, never from its own data. Respects the section's own 暂停动效 toggle and reduced motion.
 * Decoration only: a particle is not an order, a fill or a market signal.
 */

type Point = { x: number; y: number };
type Segment = [Point, Point, Point, Point];
type Route = "trunk" | "long" | "short";
type Particle = { route: Route; t: number; speed: number; size: number; hue: string; trail: Point[]; life?: number; wobble: number };
type Flash = { x: number; y: number; born: number; color: string; radius: number };
type Spark = { x: number; y: number; vx: number; vy: number; born: number; life: number; color: string };

const BLUE = "92,200,245", LONG = "79,224,214", SHORT = "255,134,180", WHITE = "235,248,255";

const bezier = ([p0, p1, p2, p3]: Segment, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
};
const curve = (a: Point, b: Point, bend = .5): Segment => {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? [a, { x: a.x + dx * bend, y: a.y }, { x: b.x - dx * bend, y: b.y }, b]
    : [a, { x: a.x, y: a.y + dy * bend }, { x: b.x, y: b.y - dy * bend }, b];
};
const centre = (element: Element | null | undefined, host: DOMRect): Point | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { x: rect.left - host.left + rect.width / 2, y: rect.top - host.top + rect.height / 2 };
};
const leftEdge = (element: Element | null | undefined, host: DOMRect): Point | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { x: rect.left - host.left + 2, y: rect.top - host.top + rect.height / 2 };
};
const readCount = (element: Element | null | undefined) => {
  const value = Number.parseInt(element?.querySelector("dd")?.textContent ?? "", 10);
  return Number.isFinite(value) ? value : 0;
};

export default function SignalParticles({ hostRef }: { hostRef: React.RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!host || !canvas || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, last = 0, spawnClock = 0, visible = true, ratio = 1;
    let section: HTMLElement | null = null;
    let trunk: [Segment, Segment] | null = null, longPath: Segment | null = null, shortPath: Segment | null = null;
    let brain: Point | null = null, cube: Point | null = null, cubeIn: Point | null = null, longAt: Point | null = null, shortAt: Point | null = null;
    let counts = { long: 0, short: 0, pending: 0 };
    const particles: Particle[] = [], flashes: Flash[] = [], sparks: Spark[] = [];

    const measure = () => {
      section = host.querySelector<HTMLElement>('section[aria-labelledby="signal-flow-title"]');
      if (!section) { trunk = null; return; }
      const hostRect = host.getBoundingClientRect(), rect = section.getBoundingClientRect();
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.left = `${rect.left - hostRect.left}px`; canvas.style.top = `${rect.top - hostRect.top}px`;
      const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) { // resizing clears the canvas, so only when needed
        canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
        canvas.width = width; canvas.height = height;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      // prefer the 3D skin's elements when present, else the classic ones
      const skinBrain = host.querySelector('[data-skin-anchor="brain"]');
      const brainEl = skinBrain ?? section.querySelector('[class*="brainGlyph"]') ?? section.querySelector('[class*="origin"]');
      const confirmEl = section.querySelector('[class*="incoming"]');
      const cubeEl = host.querySelector('[data-skin-anchor="cube"]') ?? section.querySelector('[class*="cubeField"]') ?? section.querySelector('[class*="gate"]');
      const classicOutcomes = section.querySelectorAll('[class*="outcomes"] > div');
      const skinLong = host.querySelector('[data-skin-card="long"]'), skinShort = host.querySelector('[data-skin-card="short"]');
      const outcomes = skinLong && skinShort ? [skinLong, skinShort] : [classicOutcomes[0], classicOutcomes[1]];
      brain = centre(brainEl, rect); cube = centre(cubeEl, rect);
      const confirm = centre(confirmEl, rect);
      longAt = leftEdge(outcomes[0], rect); shortAt = leftEdge(outcomes[1], rect);
      const stacked = !!(brain && cube && Math.abs(cube.y - brain.y) > Math.abs(cube.x - brain.x));
      if (stacked) { // phone layout: outcomes sit below the cube
        longAt = centre(outcomes[0], rect); shortAt = centre(outcomes[1], rect);
        if (longAt) longAt.y -= 18; if (shortAt) shortAt.y -= 18;
      }
      // enter/leave at the edges so particles never cover the brain glyph or the cube's count
      const brainBox = brainEl?.getBoundingClientRect(), cubeBox = cubeEl?.getBoundingClientRect();
      const cubeHalf = cubeBox ? Math.min(cubeBox.height, cubeBox.width) * .3 : 0, brainHalf = brainBox ? (skinBrain ? brainBox.height * .42 : (stacked ? brainBox.height : brainBox.width) * .45) : 0;
      const start = brain && (stacked ? { x: brain.x, y: brain.y + brainHalf } : { x: brain.x + brainHalf, y: brain.y });
      cubeIn = cube && (stacked ? { x: cube.x, y: cube.y - cubeHalf } : { x: cube.x - cubeHalf, y: cube.y });
      const cubeOut = cube && (stacked ? { x: cube.x, y: cube.y + cubeHalf } : { x: cube.x + cubeHalf, y: cube.y });
      trunk = start && cubeIn ? [curve(start, confirm ?? { x: (start.x + cubeIn.x) / 2, y: (start.y + cubeIn.y) / 2 }, .45), curve(confirm ?? start, cubeIn, .45)] : null;
      longPath = cubeOut && longAt ? curve(cubeOut, longAt, .55) : null;
      shortPath = cubeOut && shortAt ? curve(cubeOut, shortAt, .55) : null;
      counts = { long: readCount(classicOutcomes[0]), short: readCount(classicOutcomes[1]), pending: Number.parseInt(section.querySelector('[class*="pendingValue"]')?.textContent ?? "", 10) || 0 };
    };

    const enabled = () => {
      if (!section || reduced.matches || document.hidden || !visible) return false;
      const toggle = section.querySelector<HTMLButtonElement>("button[aria-pressed]");
      return !toggle || toggle.getAttribute("aria-pressed") !== "false";
    };
    const active = () => section?.getAttribute("data-animated") === "true";

    const spawn = (route: Route, boost = 1) => {
      particles.push({ route, t: 0, speed: (route === "trunk" ? .33 : .55) * (.8 + Math.random() * .45) * boost, size: 1.1 + Math.random() * 1.3, hue: route === "long" ? LONG : route === "short" ? SHORT : Math.random() < .18 ? WHITE : BLUE, trail: [], wobble: (Math.random() - .5) * 7 });
      if (particles.length > 180) particles.shift();
    };
    const burst = (point: Point | null, color: string, count = 14) => {
      if (!point) return;
      flashes.push({ x: point.x, y: point.y, born: performance.now(), color, radius: 26 });
      for (let index = 0; index < count; index++) {
        const angle = Math.random() * Math.PI * 2, speed = 20 + Math.random() * 70;
        sparks.push({ x: point.x, y: point.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, born: performance.now(), life: 500 + Math.random() * 500, color });
      }
    };

    const pathFor = (particle: Particle): Segment | null => particle.route === "long" ? longPath : particle.route === "short" ? shortPath : trunk ? (particle.t < .5 ? trunk[0] : trunk[1]) : null;
    const pointFor = (particle: Particle): Point | null => {
      if (particle.route === "trunk") { if (!trunk) return null; return particle.t < .5 ? bezier(trunk[0], particle.t * 2) : bezier(trunk[1], (particle.t - .5) * 2); }
      const path = pathFor(particle);
      return path ? bezier(path, particle.t) : null;
    };

    const drawFibers = (time: number) => {
      const strokes: Array<[Segment | null, string, number]> = [[trunk?.[0] ?? null, BLUE, .16], [trunk?.[1] ?? null, BLUE, .16], [longPath, LONG, counts.long ? .3 : .1], [shortPath, SHORT, counts.short ? .3 : .1]];
      for (const [path, color, alpha] of strokes) {
        if (!path) continue;
        context.beginPath(); context.moveTo(path[0].x, path[0].y); context.bezierCurveTo(path[1].x, path[1].y, path[2].x, path[2].y, path[3].x, path[3].y);
        context.strokeStyle = `rgba(${color},${alpha * .5})`; context.lineWidth = 5; context.stroke();
        context.strokeStyle = `rgba(${color},${alpha})`; context.lineWidth = 1; context.setLineDash([2, 7]); context.lineDashOffset = -time * .03; context.stroke(); context.setLineDash([]);
      }
    };

    const drawBrainAura = (time: number) => {
      if (!brain) return;
      const pulse = (Math.sin(time * .004) + 1) / 2;
      const glow = context.createRadialGradient(brain.x, brain.y, 0, brain.x, brain.y, 54 + pulse * 10);
      glow.addColorStop(0, `rgba(${BLUE},${.22 + pulse * .12})`); glow.addColorStop(1, `rgba(${BLUE},0)`);
      context.fillStyle = glow; context.beginPath(); context.arc(brain.x, brain.y, 64, 0, Math.PI * 2); context.fill();
      for (let index = 0; index < 6; index++) { // orbiting neurons
        const angle = time * .0011 * (index % 2 ? 1 : -1.3) + index * 1.05, radius = 40 + (index % 3) * 7;
        const x = brain.x + Math.cos(angle) * radius, y = brain.y + Math.sin(angle) * radius * .82;
        context.fillStyle = `rgba(${index % 3 ? BLUE : WHITE},${.55 + .35 * Math.sin(time * .006 + index)})`;
        context.beginPath(); context.arc(x, y, 1.6, 0, Math.PI * 2); context.fill();
      }
    };

    const drawCubeCore = (time: number) => {
      if (!cube) return;
      const pulse = (Math.sin(time * .0032) + 1) / 2;
      context.save(); context.translate(cube.x, cube.y);
      for (let ring = 0; ring < 2; ring++) { // two counter-rotating orbit arcs around the cube
        context.rotate(time * (ring ? -.0006 : .0009));
        context.strokeStyle = `rgba(${ring ? LONG : BLUE},${.22 + pulse * .18})`; context.lineWidth = 1.2;
        context.beginPath(); context.ellipse(0, 0, 84 + ring * 10, 30 + ring * 8, 0, 0, Math.PI * 1.25); context.stroke();
      }
      context.restore();
    };

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(.05, (time - (last || time)) / 1000); last = time;
      if (!canvas.width) return;
      context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
      if (!enabled() || !trunk) return;
      const live = active();
      context.globalCompositeOperation = "lighter";
      drawFibers(time); drawBrainAura(time); drawCubeCore(time);

      // spawn: livelier when the classic section is active, a calm ambient trickle otherwise
      const total = counts.long + counts.short + counts.pending;
      const rate = live ? Math.min(10, 2.6 + total * .8) : 1.2;
      spawnClock += dt * rate;
      while (spawnClock >= 1) { spawnClock -= 1; spawn("trunk"); }

      for (let index = particles.length - 1; index >= 0; index--) {
        const particle = particles[index];
        particle.t += dt * particle.speed;
        if (particle.t >= 1) {
          particles.splice(index, 1);
          if (particle.route === "trunk") {
            if (cubeIn) flashes.push({ x: cubeIn.x, y: cubeIn.y, born: time, color: BLUE, radius: 14 });
            const weightLong = counts.long, weightShort = counts.short, roll = Math.random() * (weightLong + weightShort + Math.max(1, counts.pending) * .6);
            if (live && roll < weightLong) spawn("long"); else if (live && roll < weightLong + weightShort) spawn("short");
          } else {
            burst(particle.route === "long" ? longAt : shortAt, particle.route === "long" ? LONG : SHORT, 6);
            host.dispatchEvent(new CustomEvent("s1pro:arrive", { detail: particle.route }));
          }
          continue;
        }
        const point = pointFor(particle);
        if (!point) continue;
        const along = Math.sin(particle.t * Math.PI);
        point.y += particle.wobble * along * .4;
        particle.trail.unshift(point); if (particle.trail.length > 14) particle.trail.pop();
        for (let step = 1; step < particle.trail.length; step++) {
          const a = particle.trail[step - 1], b = particle.trail[step];
          context.strokeStyle = `rgba(${particle.hue},${(1 - step / particle.trail.length) * .55})`;
          context.lineWidth = particle.size * (1 - step / particle.trail.length) + .4;
          context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
        }
        const glow = particle.size * 3.4;
        const head = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, glow);
        head.addColorStop(0, `rgba(255,255,255,.9)`); head.addColorStop(.3, `rgba(${particle.hue},.7)`); head.addColorStop(1, `rgba(${particle.hue},0)`);
        context.fillStyle = head; context.beginPath(); context.arc(point.x, point.y, glow, 0, Math.PI * 2); context.fill();
      }

      for (let index = flashes.length - 1; index >= 0; index--) {
        const flash = flashes[index], age = (time - flash.born) / 600;
        if (age >= 1) { flashes.splice(index, 1); continue; }
        context.strokeStyle = `rgba(${flash.color},${(1 - age) * .6})`; context.lineWidth = 1.5;
        context.beginPath(); context.arc(flash.x, flash.y, flash.radius * (.4 + age * 1.6), 0, Math.PI * 2); context.stroke();
      }
      for (let index = sparks.length - 1; index >= 0; index--) {
        const spark = sparks[index], age = (time - spark.born) / spark.life;
        if (age >= 1) { sparks.splice(index, 1); continue; }
        spark.x += spark.vx * dt; spark.y += spark.vy * dt; spark.vx *= .96; spark.vy *= .96;
        context.fillStyle = `rgba(${spark.color},${1 - age})`; context.beginPath(); context.arc(spark.x, spark.y, 1.4, 0, Math.PI * 2); context.fill();
      }
      context.globalCompositeOperation = "source-over";
    };

    // re-measure on layout changes; burst when a classic count rises
    let previous = { long: 0, short: 0 };
    const refresh = () => {
      measure();
      if (counts.long > previous.long) for (let index = 0; index < Math.min(8, (counts.long - previous.long) * 4); index++) spawn("long", 1.4);
      if (counts.short > previous.short) for (let index = 0; index < Math.min(8, (counts.short - previous.short) * 4); index++) spawn("short", 1.4);
      previous = { long: counts.long, short: counts.short };
    };
    const resize = new ResizeObserver(refresh);
    resize.observe(host);
    const mutations = new MutationObserver(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(refresh); });
    let pending = 0;
    mutations.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-animated", "aria-pressed", "data-active"] });
    const seen = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); }, { rootMargin: "120px" });
    const attachSeen = () => { const target = host.querySelector('section[aria-labelledby="signal-flow-title"]'); if (target) seen.observe(target); };
    const settle = window.setTimeout(() => { refresh(); attachSeen(); }, 60);
    refresh(); attachSeen();
    window.addEventListener("resize", refresh);
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(pending); clearTimeout(settle);
      resize.disconnect(); mutations.disconnect(); seen.disconnect();
      window.removeEventListener("resize", refresh);
    };
  }, [hostRef]);

  return <canvas ref={canvasRef} className={styles.particles} aria-hidden="true" />;
}
