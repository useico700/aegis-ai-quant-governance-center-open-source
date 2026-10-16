"use client";
import {useState} from "react";
import {installPrompt} from "../../lib/agent-install-prompt";
export default function Install(){const [message,setMessage]=useState("");
 return <main style={{maxWidth:1000,margin:"40px auto",padding:24,color:"#dce8e1",fontFamily:"monospace"}}>
 <h1>AEGIS 原项目开源版 · Agent 安装</h1><p>默认用原S1/S2引擎和本地模拟交易所验收。无需私人账户或API Key。</p>
 <button style={{padding:"12px 20px",margin:"20px 0",cursor:"pointer"}} onClick={async()=>{try{await navigator.clipboard.writeText(installPrompt);setMessage("已复制");}catch{setMessage("复制失败，请手动选择下方文本");}}}>复制完整安装提示词</button>
 <span role="status" style={{marginLeft:16}}>{message}</span>
 <textarea readOnly aria-label="Agent安装提示词" value={installPrompt} style={{width:"100%",minHeight:650,padding:20,background:"#12201b",color:"#dce8e1",lineHeight:1.8,border:"1px solid #456555"}}/>
 <p><a href="/s1">S1驾驶舱</a> · <a href="/s2">S2驾驶舱</a></p></main>;
}
