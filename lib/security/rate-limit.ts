const windows = new Map<string, { count: number; resetAt: number }>();
const MAX_WINDOWS = 1_000;

function pruneWindows(now: number) {
  for (const [id, entry] of windows) if (entry.resetAt <= now) windows.delete(id);
  while (windows.size >= MAX_WINDOWS) {
    const oldest = windows.keys().next().value;
    if (typeof oldest !== "string") break;
    windows.delete(oldest);
  }
}

export function requestClientKey(request: Request) {
  const value = request.headers.get("x-vercel-forwarded-for")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]
    || "local";
  return value.trim().slice(0, 128) || "local";
}

export function checkRateLimit(key: string, limit = 6, windowMs = 60_000) {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    if (windows.size >= MAX_WINDOWS) pruneWindows(now);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  current.count += 1;
  return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count) };
}
