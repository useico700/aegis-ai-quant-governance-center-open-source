"use client";
import { useEffect, useId, useState, type CSSProperties } from "react";
import { signalFlow } from "../../lib/s1-signal-flow.mjs";
import styles from "./signal-flow.module.css";
type Row = { status: string; direction: string | null; stale: boolean };
function Fiber({ path }: { path: string }) {
  return <><path d={path} className={styles.sheath} /><path d={path} className={styles.fiber} /><path d={path} pathLength={100} className={styles.trail} /><path d={path} pathLength={100} className={styles.packet} /></>;
}
function BrainGlyph() {
  return <svg className={styles.brainGlyph} viewBox="0 0 98 86" aria-hidden="true">
    <path className={styles.brainShape} d="M49 14 C42 7 31 9 28 20 C18 15 12 24 17 31 C8 34 8 44 16 49 C12 59 21 67 30 66 C34 74 44 76 49 69 C54 76 64 74 68 66 C77 67 86 59 82 49 C90 44 90 34 81 31 C86 24 80 15 70 20 C67 9 56 7 49 14 Z" />
    <path className={styles.brainFold} d="M49 15 C46 22 52 27 49 34 C46 41 52 46 49 54 V69 M28 20 C34 24 37 27 35 33 C28 31 24 36 27 42 M17 33 C25 33 27 38 24 45 C28 50 35 46 38 53 M18 52 C25 49 27 55 28 62 M37 14 C43 18 39 24 44 28 M36 63 C43 60 44 55 40 50 M70 20 C64 23 59 25 61 33 C68 31 73 36 70 42 M81 32 C74 36 76 41 74 46 C69 49 65 47 62 54 M81 54 C73 51 72 58 68 64 M60 15 C55 18 57 24 53 28 M62 63 C54 58 56 54 59 49" />
    <path className={styles.brainStem} d="M45 70 C44 76 45 80 49 80 C53 80 54 76 53 70" />
    <circle className={styles.brainNode} cx="35" cy="33" r="1.7" />
    <circle className={styles.brainNode} cx="74" cy="46" r="1.7" />
  </svg>;
}
// Fixed, asymmetric trajectories avoid hydration randomness and leave the labels clear.
const ingress = [
  [158, 9, 2.35, -.18, 34], [202, 18, 2.8, -1.7, 27],
  [170, 43, 2.15, -.95, 44], [224, 61, 3.1, -2.2, 24],
  [184, 78, 2.5, -1.1, 41], [146, 109, 2.9, -.6, 36],
  [177, 149, 2.2, -1.6, 45], [215, 132, 2.65, -.3, 30],
  [254, 153, 3.05, -2.5, 39], [295, 143, 2.4, -1.3, 24],
  [237, 97, 2.05, -.7, 31], [151, 132, 3.25, -2.1, 46],
  [256, 70, 2.75, -1.9, 20], [280, 112, 2.3, -.45, 28],
];
function Meteors({ compact = false }: { compact?: boolean }) {
  const gradientId = `meteor-${useId().replace(/:/g, "")}`;
  const relayGradientId = `${gradientId}-relay`;
  const flights = compact
    ? [[8, 5, 2.35, -.2, 13], [30, 0, 2.8, -1.6, 10], [78, 2, 2.15, -.8, 16],
      [95, 22, 2.65, -1.2, 14], [4, 44, 3.1, -2.1, 11], [85, 55, 2.4, -.5, 12],
      [25, 30, 2.9, -1.9, 15], [66, 12, 2.2, -1.1, 10]]
    : ingress;
  return <g className={styles.meteors}>
    <defs><linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
      <stop offset="55%" stopColor="currentColor" stopOpacity=".25" />
      <stop offset="90%" stopColor="currentColor" stopOpacity=".85" />
      <stop offset="100%" stopColor="var(--meteor-core)" />
    </linearGradient><linearGradient id={relayGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
      <stop offset="55%" stopColor="currentColor" stopOpacity=".38" />
      <stop offset="90%" stopColor="var(--meteor-core)" stopOpacity=".9" />
      <stop offset="100%" stopColor="var(--meteor-core)" />
    </linearGradient></defs>
    {flights.map(([x, y, duration, delay, length], index) => {
      const startX = compact ? x * 1.4 : x;
      const endX = compact ? 70 : 340, endY = compact ? 84 : 80;
      const angle = Math.atan2(endY - y, endX - startX) * 180 / Math.PI;
      return <g key={index} className={styles.meteorFlight} style={{
        "--meteor-from": `translate(${startX}px, ${y}px)`, "--meteor-to": `translate(${endX}px, ${endY}px)`,
        "--meteor-duration": `${duration}s`, "--meteor-delay": `${delay}s`,
      } as CSSProperties}>
        <g transform={`rotate(${angle})`}>
          <path d={`M ${-length} 0 Q -8 -1.8 0 0 Q -8 1.8 ${-length} 0`} fill={`url(#${gradientId})`} />
          <circle r={compact ? .9 : 1.3} className={styles.meteorHead} />
        </g>
      </g>;
    })}
    {compact && <g className={`${styles.meteorFlight} ${styles.relay}`} style={{
      "--meteor-from": "translate(70px, 84px)", "--meteor-to": "translate(70px, 103px)",
      "--meteor-duration": "1.65s", "--meteor-delay": "-.4s",
    } as CSSProperties}>
      <g transform="rotate(90)"><path d="M -22 0 Q -7 -2.5 0 0 Q -7 2.5 -22 0" fill={`url(#${relayGradientId})`} />
        <circle r="4.3" className={styles.relayHalo} /><circle r="2" className={styles.relayHead} /></g>
    </g>}
    {!compact && [0, 1, 2].map(index => <g key={`relay-${index}`} className={`${styles.meteorFlight} ${styles.relay}`} style={{
      "--meteor-from": "translate(340px, 80px)", "--meteor-to": "translate(485px, 80px)",
      "--meteor-duration": "1.7s", "--meteor-delay": `${index * -.57}s`,
    } as CSSProperties}>
      <path d="M -58 0 Q -16 -2.7 0 0 Q -16 2.7 -58 0" fill={`url(#${relayGradientId})`} />
      <circle r="4.8" className={styles.relayHalo} /><circle r="2.1" className={styles.relayHead} />
    </g>)}
  </g>;
}
export default function SignalFlow({ candidates, fresh, configured = true, accountLabel = "S1", structureProfile = accountLabel }: { candidates?: Row[]; fresh: boolean; configured?: boolean; accountLabel?: "S1" | "S2"; structureProfile?: "S1" | "S2" }) {
  const [enabled, setEnabled] = useState(true), [visible, setVisible] = useState(false);
  useEffect(() => { const update = () => setVisible(!document.hidden); update(); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  const counts = signalFlow(candidates, fresh, configured);
  const channels = [{ id: "long", label: "多头已确认", value: counts.long, y: 28, x: 25 }, { id: "short", label: "空头已确认", value: counts.short, y: 132, x: 75 }];
  const hasCandidates = counts.available && (counts.long! + counts.short! + counts.pending!) > 0;
  return <section className={styles.flow} aria-labelledby="signal-flow-title" data-account={accountLabel} data-animated={enabled && visible && counts.available}>
    <div className={styles.heading}><div><h2 id="signal-flow-title">多空信号流</h2><p>{configured ? "原始结构数 · 非资金流或盘口强弱" : "尚未配置策略扫描"}</p></div><button type="button" disabled={!configured} aria-pressed={configured && enabled} onClick={() => setEnabled((value) => !value)}>{!configured ? "未配置" : enabled ? "暂停动效" : "开启动效"}</button></div>
    <div className={styles.network}>
      <svg aria-hidden="true" className={styles.circuit} viewBox="0 0 1000 160" preserveAspectRatio="none">
        <g className={styles.scan} data-active={hasCandidates}>
          <Meteors />
          <circle cx="340" cy="80" r="10" className={styles.convergenceGlow} />
          <circle cx="340" cy="80" r="2.5" className={styles.node} />
        </g>
        {channels.map((channel) => <g key={channel.id} className={styles[channel.id]} data-active={!!channel.value}>
          <Fiber path={`M 540 80 H 610 C 690 80 710 ${channel.y} 800 ${channel.y}`} />
        </g>)}
      </svg>
      <div className={styles.origin} data-active={hasCandidates}>
        <span>结构扫描</span>
        <div className={styles.thought} aria-hidden="true">
          <svg className={styles.eeg} viewBox="0 0 184 96" preserveAspectRatio="xMidYMid meet">
            <path d="M 0 49 H 10 L 15 45 L 19 52 L 23 39 L 27 61 L 33 44 L 39 48 L 45 46 L 50 55 L 56 49 H 62" />
            <path d="M 122 49 L 128 47 L 133 55 L 138 43 L 143 49 L 149 29 L 153 65 L 159 45 L 164 50 L 170 48 L 175 42 L 179 53 L 184 49" />
          </svg>
          <span className={styles.brain}><BrainGlyph /></span>
          <span className={styles.formulaOne}>L₁∩L₂</span>
          <span className={styles.formulaTwo}>Δt</span>
          <span className={styles.formulaThree}>Px</span>
        </div>
        <strong>{configured ? structureProfile === "S2" ? "1H × 15M" : "4H × 1H" : "未配置"}</strong>
        <small>{configured ? "多周期结构汇集" : "无扫描器"}</small>
      </div>
      <div className={styles.incoming} data-active={hasCandidates}>
        <div className={styles.confirmation}><h3 aria-label={configured ? `结构确认 · ${structureProfile === "S2" ? "5M" : "15M"} 收线校验` : "等待策略配置"}>{configured ? structureProfile === "S2" ? "5M" : "15M" : "—"}</h3></div>
        <svg aria-hidden="true" className={styles.mobile} viewBox="0 0 140 100" preserveAspectRatio="xMidYMid meet"><Meteors compact /></svg>
      </div>
      <div className={styles.gate} data-active={hasCandidates}>
        <svg className={styles.cubeField} viewBox="0 0 200 168" aria-hidden="true">
          <path className={styles.cubeConduit} d="M0 84 H30 L44 73 M156 95 L170 84 H200" />
          <path className={styles.cubeFrame} d="M100 12 L158 44 L158 124 L100 156 L42 124 L42 44 Z" />
          <path className={styles.cubeTop} d="M42 44 L100 12 L158 44 L100 72 Z M64 32 L100 49 L136 32" />
          <path className={styles.cubeLeft} d="M42 44 L100 72 L100 156 L42 124 Z M42 84 L63 94 M42 103 L63 113" />
          <path className={styles.cubeRight} d="M158 44 L100 72 L100 156 L158 124 Z M158 84 L137 94 M158 103 L137 113" />
          <path className={styles.cubeDiamond} d="M100 10 L166 84 L100 158 L34 84 Z M100 10 L126 43 M166 84 L135 105 M100 158 L74 124 M34 84 L65 63" />
          <path className={styles.cubeNested} d="M100 24 L148 51 L148 117 L100 144 L52 117 L52 51 Z M52 51 L76 64 M148 51 L124 64 M52 117 L75 105 M148 117 L125 105" />
          <path className={styles.cubeOrbit} d="M22 57 L33 49 M167 49 L178 57 M22 111 L33 119 M167 119 L178 111" />
          <circle className={styles.cubeIntake} cx="42" cy="84" r="3" />
          <circle className={styles.cubeOutput} cx="158" cy="84" r="3" />
        </svg>
        <dl className={styles.pending} data-active={!!counts.pending}><div><dt className={styles.pendingLabel}>结构待确认</dt><dd><span className={styles.pendingFigure}><span className={styles.pendingEcho} aria-hidden="true">{counts.pending ?? "—"}</span><span className={styles.pendingValue}>{counts.pending ?? "—"}</span></span></dd></div></dl>
      </div>
      <div className={styles.branches} aria-hidden="true">
        <svg className={styles.mobile} viewBox="0 0 100 100" preserveAspectRatio="none">{channels.map((channel) => <g key={channel.id} className={styles[channel.id]} data-active={!!channel.value}><Fiber path={`M 50 0 C 50 50 ${channel.x} 50 ${channel.x} 100`} /></g>)}</svg>
      </div>
      <dl className={styles.outcomes} title={structureProfile === "S1" ? "按未过期的原始结构计数；候选列表逐计划显示，备查结构也计入" : "按未过期的原始结构计数；同币重合结构在候选列表合并，备查结构也计入"}>{channels.map((channel) => <div key={channel.id} className={styles[channel.id]}><dt>{channel.label}</dt><dd>{channel.value ?? "—"}<small>个结构</small></dd></div>)}</dl>
    </div>
    {(!configured || !counts.available) && <p className={styles.note}>{!configured ? "此账户尚未配置策略扫描器，方向统计暂不可用。" : counts.available ? `扫描进入确认环节；待确认候选留在中央，通过后按多空方向分流。另有 ${counts.excluded} 个过期或不合格计划不参与；光点仅表达信息传递。` : "数据待同步或已过时：方向统计与流动效果暂不可用。"}</p>}
  </section>;
}
