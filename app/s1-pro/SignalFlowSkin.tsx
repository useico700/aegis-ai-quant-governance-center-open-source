"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import styles from "./s1-pro.module.css";

/**
 * 3D skin for the classic 多空信号流: a rotating point-cloud brain, a glass cube and depth cards
 * drawn exactly over the classic brain / cube / outcome cards (which are hidden only while this
 * skin has located them — if anything can't be found, the classic visuals simply stay visible).
 * Numbers are read from the classic section's own text; the skin never computes its own.
 */

type Box = { x: number; y: number; w: number; h: number };
type Layout = { brain: Box; cube: Box; long: Box; short: Box; stacked: boolean };
type Values = { long: string; short: string; pending: string; live: boolean; paused: boolean };

const SECTION = 'section[aria-labelledby="signal-flow-title"]';
const box = (element: Element | null | undefined, host: DOMRect): Box | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width && rect.height ? { x: rect.left - host.left, y: rect.top - host.top, w: rect.width, h: rect.height } : null;
};
const same = (a: Layout | null, b: Layout | null) => JSON.stringify(a) === JSON.stringify(b);
const round = (value: Box): Box => ({ x: Math.round(value.x), y: Math.round(value.y), w: Math.round(value.w), h: Math.round(value.h) });

/* ---------------- 3D helpers ---------------- */
type V3 = [number, number, number];
const rotate = ([x, y, z]: V3, ay: number, ax: number): V3 => {
  const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
};
const project = ([x, y, z]: V3, scale: number, cx: number, cy: number, distance = 3.2) => {
  const f = distance / (distance + z);
  return { x: cx + x * scale * f, y: cy + y * scale * f, z, f };
};

// Outline and folds of the classic S1 brain glyph (viewBox 98 × 86), reused so the 3D brain keeps its identity.
const BRAIN_SHAPE = "M49 14 C42 7 31 9 28 20 C18 15 12 24 17 31 C8 34 8 44 16 49 C12 59 21 67 30 66 C34 74 44 76 49 69 C54 76 64 74 68 66 C77 67 86 59 82 49 C90 44 90 34 81 31 C86 24 80 15 70 20 C67 9 56 7 49 14 Z";
const BRAIN_FOLDS = "M49 15 C46 22 52 27 49 34 C46 41 52 46 49 54 V69 M28 20 C34 24 37 27 35 33 C28 31 24 36 27 42 M17 33 C25 33 27 38 24 45 C28 50 35 46 38 53 M18 52 C25 49 27 55 28 62 M37 14 C43 18 39 24 44 28 M36 63 C43 60 44 55 40 50 M70 20 C64 23 59 25 61 33 C68 31 73 36 70 42 M81 32 C74 36 76 41 74 46 C69 49 65 47 62 54 M81 54 C73 51 72 58 68 64 M60 15 C55 18 57 24 53 28 M62 63 C54 58 56 54 59 49";
const BRAIN_STEM = "M45 70 C44 76 45 80 49 80 C53 80 54 76 53 70";
const SLICES = [-3, -2, -1, 0, 1, 2, 3];
function brainNodes() { // synapse nodes inside the outline, deterministic
  if (typeof document === "undefined") return [] as Array<[number, number]>;
  const probe = document.createElement("canvas").getContext("2d");
  const shape = new Path2D(BRAIN_SHAPE);
  let seed = 11; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const nodes: Array<[number, number]> = [];
  for (let tries = 0; tries < 600 && nodes.length < 46; tries++) {
    const x = 10 + random() * 78, y = 8 + random() * 66;
    if (probe?.isPointInPath(shape, x, y)) nodes.push([x, y]);
  }
  return nodes;
}

const CUBE: V3[] = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const CUBE_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const CUBE_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];

/* ---------------- component ---------------- */
export default function SignalFlowSkin({ hostRef }: { hostRef: React.RefObject<HTMLDivElement | null> }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [values, setValues] = useState<Values>({ long: "—", short: "—", pending: "—", live: false, paused: false });
  const brainRef = useRef<HTMLCanvasElement>(null), cubeRef = useRef<HTMLCanvasElement>(null);
  const longRef = useRef<HTMLDivElement>(null), shortRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(values);
  useEffect(() => { liveRef.current = values; }, [values]);

  /* measure + read classic values */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const section = host.querySelector(SECTION);
      const hostRect = host.getBoundingClientRect();
      const brain = box(section?.querySelector('[class*="brainGlyph"]'), hostRect);
      const cube = box(section?.querySelector('[class*="cubeField"]'), hostRect);
      const outcomes = section?.querySelectorAll('[class*="outcomes"] > div');
      const long = box(outcomes?.[0], hostRect), short = box(outcomes?.[1], hostRect);
      const next = brain && cube && long && short ? { brain: round(brain), cube: round(cube), long: round(long), short: round(short), stacked: cube.y - brain.y > Math.abs(cube.x - brain.x) } : null;
      setLayout(previous => same(previous, next) ? previous : next);
      host.dataset.skin = next ? "on" : "off";
      const number = (element: Element | null | undefined) => (element?.querySelector("dd")?.childNodes[0]?.textContent ?? element?.querySelector("dd")?.textContent ?? "—").trim();
      const nextValues: Values = {
        long: number(outcomes?.[0]), short: number(outcomes?.[1]),
        pending: (section?.querySelector('[class*="pendingValue"]')?.textContent ?? "—").trim(),
        live: section?.getAttribute("data-animated") === "true",
        paused: section?.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed") === "false",
      };
      setValues(previous => JSON.stringify(previous) === JSON.stringify(nextValues) ? previous : nextValues);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    const resize = new ResizeObserver(schedule); resize.observe(host);
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-animated", "aria-pressed"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); delete host.dataset.skin; };
  }, [hostRef]);

  /* arrival pulses fired by the particle layer */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const arrive = (event: Event) => {
      const target = (event as CustomEvent<string>).detail === "long" ? longRef.current : shortRef.current;
      target?.animate([{ boxShadow: "0 0 0 0 var(--tone-glow), var(--card-depth)" }, { boxShadow: "0 0 0 10px transparent, var(--card-depth)" }], { duration: 700, easing: "ease-out" });
    };
    host.addEventListener("s1pro:arrive", arrive);
    return () => host.removeEventListener("s1pro:arrive", arrive);
  }, [hostRef]);

  /* brain + cube render loop */
  useEffect(() => {
    const brainCanvas = brainRef.current, cubeCanvas = cubeRef.current;
    if (!layout || !brainCanvas || !cubeCanvas) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const setup = (canvas: HTMLCanvasElement) => {
      const width = canvas.clientWidth, height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d")!; context.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { context, width, height };
    };
    const brain = setup(brainCanvas), cube = setup(cubeCanvas);
    const fires: Array<{ edge: number; born: number }> = [];
    let frame = 0, angle = 0, cubeAngle = 0, last = 0, fireClock = 0, visible = true;
    const seen = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); });
    seen.observe(cubeCanvas);

    const shape = new Path2D(BRAIN_SHAPE), folds = new Path2D(BRAIN_FOLDS), stem = new Path2D(BRAIN_STEM);
    const nodes = brainNodes();
    const drawBrain = (time: number) => {
      const { context, width, height } = brain;
      context.clearRect(0, 0, width, height);
      const cx = width / 2, cy = height / 2 + 1, unit = Math.min(width / 150, height / 104) * .92, depth = 15 * unit;
      const yaw = Math.sin(angle) * .85;
      const halo = context.createRadialGradient(cx, cy, 0, cx, cy, 58 * unit);
      halo.addColorStop(0, "rgba(92,200,245,.28)"); halo.addColorStop(1, "rgba(92,200,245,0)");
      context.fillStyle = halo; context.beginPath(); context.arc(cx, cy, 58 * unit, 0, Math.PI * 2); context.fill();
      const ring = (radius: number, tilt: number, speed: number, color: string, front: boolean) => {
        const scale = 34 * unit;
        context.beginPath();
        let started = false;
        for (let step = 0; step <= 72; step++) {
          const t = step / 72 * Math.PI * 2;
          const p = project(rotate([Math.cos(t) * radius, 0, Math.sin(t) * radius], time * speed, tilt), scale, cx, cy);
          if ((p.z < 0) !== front) { started = false; continue; }
          if (!started) { context.moveTo(p.x, p.y); started = true; } else context.lineTo(p.x, p.y);
        }
        context.strokeStyle = color; context.lineWidth = 1; context.stroke();
        const dot = project(rotate([radius, 0, 0], time * speed * 2.4, tilt), scale, cx, cy);
        if ((dot.z < 0) === front) { context.fillStyle = "rgba(235,248,255,.95)"; context.beginPath(); context.arc(dot.x, dot.y, 2 * dot.f, 0, Math.PI * 2); context.fill(); }
      };
      ring(1.75, .3, .00035, "rgba(92,200,245,.22)", false); ring(1.55, -.24, -.00028, "rgba(79,224,214,.2)", false);
      // volumetric slices, back to front
      const order = [...SLICES].sort((a, b) => a * Math.sin(yaw) - b * Math.sin(yaw));
      const scan = ((time * .00045) % 1.3) - .15; // holographic scan line, 0..1 of height
      for (const k of order) {
        const z = k / 3, shrink = Math.sqrt(1 - .5 * z * z), front = k === order[order.length - 1];
        const nearness = (order.indexOf(k) + 1) / order.length;
        context.save();
        context.translate(cx + z * Math.sin(yaw) * depth * 3, cy + z * 2 * unit);
        context.scale(Math.cos(yaw) * shrink * unit, shrink * unit);
        context.translate(-49, -44);
        context.lineWidth = 1.2 / unit;
        context.fillStyle = `rgba(92,200,245,${.035 + nearness * .03})`; context.fill(shape);
        context.strokeStyle = `rgba(${front ? "190,238,255" : "92,200,245"},${.12 + nearness * .5})`; context.stroke(shape);
        if (front || k === 0) {
          context.strokeStyle = `rgba(150,225,255,${front ? .75 : .3})`; context.lineWidth = 1 / unit; context.stroke(folds); context.stroke(stem);
          if (front && scan > 0 && scan < 1) { // scan band clipped to the brain outline
            context.save(); context.clip(shape);
            const y = 8 + scan * 72, band = context.createLinearGradient(0, y - 6, 0, y + 6);
            band.addColorStop(0, "rgba(92,200,245,0)"); band.addColorStop(.5, "rgba(210,245,255,.55)"); band.addColorStop(1, "rgba(92,200,245,0)");
            context.fillStyle = band; context.fillRect(0, y - 6, 98, 12); context.restore();
          }
        }
        context.restore();
      }
      // synapse fires on the front slice
      context.globalCompositeOperation = "lighter";
      const frontZ = order[order.length - 1] / 3, frontShrink = Math.sqrt(1 - .5 * frontZ * frontZ);
      const toScreen = ([x, y]: [number, number]) => ({ x: cx + frontZ * Math.sin(yaw) * depth * 3 + (x - 49) * Math.cos(yaw) * frontShrink * unit, y: cy + frontZ * 2 * unit + (y - 44) * frontShrink * unit });
      for (let index = fires.length - 1; index >= 0; index--) {
        const fire = fires[index], age = (time - fire.born) / 620;
        if (age >= 1 || !nodes.length) { fires.splice(index, 1); continue; }
        const a = toScreen(nodes[fire.edge % nodes.length]), b = toScreen(nodes[(fire.edge * 7 + 3) % nodes.length]);
        const x = a.x + (b.x - a.x) * age, y = a.y + (b.y - a.y) * age;
        context.strokeStyle = `rgba(79,224,214,${(1 - age) * .35})`; context.lineWidth = .8;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(x, y); context.stroke();
        const glow = context.createRadialGradient(x, y, 0, x, y, 5);
        glow.addColorStop(0, "rgba(255,255,255,.95)"); glow.addColorStop(.4, "rgba(79,224,214,.6)"); glow.addColorStop(1, "rgba(79,224,214,0)");
        context.fillStyle = glow; context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.fill();
      }
      for (const node of nodes) { const p = toScreen(node); context.fillStyle = "rgba(170,230,255,.35)"; context.fillRect(p.x - .6, p.y - .6, 1.2, 1.2); }
      context.globalCompositeOperation = "source-over";
      ring(1.75, .3, .00035, "rgba(92,200,245,.55)", true); ring(1.55, -.24, -.00028, "rgba(79,224,214,.45)", true);
    };

    const drawCube = (time: number) => {
      const { context, width, height } = cube;
      context.clearRect(0, 0, width, height);
      const cx = width / 2, cy = height / 2, scale = Math.min(width, height) * .25;
      const live = liveRef.current.live;
      const floor = context.createRadialGradient(cx, cy + scale * 1.55, 0, cx, cy + scale * 1.55, scale * 1.8);
      floor.addColorStop(0, `rgba(92,200,245,${live ? .26 : .14})`); floor.addColorStop(1, "rgba(92,200,245,0)");
      context.fillStyle = floor; context.beginPath(); context.ellipse(cx, cy + scale * 1.55, scale * 1.8, scale * .38, 0, 0, Math.PI * 2); context.fill();
      const drawOne = (size: number, ay: number, ax: number, faceAlpha: number, edgeAlpha: number, color: string) => {
        const verts = CUBE.map(v => project(rotate([v[0] * size, v[1] * size, v[2] * size], ay, ax), scale, cx, cy, 5));
        const faces = CUBE_FACES.map(face => ({ face, z: face.reduce((sum, index) => sum + verts[index].z, 0) / 4 })).sort((a, b) => b.z - a.z);
        for (const { face, z } of faces) {
          const front = z < 0;
          const gradient = context.createLinearGradient(verts[face[0]].x, verts[face[0]].y, verts[face[2]].x, verts[face[2]].y);
          gradient.addColorStop(0, `rgba(${color},${faceAlpha * (front ? 1 : .45)})`); gradient.addColorStop(.5, `rgba(255,255,255,${faceAlpha * .35 * (front ? 1 : .3)})`); gradient.addColorStop(1, `rgba(${color},${faceAlpha * .25})`);
          context.fillStyle = gradient; context.beginPath();
          face.forEach((index, step) => step ? context.lineTo(verts[index].x, verts[index].y) : context.moveTo(verts[index].x, verts[index].y));
          context.closePath(); context.fill();
        }
        context.shadowColor = `rgba(${color},.9)`; context.shadowBlur = 10;
        for (const [a, b] of CUBE_EDGES) {
          const depth = (2.4 - (verts[a].z + verts[b].z) / 2) / 4.8;
          context.strokeStyle = `rgba(${color},${edgeAlpha * (.35 + depth * .9)})`; context.lineWidth = .8 + depth * 1.4;
          context.beginPath(); context.moveTo(verts[a].x, verts[a].y); context.lineTo(verts[b].x, verts[b].y); context.stroke();
        }
        context.shadowBlur = 0;
        for (const v of verts) { context.fillStyle = `rgba(235,248,255,${.4 + (1 - (v.z + 1.6) / 3.2) * .6})`; context.beginPath(); context.arc(v.x, v.y, 1.8 * v.f, 0, Math.PI * 2); context.fill(); }
        return verts;
      };
      drawOne(.55, -cubeAngle * 1.6, .62, .05, .55, "79,224,214");
      drawOne(1, cubeAngle, -.5, .16, 1, "92,200,245");
      // scan plane sweeping through the cube
      const sweep = Math.sin(time * .0012) * .95;
      const plane = [[-1, sweep, -1], [1, sweep, -1], [1, sweep, 1], [-1, sweep, 1]].map(v => project(rotate(v as V3, cubeAngle, -.5), scale, cx, cy, 5));
      context.fillStyle = "rgba(92,200,245,.07)"; context.strokeStyle = "rgba(160,230,255,.45)"; context.lineWidth = 1;
      context.beginPath(); plane.forEach((p, index) => index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath(); context.fill(); context.stroke();
    };

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(.05, (time - (last || time)) / 1000); last = time;
      if (!visible || document.hidden) return;
      const { live, paused } = liveRef.current;
      const still = reduced || paused;
      if (!still) {
        angle += dt * (live ? .7 : .4); cubeAngle += dt * (live ? .5 : .28);
        fireClock += dt * (live ? 9 : 3);
        while (fireClock >= 1) { fireClock -= 1; fires.push({ edge: Math.floor(Math.random() * 997), born: time }); }
      }
      drawBrain(time); drawCube(still ? 0 : time);
      if (still && reduced) cancelAnimationFrame(frame);
    };
    frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame); seen.disconnect(); };
  }, [layout]);

  if (!layout) return null;
  const { brain, cube, long, short, stacked } = layout;
  const brainSize = { w: Math.max(brain.w * 2.9, 168), h: Math.max(brain.h * 1.9, 104) };
  const cubeSize = { w: cube.w * 1.1, h: cube.h * 1.2 };
  const grow = stacked ? 0 : 12;
  const tilt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--rx", `${((event.clientY - rect.top) / rect.height - .5) * -10}deg`);
    event.currentTarget.style.setProperty("--ry", `${((event.clientX - rect.left) / rect.width - .5) * 12}deg`);
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  };
  const untilt = (event: PointerEvent<HTMLDivElement>) => { event.currentTarget.style.setProperty("--rx", "0deg"); event.currentTarget.style.setProperty("--ry", "0deg"); };
  const card = (kind: "long" | "short", area: Box, value: string, ref: React.RefObject<HTMLDivElement | null>) => {
    const lit = Number(value) > 0;
    return <div ref={ref} className={styles.skinCard} data-skin-card={kind} data-dir={kind} data-lit={lit} data-stacked={stacked} onPointerMove={tilt} onPointerLeave={untilt}
      style={{ left: area.x, top: area.y - grow, width: area.w, height: area.h + grow * 2 } as CSSProperties}>
      <i className={styles.skinReceiver} aria-hidden="true" />
      <span className={styles.skinIcon} aria-hidden="true"><svg viewBox="0 0 24 24">{kind === "long" ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}</svg></span>
      <div className={styles.skinCopy}><small>{kind === "long" ? "多头已确认" : "空头已确认"}</small><b>{value}<em>个结构</em></b></div>
      <span className={styles.skinSheen} aria-hidden="true" />
    </div>;
  };

  return <div className={styles.skin} aria-hidden="true">
    <canvas ref={brainRef} className={styles.skinBrain} style={{ left: brain.x + brain.w / 2 - brainSize.w / 2, top: brain.y + brain.h / 2 - brainSize.h / 2, width: brainSize.w, height: brainSize.h }} data-skin-anchor="brain" />
    <div className={styles.skinCubeWrap} style={{ left: cube.x + cube.w / 2 - cubeSize.w / 2, top: cube.y + cube.h / 2 - cubeSize.h / 2, width: cubeSize.w, height: cubeSize.h }} data-skin-anchor="cube" data-live={values.live}>
      <canvas ref={cubeRef} className={styles.skinCube} />
      <div className={styles.skinPending}><b>{values.pending}</b><small>结构待确认</small></div>
    </div>
    {card("long", long, values.long, longRef)}
    {card("short", short, values.short, shortRef)}
  </div>;
}
