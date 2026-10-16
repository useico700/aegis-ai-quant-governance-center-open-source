import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V3 监视器｜ORION",
  description: "V3 高频交易权益曲线与当前持仓监视器。",
  openGraph: { title: "V3 监视器", description: "简洁查看 V3 权益路径与当前持仓。", images: ["/v3-monitor-og.png"] },
};

export default function V3EquityLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
