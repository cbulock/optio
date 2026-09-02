"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export const SETUP_DISMISSED_STORAGE_KEY = "optio.setup.dismissed";

export function SetupCheck() {
  const pathname = usePathname();
  const router = useRouter();
  const [setupIncomplete, setSetupIncomplete] = useState(false);

  useEffect(() => {
    // Don't redirect if already on setup page
    if (pathname === "/setup") {
      setSetupIncomplete(false);
      return;
    }

    api
      .getSetupStatus()
      .then((res) => {
        if (res.isSetUp) {
          window.localStorage.removeItem(SETUP_DISMISSED_STORAGE_KEY);
          setSetupIncomplete(false);
          return;
        }

        if (window.localStorage.getItem(SETUP_DISMISSED_STORAGE_KEY) === "true") {
          setSetupIncomplete(true);
          return;
        }

        router.replace("/setup");
      })
      .catch(() => {
        // API not reachable — don't redirect, let user see the dashboard
      });
  }, [pathname, router]);

  if (!setupIncomplete) return null;

  return (
    <div className="shrink-0 bg-warning/10 border-b border-warning/30 px-4 py-2 text-sm">
      <span className="font-medium text-text-heading">Setup is incomplete.</span>{" "}
      <span className="text-text-muted">Tasks requiring an agent credential will fail. </span>
      <a href="/setup" className="underline hover:text-text transition-colors">
        Resume setup
      </a>
    </div>
  );
}
