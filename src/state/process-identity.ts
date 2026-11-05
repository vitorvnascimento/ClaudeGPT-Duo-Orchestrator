import { spawnSync } from "node:child_process";

/** Only a start time definitely later than the reservation proves PID reuse. */
export function startedAfterReservation(startedAt: string, processStartMs: number | null): boolean {
  const reservation = Date.parse(startedAt);
  return Number.isFinite(reservation) && new Date(reservation).toISOString() === startedAt &&
    processStartMs !== null && Number.isFinite(processStartMs) && processStartMs > reservation;
}

/** macOS ps reports lstart with one-second precision. Unknown platforms/results stay conservative. */
export function processStartTime(pid: number): number | null {
  if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  try {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 2000, maxBuffer: 4096,
      env: { LC_ALL: "C", TZ: "UTC0" },
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
    const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(result.stdout.trim());
    if (!match) return null;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months.indexOf(match[1]!);
    const [, , day, hour, minute, second, year] = match;
    const time = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
    const date = new Date(time);
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month || date.getUTCDate() !== Number(day) ||
        date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)) return null;
    return time;
  } catch { return null; }
}
