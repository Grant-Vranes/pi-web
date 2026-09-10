"use client";

import { useEffect, useState } from "react";
import { loadProjectAliases, subscribeProjectAliases, type ProjectAliasMap } from "@/lib/project-alias";

/** Reactive view of the per-project display-name aliases. Re-reads whenever
 *  a rename happens on this page (rail tooltip) or in another tab (storage
 *  event), so consumers like the chat window's new-session header stay in
 *  sync with the sidebar. */
export function useProjectAliases(): ProjectAliasMap {
  const [aliases, setAliases] = useState<ProjectAliasMap>(() => loadProjectAliases());
  useEffect(() => subscribeProjectAliases(() => setAliases(loadProjectAliases())), []);
  return aliases;
}
