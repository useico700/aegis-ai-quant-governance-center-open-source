import type { Metadata } from "next";
export const metadata: Metadata = { title: "S1｜账户与执行监视器", description: "S1 独立账户、真实成交流水、R22.4 + IQ1 P4 执行状态与候选扫描。", icons: { icon: { url: "/s1-logo.svg", type: "image/svg+xml" }, shortcut: "/s1-logo.svg" } };
export default function S1Layout({ children }: { children: React.ReactNode }) { return children; }
