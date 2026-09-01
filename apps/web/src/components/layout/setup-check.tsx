"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";

export function SetupCheck() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const isCodexLoginSession =
      pathname.startsWith("/sessions/") && searchParams.get("setup") === "codex-login";
    if (pathname === "/setup" || isCodexLoginSession) {
      setChecked(true);
      return;
    }

    api
      .getSetupStatus()
      .then(() => {})
      .catch(() => {
        // API not reachable — don't redirect, let user see the dashboard
      })
      .finally(() => setChecked(true));
  }, [pathname, searchParams]);

  return null;
}
