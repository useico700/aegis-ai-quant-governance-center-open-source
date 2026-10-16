// Pure prospective opportunity review. No account access, order port, or fitted probability.
export const JEV_OPPORTUNITY_REVISION='JEV-SMC-OPPORTUNITY-1';
export function assessTimedOpportunity({plan,context,clock,reaction,now}) {
 const reasons=[],expected=plan.direction==='LONG'?'BULLISH':'BEARISH';
 const local=context?.frames?.['15m'], timing=context?.frames?.['5m'];
 if(!timing||timing.status!=='READY'||now-timing.availableAt>420000)reasons.push('REACTION_STRUCTURE_UNAVAILABLE');
 if(!local||local.status!=='READY'||now-local.availableAt>1020000)reasons.push('LOCAL_STRUCTURE_UNAVAILABLE');
 const anchorFits=plan.opportunity?.anchorLabel===(plan.direction==='LONG'?'HL':'LH');
 const sequenceFits=[expected,'RANGE'].includes(plan.opportunity?.sequenceBias);
 if(!anchorFits||!sequenceFits)reasons.push('WAIT_LOCAL_SMC_STRUCTURE');
 if(!plan.stopBasis?.ready||plan.stopBasis.entryValid===false)reasons.push('STRUCTURAL_STOP_UNCONFIRMED');
 if(!reaction.ready)reasons.push(reaction.reason);
 if(!(plan.netR>=2))reasons.push('NET_R_BELOW_2');
 const w=clock?.active;
 if(!w||now<w.opensAt||now>w.expiresAt||w.selectedAt>=w.opensAt||w.event.firstSeenAt>=w.opensAt)reasons.push('WAIT_INTERSECTION_WINDOW');
 if(w&&reaction.ready&&reaction.confirmation.closeTime<w.opensAt)reasons.push('WAIT_POST_INTERSECTION_REACTION');
 const conflicts=Object.entries(context?.frames??{}).filter(([,f])=>f.status==='READY'&&['BULLISH','BEARISH'].includes(f.bias)&&f.bias!==expected).map(([tf])=>tf);
 return {revision:JEV_OPPORTUNITY_REVISION,ready:reasons.length===0,reasons,
  // This baseline makes gate coverage measurable; it does not imply a hypothetical fill.
  baselineEligible:reasons.filter(r=>!['WAIT_INTERSECTION_WINDOW','WAIT_POST_INTERSECTION_REACTION'].includes(r)).length===0,
  clockEventId:w?.event.id??null,contextConflicts:conflicts,localAnchor:plan.opportunity?.anchorLabel??null,
  probabilityStatus:'UNVALIDATED_PROSPECTIVE_MODEL',winProbability:null,orderAuthority:false};
}

// Prospective local model: intersections cannot affect readiness or ranking.
export function assessLocalOpportunity({plan,context,reaction,now}) {
 const reasons=[],expected=plan.direction==='LONG'?'BULLISH':'BEARISH';
 const local=context?.frames?.['15m'], timing=context?.frames?.['5m'];
 if(!timing||timing.status!=='READY'||now-timing.availableAt>420000)reasons.push('REACTION_STRUCTURE_UNAVAILABLE');
 if(!local||local.status!=='READY'||now-local.availableAt>1020000)reasons.push('LOCAL_STRUCTURE_UNAVAILABLE');
 const anchorFits=plan.opportunity?.anchorLabel===(plan.direction==='LONG'?'HL':'LH');
 const sequenceFits=[expected,'RANGE'].includes(plan.opportunity?.sequenceBias);
 if(!anchorFits||!sequenceFits)reasons.push('WAIT_LOCAL_SMC_STRUCTURE');
 if(!plan.stopBasis?.ready||plan.stopBasis.entryValid===false)reasons.push('STRUCTURAL_STOP_UNCONFIRMED');
 if(!reaction.ready)reasons.push(reaction.reason);
 if(!(plan.netR>=2))reasons.push('NET_R_BELOW_2');
 const conflicts=Object.entries(context?.frames??{}).filter(([,f])=>f.status==='READY'&&['BULLISH','BEARISH'].includes(f.bias)&&f.bias!==expected).map(([tf])=>tf);
 return {revision:'JEV-SMC-OPPORTUNITY-2',ready:reasons.length===0,reasons,
  // This baseline makes gate coverage measurable; it does not imply a hypothetical fill.
  baselineEligible:reasons.length===0, intersectionAdmissionEffect:'NONE',
  contextConflicts:conflicts,localAnchor:plan.opportunity?.anchorLabel??null,
  probabilityStatus:'UNVALIDATED_PROSPECTIVE_MODEL',winProbability:null,orderAuthority:false};
}

// Active two-timeframe model: no 1H/5M inputs or votes.
export function assessDualFrameOpportunity({plan,context,reaction,now,entryGeometry=null}) {
 const reasons=[],expected=plan.direction==='LONG'?'BULLISH':'BEARISH',path2=plan.entryPolicyRevision==='SMC-ENTRY-PATHS-2';
 const geometry=path2?(entryGeometry??{entry:plan.entry,target:plan.targetPath?.admissionTarget??null,netR:plan.targetPath?.netR??null,targetPath:plan.targetPath??null}):null;
 const protectedEntry=path2?geometry.entry:plan.entry;
 const protectionReady=!!plan.stopBasis?.ready&&(path2?Number.isFinite(protectedEntry)&&Number.isFinite(plan.stopBasis.point?.price)
   &&(plan.direction==='LONG'?protectedEntry>plan.stopBasis.point.price:protectedEntry<plan.stopBasis.point.price):plan.stopBasis.entryValid!==false);
 const local=context?.frames?.['15m'], parent=context?.frames?.['4h'];
 if(!parent||parent.status!=='READY'||now-parent.availableAt>14520000)reasons.push('PARENT_STRUCTURE_UNAVAILABLE');
 if(!local||local.status!=='READY'||now-local.availableAt>1020000)reasons.push('LOCAL_STRUCTURE_UNAVAILABLE');
 const anchorFits=plan.opportunity?.anchorLabel===(plan.direction==='LONG'?'HL':'LH');
 const sequenceFits=[expected,'RANGE'].includes(plan.opportunity?.sequenceBias);
 if(plan.entryPolicyRevision ? local?.bias!==expected : !anchorFits||!sequenceFits)reasons.push('WAIT_LOCAL_SMC_STRUCTURE');
 if(!protectionReady)reasons.push('STRUCTURAL_STOP_UNCONFIRMED');
 if(!reaction.ready)reasons.push(reaction.reason);
 if(path2){
  const p=geometry.targetPath;
  const consistent=p?.revision==='SMC-TARGET-PATH-1'&&p.orderAuthority===false&&p.entry===geometry.entry
   &&p.admissionTarget===geometry.target&&p.netR===geometry.netR;
  if(!consistent)reasons.push('TARGET_PATH_EVIDENCE_MISSING');
  else if(!p.ready)reasons.push(p.reason??'TARGET_PATH_NOT_READY');
  if(!protectionReady||!Number.isFinite(geometry.netR)||geometry.netR<2)reasons.push('NET_R_BELOW_2');
 }else if(!(plan.netR>=2))reasons.push('NET_R_BELOW_2');
 const conflicts=Object.entries(context?.frames??{}).filter(([,f])=>f.status==='READY'&&['BULLISH','BEARISH'].includes(f.bias)&&f.bias!==expected).map(([tf])=>tf);
 return {revision:path2?'JEV-SMC-OPPORTUNITY-4':'JEV-SMC-OPPORTUNITY-3',ready:reasons.length===0,reasons,
  ...(path2?{entryPolicyRevision:plan.entryPolicyRevision,targetPathRevision:'SMC-TARGET-PATH-1',
    admissionEntry:geometry.entry,admissionTarget:protectionReady?geometry.target:null,admissionNetR:protectionReady?geometry.netR:null,
    targetPath:protectionReady?geometry.targetPath:geometry.targetPath?{...geometry.targetPath,ready:false,admissionTarget:null,netR:null,reason:'STRUCTURAL_STOP_UNCONFIRMED'}:null,protectionReady}:{}),
  // This baseline makes gate coverage measurable; it does not imply a hypothetical fill.
  baselineEligible:reasons.length===0, intersectionAdmissionEffect:'NONE',
  contextConflicts:conflicts,localAnchor:plan.opportunity?.anchorLabel??null,
  probabilityStatus:'UNVALIDATED_PROSPECTIVE_MODEL',winProbability:null,orderAuthority:false};
}
