import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "账户权益影子验证｜ORION V2",
  description: "ORION V2 账户高水位、利润保护地板、压力止损权益与尾仓保留的只读前向影子验证。",
};

export default function AccountShadowLayout({ children }: { children: React.ReactNode }) {
  return children;
}
