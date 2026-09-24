import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deriveKey, verifyCheck } from "@/lib/crypto";
import { useI18n } from "@/i18n/index";
import { writeEncryptionSecretToHash } from "@/lib/capability/url";

interface UnlockFormProps {
  slug: string;
  salt: string;
  check: string;
  iterations: number;
  onUnlock: (key: CryptoKey) => void;
  embedded?: boolean;
  /** Host-owned window events (F2). Duplicate panes share one listener. */
  ownWindowEvents?: (types: readonly string[], handler: () => void) => () => void;
}

export function UnlockForm({
  slug,
  salt,
  check,
  iterations,
  onUnlock,
  embedded = false,
  ownWindowEvents,
}: UnlockFormProps) {
  const { t } = useI18n();
  const id = useId();
  const inputId = `${id}-key`;
  const headingId = `${id}-heading`;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const location = useLocation();
  const routerTarget = `${location.key}\u0000${location.pathname}\u0000${location.search}\u0000${location.hash}`;
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const targetRef = useRef({ slug, salt, check, iterations });
  const onUnlockRef = useRef(onUnlock);
  const routerTargetRef = useRef(routerTarget);

  const cancelPending = useCallback(() => {
    requestGenerationRef.current += 1;
    setPass("");
    setBusy(false);
    setError(null);
  }, []);

  useLayoutEffect(() => {
    onUnlockRef.current = onUnlock;
  }, [onUnlock]);

  useLayoutEffect(() => {
    if (
      targetRef.current.slug !== slug
      || targetRef.current.salt !== salt
      || targetRef.current.check !== check
      || targetRef.current.iterations !== iterations
    ) {
      targetRef.current = { slug, salt, check, iterations };
      requestGenerationRef.current += 1;
    }
  }, [slug, salt, check, iterations]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const stop = ownWindowEvents
      ? ownWindowEvents(["hashchange", "popstate"], cancelPending)
      : (() => {
          window.addEventListener("hashchange", cancelPending);
          window.addEventListener("popstate", cancelPending);
          return () => {
            window.removeEventListener("hashchange", cancelPending);
            window.removeEventListener("popstate", cancelPending);
          };
        })();
    return () => {
      stop();
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, [cancelPending, ownWindowEvents]);

  useLayoutEffect(() => {
    if (routerTargetRef.current === routerTarget) return;
    routerTargetRef.current = routerTarget;
    cancelPending();
  }, [routerTarget, cancelPending]);

  useEffect(() => {
    setPass("");
    setBusy(false);
    setError(null);
  }, [slug, salt, check, iterations]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pass.trim()) return;
    const requestGeneration = ++requestGenerationRef.current;
    const submittedPass = pass;
    const requestLocation = window.location.pathname
      + window.location.search
      + window.location.hash;
    let expectedLocation = requestLocation;
    const isCurrentRequestAt = (expectedLocation: string) => mountedRef.current
      && requestGenerationRef.current === requestGeneration
      && window.location.pathname + window.location.search + window.location.hash
        === expectedLocation;
    const cancelIfStale = (locationToCheck: string) => {
      if (isCurrentRequestAt(locationToCheck)) return false;
      if (
        mountedRef.current
        && requestGenerationRef.current === requestGeneration
      ) {
        cancelPending();
      }
      return true;
    };
    setBusy(true);
    setError(null);
    try {
      const key = await deriveKey(submittedPass, salt, iterations);
      if (cancelIfStale(requestLocation)) return;
      const ok = await verifyCheck(key, check);
      if (cancelIfStale(requestLocation)) return;
      if (!ok) {
        setError(t("unlock.wrong_key"));
        setBusy(false);
        return;
      }
      if (cancelIfStale(requestLocation)) return;
      try {
        expectedLocation = window.location.pathname
          + window.location.search
          + writeEncryptionSecretToHash(window.location.hash, submittedPass);
        history.replaceState(history.state, "", expectedLocation);
      } catch {
        expectedLocation = requestLocation;
      }
      if (cancelIfStale(expectedLocation)) return;
      onUnlockRef.current(key);
    } catch (err) {
      if (cancelIfStale(expectedLocation)) return;
      console.error(err);
      setError(t("unlock.decrypt_error"));
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex items-center justify-center bg-background px-4 ${
        embedded ? "h-full min-h-0" : "min-h-svh"
      }`}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-md border border-border p-6"
        aria-labelledby={headingId}
      >
        <div className="flex items-center gap-2">
          {!embedded && (
            <Link
              to="/"
              className="text-muted-foreground hover:text-foreground"
              aria-label={t("share.back_home_aria")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          )}
          <KeyRound className="h-4 w-4" />
          <h1 className="font-mono text-sm">/{slug}</h1>
        </div>
        <div>
          <h2 id={headingId} className="text-sm font-semibold">{t("unlock.heading")}</h2>
          <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
            {t("unlock.desc")}
          </p>
        </div>
        <label htmlFor={inputId} className="sr-only">{t("unlock.placeholder")}</label>
        <Input
          id={inputId}
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder={t("unlock.placeholder")}
          autoFocus={!embedded}
          aria-invalid={!!error}
          aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}
        />
        {error && (
          <p id={errorId} className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !pass.trim()}
          aria-busy={busy}
        >
          {busy && (
            <Loader2
              className="h-4 w-4 motion-safe:animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          <span>{t("unlock.submit")}</span>
        </Button>
        <p className="text-[11px] text-muted-foreground">
          {t("unlock.hint_prefix")} <code>#&lt;key&gt;</code> {t("unlock.hint_suffix")}
        </p>
      </form>
    </div>
  );
}
