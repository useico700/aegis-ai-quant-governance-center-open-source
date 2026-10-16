import type { Metadata } from "next";
export const metadata: Metadata = { title: "S2｜账户监视器", description: "S2 开源模拟账户2独立权益、持仓、委托和成交流水。", icons: { icon: "/s2-logo.svg" } };
export default function S2Layout({ children }: { children: React.ReactNode }) { return children; }
