#!/usr/bin/env node

import { evaluateTestnetReadiness } from "../integrations/binance-usdm-testnet/readiness.mjs";

process.stdout.write(`${JSON.stringify(await evaluateTestnetReadiness(), null, 2)}\n`);
