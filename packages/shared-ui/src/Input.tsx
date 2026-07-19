"use client";

import { useId, type ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export interface InputProps extends ComponentPropsWithRef<"input"> {
  /** Visible label rendered above the field and wired via htmlFor. */
  label?: string;
  /** Muted helper text below the field (hidden while `error` is shown). */
  hint?: string;
  /** Error message; also switches the border to the danger color. */
  error?: string;
}

/**
 * Labeled text input with hint/error states. All native input props pass
 * through; `className` is applied to the `<input>` element itself.
 */
export function Input({ label, hint, error, id, className, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedById = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedById}
        className={cx(
          "w-full rounded-md border bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-900 dark:text-zinc-50 dark:placeholder:text-zinc-500 dark:focus:ring-zinc-600",
          error
            ? "border-red-500 dark:border-red-500"
            : "border-zinc-300 dark:border-zinc-700",
          className,
        )}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
