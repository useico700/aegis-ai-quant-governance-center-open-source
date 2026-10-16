# AEGIS public edition
This is a full-source derivative of the stated upstream GitHub commit, not the separate MA experiment.
Read README.md, governance/current-state.json and docs/AGENT_PROMPT.md.
Preserve cockpit, S1/S2 strategy, scanners, execution, risk, evidence, JEV and TradingView architecture.
Default to the local simulated venue. Never inherit another operator's permissions, balances, credentials, hosts or samples.
Run npm run setup, npm test and npm run verify:migration. Model evidence is synthetic, not market PnL.
Original host launchers are disabled for direct launch. Do not remove guards to make installation pass.
Custom Demo integration requires user credentials, explicit scope, fail-closed controls and a single writer.
Never request secrets in chat, activate live trading, transfer funds, create keys or restart private JEV services during installation.
