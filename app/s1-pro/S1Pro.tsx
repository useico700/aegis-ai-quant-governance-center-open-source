"use client";

import { useEffect, useRef, useState } from "react";
import AccountMonitor from "../s1/page";
import SignalParticles from "./SignalParticles";
import SignalFlowSkin from "./SignalFlowSkin";
import AmbientField from "./AmbientField";
import { useMotionLayer } from "./motion-layer";
import { demoRequested, installDemoMode } from "./demo-mode";
import styles from "./s1-pro.module.css";

// Demo shim must exist before the classic page starts polling; it only activates with ?demo=1.
if (typeof window !== "undefined") installDemoMode();

/**
 * S1 Pro = the classic S1 monitor, rendered unchanged, plus a motion layer around it.
 * Every number, rule and label still comes from app/s1; changes there show up here automatically.
 */
export default function S1Pro() {
  const host = useRef<HTMLDivElement>(null);
  const [demo, setDemo] = useState(false);
  useMotionLayer(host);
  useEffect(() => { const frame = requestAnimationFrame(() => setDemo(demoRequested())); return () => cancelAnimationFrame(frame); }, []);
  return <div ref={host} className={styles.pro}>
    <AmbientField />
    <AccountMonitor accountLabel="S1" />
    <SignalFlowSkin hostRef={host} />
    <SignalParticles hostRef={host} />
    {demo && <span className={styles.demoBadge}>DEMO 演示数据 · 非真实账户</span>}
  </div>;
}
