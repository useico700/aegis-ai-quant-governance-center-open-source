"use client";

import type { InputHTMLAttributes } from "react";
import { formatPriceDigitStream } from "../../../lib/smc-price-input.mjs";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "pattern" | "value" | "onChange"> & {
  value: string;
  tickSize: string | null;
  onValueChange: (value: string) => void;
};

export default function PriceDigitInput({ value, tickSize, onValueChange, onFocus, ...props }: Props) {
  return <input {...props}
    type="text"
    inputMode="numeric"
    pattern="[0-9]*"
    value={value}
    onFocus={event => {
      onFocus?.(event);
      const input = event.currentTarget;
      requestAnimationFrame(() => input.select());
    }}
    onChange={event => onValueChange(formatPriceDigitStream(event.currentTarget.value, tickSize))}
  />;
}
