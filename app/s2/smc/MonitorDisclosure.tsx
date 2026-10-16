"use client";

import { useState, type ReactNode } from "react";

/** Closed sections omit their body from both the visual and accessible page. */
export default function MonitorDisclosure({ summary, className, children }: {
  summary: ReactNode; className?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && children}
  </details>;
}
