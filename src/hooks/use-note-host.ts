import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  acquireNoteHost,
  DEFAULT_NOTE_HOST_GATE,
  getNoteHost,
  releaseNoteHost,
  type NoteHost,
  type NoteHostGate,
} from "@/lib/yjs/note-host";

/**
 * Retain a tab-scoped note host for this pane's lifetime and subscribe to its
 * shared encryption/session gate. First layout effect in the caller should
 * still use `getNoteHost(key)` after this hook's effect (definition order).
 */
export function useNoteHost(key: string | null): {
  host: NoteHost | null;
  gate: NoteHostGate;
} {
  const [, setEpoch] = useState(0);

  useLayoutEffect(() => {
    if (!key) return;
    acquireNoteHost(key);
    setEpoch((value) => value + 1);
    return () => releaseNoteHost(key);
  }, [key]);

  const host = key ? getNoteHost(key) : null;
  const gate = useSyncExternalStore(
    (onStoreChange) => (host ? host.subscribe(onStoreChange) : () => {}),
    () => (host ? host.getGate() : DEFAULT_NOTE_HOST_GATE),
    () => DEFAULT_NOTE_HOST_GATE,
  );

  return { host, gate };
}
