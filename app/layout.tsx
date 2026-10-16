import type { Metadata } from "next";
import "./globals.css";


export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: "ORION｜在线监视器",
  description: "ORION V2、V3 与 V4 的只读在线监视器：账户、仓位、候选计划、风险状态与权益学习曲线。",
  openGraph: {
    title: "ORION｜在线监视器",
    description: "只读查看 ORION V2、V3 与独立空间化 V4 监视器。",
    images: [{ url: "/og-mtfx-monitor.png", width: 1536, height: 1024, alt: "MTFX 在线监视器" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ORION｜在线监视器",
    description: "只读查看 ORION V2、V3 与独立空间化 V4 监视器。",
    images: ["/og-mtfx-monitor.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className="antialiased"
      >
        <div style={{padding:"10px 20px",background:"#15241e",color:"#b0edce",fontSize:13,textAlign:"center",position:"relative",zIndex:100}}>AEGIS 开源版 · 本地模拟交易所 / 合成证据 · 无真实账户或交易所下单权限 · <a href="/install">复制安装提示词</a> · <a href="http://127.0.0.1:3001">JEV 研究页</a></div>{children}
      </body>
    </html>
  );
}
