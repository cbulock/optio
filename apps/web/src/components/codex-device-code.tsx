"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

type CodexDeviceCodeProps = {
  deviceCode?: string | null;
};

export function CodexDeviceCode({ deviceCode }: CodexDeviceCodeProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const code = deviceCode?.trim();

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  if (!code) return null;

  const copyCode = async () => {
    if (!navigator.clipboard?.writeText) return;

    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }

    setCopied(true);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
      <code className="min-w-0 flex-1 select-all text-center font-mono text-lg font-semibold tracking-widest text-text">
        {code}
      </code>
      <button
        type="button"
        onClick={copyCode}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-card px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-primary/40 hover:text-text"
        aria-label="Copy device code"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
