/** Display helpers. Times show in the browser's own time zone. */

import { mToMi, sToH } from "./calc";

const whenFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const when = (ms: number | null | undefined): string => (ms == null ? "now" : whenFmt.format(ms));

const num1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fixed1 = (n: number): string => num1.format(n);
export const miles = (m: number | null | undefined): string => (m == null ? "—" : `${num1.format(mToMi(m))} mi`);
export const hours = (s: number | null | undefined): string => (s == null ? "—" : `${num1.format(sToH(s))} h`);

const pad = (n: number) => String(n).padStart(2, "0");

/** Epoch ms -> value for <input type="datetime-local"> in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) -> epoch ms, or NaN if empty/invalid. */
export const fromLocalInput = (v: string): number => (v ? new Date(v).getTime() : Number.NaN);

export const nowMinute = (): number => Math.floor(Date.now() / 60000) * 60000;

export const toIso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
