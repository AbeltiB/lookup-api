import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { hasPermission } from "@abeltib/lookup-core";
import { AppError, ERROR_CODES, PERMISSIONS } from "@abeltib/lookup-shared";
import { internalAuth, type AuthVariables } from "./middleware/internal-auth.js";
import { requestLogger } from "./middleware/request-logger.js";

const app = new Hono<{ Variables: AuthVariables }>();

// Outermost middleware — logs every request, authenticated or not,
// including ones internalAuth rejects with a 401 (§"nothing left untraced").
app.use("*", requestLogger);

// No auth required — used by Cloudflare/uptime checks.
app.get("/health", (c) => c.json({ status: "ok" }));

const v1 = new Hono<{ Variables: AuthVariables }>();
v1.use("*", internalAuth);

// Placeholder route proving the internal-JWT round trip end-to-end;
// real lookup/provider-routing endpoints land in Phase 1.
v1.get("/me", (c) => {
  const auth = c.get("auth");
  return c.json({
    userId: auth.sub,
    roles: auth.roles,
    isAdminOrSupport: hasPermission(auth.permissions, PERMISSIONS.USER_VIEW),
  });
});

app.route("/v1", v1);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.httpStatus as ContentfulStatusCode,
    );
  }
  console.error(err);
  return c.json({ error: { code: ERROR_CODES.INTERNAL, message: "Internal server error" } }, 500);
});

export default app;
