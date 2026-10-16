import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "V4 监视器｜ORION",
  description: "ORION V4 MTFX R22 的账户、仓位、候选与浮盈保护只读监视器。",
  openGraph: {
    title: "V4 监视器｜ORION",
    description: "以独立空间化界面查看 V4 MTFX R22 的账户、仓位、候选与浮盈保护。",
    images: [],
  },
  twitter: {
    card: "summary",
    title: "V4 监视器｜ORION",
    description: "以独立空间化界面查看 V4 MTFX R22 的账户、仓位、候选与浮盈保护。",
    images: [],
  },
};

export default function V4MonitorLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
