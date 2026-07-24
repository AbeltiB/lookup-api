import { createMiddleware } from "hono/factory";
import { verifyInternalJwt } from "@abeltib/lookup-core";
import { ERROR_CODES, type InternalJwtPayload } from "@abeltib/lookup-shared";

export type AuthVariables = { auth: InternalJwtPayload };

/**
 * Verifies the short-lived internal JWT lookup-web mints per request
 * (product doc §3.2 option 1). This is the ONLY caller of lookup-api in
 * Phase 1-2 — no browser or bot calls this service directly yet, so
 * there's no session-cookie or CORS story here on purpose.
 */
export const internalAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    return c.json({ error: { code: ERROR_CODES.UNAUTHORIZED, message: "Missing bearer token" } }, 401);
  }

  try {
    const payload = await verifyInternalJwt(token);
    c.set("auth", payload);
  } catch {
    return c.json({ error: { code: ERROR_CODES.UNAUTHORIZED, message: "Invalid or expired token" } }, 401);
  }

  await next();
});
