import styles from "./header-market-backdrop.module.css";

// Fixed decorative geometry, not OHLC data, a price forecast or a live chart.
const candles = [
  [78, 62, 53, 89], [63, 71, 54, 83], [72, 49, 41, 80],
  [50, 57, 39, 68], [58, 37, 28, 67], [38, 47, 26, 58],
  [48, 67, 38, 77], [68, 55, 44, 83], [56, 73, 47, 86],
  [74, 61, 49, 88], [62, 42, 31, 72], [43, 51, 33, 64],
  [52, 30, 20, 63], [31, 40, 19, 53], [41, 59, 29, 70],
  [60, 48, 36, 74], [49, 65, 40, 78], [66, 52, 43, 80],
  [53, 36, 25, 66], [37, 46, 27, 58], [47, 28, 18, 59],
  [29, 41, 17, 52], [42, 57, 30, 69], [58, 45, 34, 72],
];

export default function HeaderMarketBackdrop() {
  const candleMarks = () => candles.map(([open, close, high, low], index) => {
        const x = 24 + index * 37;
        return <g key={index} className={close < open ? styles.up : styles.down}>
          <path className={styles.wick} d={`M${x} ${high}V${low}`} />
          <rect className={styles.body} x={x - 5} y={Math.min(open, close)} width="10" height={Math.abs(close - open)} rx="1" />
        </g>;
      });
  return <div className={styles.backdrop} aria-hidden="true">
    <svg className={styles.base} viewBox="0 0 900 110" preserveAspectRatio="xMidYMid slice" focusable="false">
      <g className={styles.grid}><path d="M0 25H900 M0 55H900 M0 85H900" /></g>
      {candleMarks()}
    </svg>
    {[styles.boltOne, styles.boltTwo, styles.boltThree, styles.boltFour].map((boltStyle) =>
      <svg key={boltStyle} className={`${styles.flash} ${boltStyle}`} viewBox="0 0 900 110" preserveAspectRatio="xMidYMid slice" focusable="false">
        {candleMarks()}
      </svg>
    )}
  </div>;
}
