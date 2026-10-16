import { referenceCalibration, type validateRules } from "../../lib/s1-precision.mjs";
import { formatBinancePrice } from "../../lib/s1-price-display.mjs";
import styles from "./s1.module.css";
export type PrecisionRule = ReturnType<typeof validateRules>;
export type MarketQuote = { symbol: string; status: string; bidPrice?: string; askPrice?: string; exchangeTime?: string; observedAt?: string; tickSize?: string };
export function QuotePrice({ quote, now, stale }: { quote?: MarketQuote; now: number; stale: boolean }) {
  const age = now - Date.parse(quote?.exchangeTime ?? "");
  const available = !stale && now > 0 && quote?.status === "QUOTED" && age >= -5000 && age <= 90000 && quote.bidPrice && quote.askPrice && quote.tickSize;
  return <div className={styles.priceCalibration}>{available ? <><span>买一 {formatBinancePrice(quote.bidPrice, quote.tickSize, quote)}</span><br /><span>卖一 {formatBinancePrice(quote.askPrice, quote.tickSize, quote)}</span><small>行情 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(quote.exchangeTime!))}</small></> : <span className={styles.warning}>报价待更新</span>}</div>;
}
export default function PriceCalibration({ price, symbol, rule, quote, now, stale }: { price: number | null; symbol: string; rule?: PrecisionRule; quote?: MarketQuote; now: number; stale: boolean }) {
  const value = !stale && now && price !== null ? referenceCalibration(price, rule, symbol, now) : null;
  return <div className={styles.priceCalibration}>
    {value?.status === "REFERENCE_ONLY" ? <><span>{value.lower === value.upper ? formatBinancePrice(value.lower, value.tickSize, quote) : `${formatBinancePrice(value.lower, value.tickSize, quote)} – ${formatBinancePrice(value.upper, value.tickSize, quote)}`}</span><small>价格步长 {value.tickSize} USDT</small><small>数量步长 {value.quantityStep} / 市价 {value.marketQuantityStep}</small></> : <span className={styles.warning}>{stale ? "快照过时 · 不可用" : "交易规则待核验"}</span>}
    <details><summary>原始交点价</summary><p>{price === null ? "—" : String(price)}</p><p>上下相邻合法价位仅供参考，不是买卖报价或订单。提交前须按方向、订单类型及最新规则重新校验。</p></details>
  </div>;
}
