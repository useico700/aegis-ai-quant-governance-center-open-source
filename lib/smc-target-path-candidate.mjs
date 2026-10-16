import {TARGET_PATH_REVISION,validate4hFvgEvidence,assessTargetPath} from './smc-target-path.mjs';
import {smcNetRewardRisk} from './smc-scanner.mjs';
// Applies the same forward obstacle geometry to the pre-existing FVG model.
// No change to its confirmation/stop rules; no reference target may be skipped.
export function applyCandidateTargetPath(candidate,evidence,tickSize,now){
 validate4hFvgEvidence(evidence,now);
 if(evidence.symbol!==candidate.symbol)throw new Error('CANDIDATE_TARGET_PATH_SYMBOL');
 const referenceTarget=candidate.referenceTarget??candidate.target;
 const targetPath=assessTargetPath({evidence,direction:candidate.direction,entry:candidate.entry,stop:candidate.stop,referenceTarget,tickSize,now});
 if(!targetPath.ready)return {candidate:null,targetPath};
 const rr=smcNetRewardRisk({...candidate,target:targetPath.admissionTarget});
 return {targetPath,candidate:{...candidate,observedAt:now,target:targetPath.admissionTarget,...rr,referenceTarget,targetPathRevision:TARGET_PATH_REVISION,targetPath,sourceTargetPathEvidence:evidence}};
}
export function validateCandidateTargetPath(candidate,now){
 if(candidate.targetPathRevision!==TARGET_PATH_REVISION)throw new Error('CANDIDATE_TARGET_PATH_POLICY');
 const e=candidate.sourceTargetPathEvidence;
 validate4hFvgEvidence(e,now);
 const expected=applyCandidateTargetPath(candidate,e,e.tickSize,candidate.observedAt);
 if(!expected.candidate||candidate.referenceTarget==null)throw new Error('CANDIDATE_TARGET_PATH_UNAVAILABLE');
 for(const k of ['target','netR','riskPerUnit','netRewardPerUnit','targetPath'])if(JSON.stringify(candidate[k])!==JSON.stringify(expected.candidate[k]))throw new Error('CANDIDATE_TARGET_PATH_MISMATCH');
 return true;
}
