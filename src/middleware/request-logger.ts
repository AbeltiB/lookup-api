import { createMiddleware } from "hono/factory";
import { logHttpEvent } from "@abeltib/lookup-core/workerd";
import type { AuthVariables } from "./internal-auth.js";

/**
 * Every request through this service is logged, authenticated or not —
 * "no action left untraced." Runs first in the middleware chain so it
 * still fires even if a later middleware (e.g. internalAuth) short-circuits
 * with a 401. The actor fields are filled in after internalAuth has run,
 * by reading whatever it set on the context (may be absent — that's
 * expected for /health and for rejected/unauthenticated calls).
 */
export const requestLogger = createMiddleware<{ Variables: Partial<AuthVariables> }>(async (c, next) => {
  const start = Date.now();

  await next();

  const auth = c.get("auth");
  logHttpEvent({
    action: "http.request",
    outcome: c.res.status < 400 ? "success" : "failure",
    message: `${c.req.method} ${c.req.path} -> ${c.res.status}`,
    actorId: auth?.sub ?? null,
    method: c.req.method,
    path: c.req.path,
    statusCode: c.res.status,
    durationMs: Date.now() - start,
    ip: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });
});
