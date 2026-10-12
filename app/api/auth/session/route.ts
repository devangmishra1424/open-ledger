import { handle, sessionUser } from "@/lib/http";
import { authConfig } from "@/lib/auth/config";

/**
 * GET /api/auth/session — public. Tells the frontend whether sign-in is required here, whether the
 * server is configured for it, and who the presented token belongs to (null if none or invalid).
 */
export const GET = handle("GET /api/auth/session", async (req) => {
  const config = authConfig();
  return Response.json({
    required: config.required,
    configured: config.problem === null,
    problem: config.problem,
    user: sessionUser(req),
  });
});
