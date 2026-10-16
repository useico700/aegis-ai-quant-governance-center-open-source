import type { ReactNode } from "react";
import "./style.css";

export const metadata = { title: "AEGIS · JEV 信号研究", description: "S1/S2 候选的独立证据观察与排序" };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body><div style={{padding:"10px 20px",background:"#15241e",color:"#b0edce",fontSize:13,textAlign:"center"}}>AEGIS 开源版 · JEV 源码与界面保留 · 推理/影子未启用 · 无订单权限</div>{children}</body></html>;
}
