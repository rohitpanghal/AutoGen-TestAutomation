// Shared origin predicate. Used both by @fastify/cors (normal routes) and by the
// SSE route in routes/jobs.ts, which writes to reply.raw and therefore bypasses
// the cors plugin's header injection — it has to set Access-Control-Allow-Origin
// itself using this same rule.
export function isAllowedOrigin(origin?: string | null): boolean {
  return (
    !origin ||
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('http://localhost')
  );
}
