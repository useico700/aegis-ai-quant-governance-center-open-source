import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MTFX｜在线监视器",
  description: "ORION V2 MTFX R22 的候选计划、平衡落袋、R21八币浮盈保护、账户与持仓在线只读监视器。",
  openGraph: {
    title: "MTFX｜在线监视器",
    description: "R22候选计划、平衡落袋、R21八币浮盈保护、持仓管理与账户风险的只读在线视图。",
    images: [{ url: "/og-mtfx-monitor.png", width: 1536, height: 1024, alt: "MTFX 在线监视器" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "MTFX｜在线监视器",
    description: "R22候选计划、平衡落袋、R21八币浮盈保护、持仓管理与账户风险的只读在线视图。",
    images: ["/og-mtfx-monitor.png"],
  },
};

export default function LedgerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
