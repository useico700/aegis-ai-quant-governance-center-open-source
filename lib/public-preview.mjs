export const PUBLIC_MODE='LOCAL_SIMULATED_VENUE';
const summary={fillCount:0,commissionUsdt:'0',realizedPnlUsdt:'0',netPnlUsdt:'0'};
export function publicApi(route,method='GET',receipt=null){
 const headers={'Cache-Control':'no-store','X-Aegis-Evidence':'SYNTHETIC_LOCAL_ONLY'};
 if(method!=='GET')return Response.json({status:'PUBLIC_DEMO_WRITE_DISABLED',exchangeOrdersAllowed:false},{status:405,headers});
 const now=Date.now(),at=new Date(receipt?.recordedAt??now).toISOString(),accountLabel=route.startsWith('s2-')?'S2':'S1';
 const positions=receipt?.positions??[];
 const details={unrealized:0,initialMargin:0,maintenanceMargin:0,positionMargin:0,orderMargin:0,multiAssetsMargin:false,positionsComplete:true,ordersComplete:true,algoOrdersComplete:true,
  positionRows:positions.map(p=>({symbol:p.symbol,side:p.direction===1?"LONG":p.direction===-1?"SHORT":p.direction,quantity:p.quantity,entryPrice:p.entry,markPrice:p.entry,liquidationPrice:null,unrealized:0,notional:Number(p.entry)*Number(p.quantity),leverage:1,marginType:'cross'})),regularOrders:[],conditionalOrders:[]};
 const account={observedAt:at,fresh:!!receipt,userStreamConnected:false,equity:receipt?100:null,wallet:receipt?100:null,available:receipt?100:null,positions:positions.length,orders:0,algoOrders:0,positionMode:'HEDGE',details};
 const snapshot={schemaVersion:1,accountLabel,mode:'SCAN_ONLY',sourceAsOf:at,sequence:1,startedAt:at,bootId:'PUBLIC_SYNTHETIC',status:receipt?'HEALTHY':'DEGRADED',scanDurationMs:0,scannedSymbols:0,universe:['SOLUSDT'],lastSuccessfulScanAt:null,account,candidates:[],marketQuotes:[],precision:{rules:[{symbol:'SOLUSDT',price:{step:'0.01'},lot:{step:'0.01'},synthetic:true}],errors:[]},errors:[],publish:{status:'LOCAL_ONLY',at},recovery:{stateRecovered:false},eventGate:{status:'CALENDAR_UNVERIFIED_PAUSE',newEntriesPaused:true,pauseUntil:null,calendarCheckedAt:null}};
 const execution={observedAt:at,realOrdersAllowed:false,entriesAllowed:false,liveReady:false,infrastructureReady:!!receipt,entryIncident:null,positionStages:positions.map(p=>({...p,direction:p.direction===1?"LONG":p.direction===-1?"SHORT":p.direction})),entryEvaluations:[],entryBlockers:[],candidatePriorities:[],openPositions:positions.length,openOrders:0,openAlgoOrders:0,service:'PUBLIC_SIMULATED_ENGINE',mode:PUBLIC_MODE,status:'SYNTHETIC',orderAuthorizationStatus:'EXCHANGE_DISABLED',candidateSource:{state:'READY',reason:null,checkedAt:now,observedAt:now,lastGoodAt:now,candidateCount:0},strategyRuntime:{displayName:accountLabel==='S2'?'R22 · S2 live risk':'R22 · local simulated venue',executionRevision:'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION',entryQualityPolicyRevision:'S1-R22-ROLLBACK-20261010',runtimeLoaded:!!receipt,riskPolicy:{mode:'SYNTHETIC_TEST_FIXTURE',perTradeFraction:'0.005',portfolioFraction:'0.005',maximumOpenPositions:1,maximumLeverage:1,maximumGrossNotionalLeverage:1,grossNotionalMustNotExceedEquity:true,effectiveMaximumGroupPositions:1}},publicSimulation:true};
 const base={mode:PUBLIC_MODE,synthetic:true,exchangeOrdersAllowed:false};
 if(['s1-monitor','s2-monitor'].includes(route))return Response.json({...base,status:'OK',snapshot,history:{status:'OK',points:[],firstObservedAt:null}},{headers});
 if(['s1-execution-ledger','s2-execution-ledger'].includes(route))return Response.json({...base,status:'OK',observedAt:at,receivedAt:at,execution,filteredCandidates:[],fills:[],summary,simulationReceipt:receipt?{recordedAt:receipt.recordedAt,entryStatus:receipt.entryStatus,protected:receipt.protected}:null},{headers});
 if(route==='observations')return Response.json({...base,status:'DISABLED_UNCONFIGURED',accounts:{},smc:null},{headers});
 if(route==='shadow')return Response.json({...base,status:'DISABLED_UNCONFIGURED',shadow:null},{headers});
 if(route==='s1-risk-calendar')return Response.json({...base,status:'UNVERIFIED',events:[],newEntriesPaused:true},{headers});
 if(route==='smc-opportunities')return Response.json({...base,status:'WAITING_FIRST_SNAPSHOT',snapshot:null},{headers});
 if(route==='smc-execution-ledger')return Response.json({...base,status:'WAITING_FIRST_SNAPSHOT',execution:null,fills:[],filteredCandidates:[],summary},{headers});
 if(route==='smc-live-quotes')return Response.json({...base,status:'DISABLED',quotes:[],rules:[]},{headers});
 return Response.json({...base,status:'UNCONFIGURED_PUBLIC_MODULE',snapshot:null,ledger:null,execution:null,accounts:{},rows:[],events:[],messages:[],candidates:[],records:[],positions:[],history:[],summary},{headers});
}
