"use client";

import { useCallback, useRef, useState } from "react";
import s from "./Dialog.module.css";

export interface AskOptions {
  title: string;
  body?: string;
  ok?: string;
  /** Pass a string to turn the dialog into a prompt; resolves to the typed value. */
  input?: string;
  inputLabel?: string;
}

/**
 * A confirm/prompt built into the page. The browser's own dialogs block the render loop and
 * look nothing like the console, so destructive actions route through this instead.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<AskOptions | null>(null);
  const [value, setValue] = useState("");
  const resolver = useRef<((v: unknown) => void) | null>(null);

  const ask = useCallback((o: AskOptions) => {
    setOpts(o);
    setValue(o.input ?? "");
    return new Promise<unknown>(res => { resolver.current = res; });
  }, []);

  const settle = (ok: boolean) => {
    const o = opts;
    setOpts(null);
    resolver.current?.(ok ? (o?.input !== undefined ? value.trim() : true) : null);
    resolver.current = null;
  };

  const node = opts ? (
    <div className={s.backdrop} onClick={() => settle(false)}>
      <div className={s.dialog} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <h3>{opts.title}</h3>
        {opts.body && <p>{opts.body}</p>}
        {opts.input !== undefined && (
          <label className={s.field}>
            <span>{opts.inputLabel ?? "Name"}</span>
            <input className="mono" autoFocus value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") settle(true); }} />
          </label>
        )}
        <menu>
          <button className="btn" onClick={() => settle(false)}>Cancel</button>
          <button className="btn primary" onClick={() => settle(true)}>{opts.ok ?? "Confirm"}</button>
        </menu>
      </div>
    </div>
  ) : null;

  return { ask, node };
}
