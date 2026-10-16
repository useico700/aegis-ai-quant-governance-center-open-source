/**
 * Abstract cube: a tesseract (4D hypercube) drawn as glowing glass wireframe.
 * Rotating through the fourth dimension makes the inner cube flow outward and turn inside out,
 * an endless abstract morph. Every few seconds it folds through faster and the vertices flash;
 * light packets travel along the edges. Pure canvas 2D, no libraries. Decoration only.
 */

type V4 = [number, number, number, number];

const VERTS: V4[] = [];
for (let index = 0; index < 16; index++) VERTS.push([index & 1 ? 1 : -1, index & 2 ? 1 : -1, index & 4 ? 1 : -1, index & 8 ? 1 : -1]);
const EDGES: Array<[number, number]> = [];
for (let a = 0; a < 16; a++) for (let bit = 0; bit < 4; bit++) { const b = a ^ (1 << bit); if (a < b) EDGES.push([a, b]); }
const FACES: number[][] = [];
for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
  const others = [0, 1, 2, 3].filter(axis => axis !== i && axis !== j);
  for (let fixed = 0; fixed < 4; fixed++) {
    const base = (fixed & 1 ? 1 << others[0] : 0) | (fixed & 2 ? 1 << others[1] : 0);
    FACES.push([base, base | (1 << i), base | (1 << i) | (1 << j), base | (1 << j)]);
  }
}
const NEIGHBOURS = VERTS.map((_, a) => EDGES.filter(edge => edge.includes(a)).map(([x, y]) => x === a ? y : x));

const plane = (v: V4, a: number, b: number, angle: number): V4 => {
  const out = [...v] as V4, c = Math.cos(angle), s = Math.sin(angle);
  out[a] = v[a] * c - v[b] * s; out[b] = v[a] * s + v[b] * c;
  return out;
};

export function createMorphCube() {
  let phase4 = 0, phaseSpin = .6, clock = 0, lastFold = -10;
  const packets: Array<{ from: number; to: number; t: number; speed: number; hops: number }> = [];

  return function draw(context: CanvasRenderingContext2D, width: number, height: number, time: number, dt: number, options: { live: boolean; still: boolean }) {
    context.clearRect(0, 0, width, height);
    const energy = options.live ? 1 : .62;
    if (!options.still) {
      clock += dt;
      // a "fold-through" pulse every ~5.5s (faster when live): 4D rotation surges, vertices flash
      const period = options.live ? 4.8 : 7;
      const local = clock % period, surge = local < 1.2 ? Math.sin(local / 1.2 * Math.PI) : 0;
      if (local < dt * 1.5) lastFold = clock;
      phase4 += dt * (.35 + surge * 1.9) * (options.live ? 1 : .7);
      phaseSpin += dt * .22 * (options.live ? 1 : .7);
      if (packets.length < (options.live ? 7 : 3) && Math.random() < dt * 3) { const from = Math.floor(Math.random() * 16); packets.push({ from, to: NEIGHBOURS[from][Math.floor(Math.random() * 4)], t: 0, speed: 1.4 + Math.random(), hops: 3 + Math.floor(Math.random() * 4) }); }
    }
    const flash = Math.max(0, 1 - (clock - lastFold) / .7);
    const cx = width / 2, cy = height / 2, unit = Math.min(width, height) * .2;

    const project = (v: V4) => {
      let p = plane(v, 0, 3, phase4);            // XW
      p = plane(p, 2, 3, phase4 * .62);          // ZW
      p = plane(p, 1, 3, Math.sin(phase4 * .4) * .35);
      const k4 = 2.6 / (2.6 - p[3]);             // 4D → 3D
      let x = p[0] * k4, y = p[1] * k4, z = p[2] * k4;
      const cy3 = Math.cos(phaseSpin), sy3 = Math.sin(phaseSpin);
      [x, z] = [x * cy3 + z * sy3, -x * sy3 + z * cy3];
      const tilt = -.42, ct = Math.cos(tilt), st = Math.sin(tilt);
      [y, z] = [y * ct - z * st, y * st + z * ct];
      const k3 = 6 / (6 + z);
      return { x: cx + x * unit * k3 * .62, y: cy + y * unit * k3 * .62, z, w: p[3], k: k4 * k3 };
    };
    const points = VERTS.map(project);

    // floor glow
    const floor = context.createRadialGradient(cx, cy + unit * 1.8, 0, cx, cy + unit * 1.8, unit * 2.1);
    floor.addColorStop(0, `rgba(92,200,245,${.1 + energy * .14 + flash * .16})`); floor.addColorStop(1, "rgba(92,200,245,0)");
    context.fillStyle = floor; context.beginPath(); context.ellipse(cx, cy + unit * 1.8, unit * 2.1, unit * .42, 0, 0, Math.PI * 2); context.fill();

    // glass faces, far to near, very faint so the volume reads as translucent
    const faces = FACES.map(face => ({ face, z: face.reduce((sum, index) => sum + points[index].z - points[index].w * .4, 0) / 4 })).sort((a, b) => b.z - a.z);
    for (const { face, z } of faces) {
      const [a, b, c, d] = face.map(index => points[index]);
      const near = Math.max(0, Math.min(1, (1.6 - z) / 3.2));
      const gradient = context.createLinearGradient(a.x, a.y, c.x, c.y);
      gradient.addColorStop(0, `rgba(92,200,245,${.025 + near * .05})`);
      gradient.addColorStop(.5, `rgba(235,250,255,${.01 + near * .035})`);
      gradient.addColorStop(1, `rgba(79,224,214,${.02 + near * .04})`);
      context.fillStyle = gradient;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.lineTo(c.x, c.y); context.lineTo(d.x, d.y); context.closePath(); context.fill();
    }

    // edges: inner (w>0 side) cyan, outer ice-white, brightness by depth
    context.lineCap = "round";
    const sorted = [...EDGES].sort(([a1, b1], [a2, b2]) => (points[a2].z + points[b2].z) - (points[a1].z + points[b1].z));
    for (const [a, b] of sorted) {
      const p = points[a], q = points[b];
      const near = Math.max(0, Math.min(1, (1.8 - (p.z + q.z) / 2) / 3.6));
      const inner = (p.w + q.w) / 2 > 0;
      const alpha = (.28 + near * .62) * (.75 + energy * .25) + flash * .25;
      context.strokeStyle = inner ? `rgba(79,224,214,${alpha})` : `rgba(175,232,255,${alpha})`;
      context.lineWidth = .7 + near * 1.3 + flash;
      context.shadowColor = inner ? "rgba(79,224,214,.9)" : "rgba(92,200,245,.9)"; context.shadowBlur = 6 + near * 8 + flash * 10;
      context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y); context.stroke();
    }
    context.shadowBlur = 0;

    // light packets travelling vertex to vertex
    context.globalCompositeOperation = "lighter";
    for (let index = packets.length - 1; index >= 0; index--) {
      const packet = packets[index];
      if (!options.still) packet.t += dt * packet.speed;
      if (packet.t >= 1) {
        packet.hops--; if (packet.hops <= 0) { packets.splice(index, 1); continue; }
        const next = NEIGHBOURS[packet.to].filter(n => n !== packet.from);
        packet.from = packet.to; packet.to = next[Math.floor(Math.random() * next.length)]; packet.t = 0;
      }
      const p = points[packet.from], q = points[packet.to];
      const x = p.x + (q.x - p.x) * packet.t, y = p.y + (q.y - p.y) * packet.t;
      const glow = context.createRadialGradient(x, y, 0, x, y, 7);
      glow.addColorStop(0, "rgba(255,255,255,.95)"); glow.addColorStop(.35, "rgba(120,230,255,.7)"); glow.addColorStop(1, "rgba(92,200,245,0)");
      context.fillStyle = glow; context.beginPath(); context.arc(x, y, 7, 0, Math.PI * 2); context.fill();
    }

    // vertices
    for (const p of points) {
      const near = Math.max(0, Math.min(1, (1.6 - p.z) / 3.2));
      const radius = (1.2 + near * 1.6) * (1 + flash * .8);
      const glow = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3.2);
      glow.addColorStop(0, `rgba(255,255,255,${.6 + near * .4})`); glow.addColorStop(.3, `rgba(140,230,255,${.35 + flash * .4})`); glow.addColorStop(1, "rgba(92,200,245,0)");
      context.fillStyle = glow; context.beginPath(); context.arc(p.x, p.y, radius * 3.2, 0, Math.PI * 2); context.fill();
    }
    context.globalCompositeOperation = "source-over";
  };
}
