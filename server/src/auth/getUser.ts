import type { Request } from "express";
import { supabase } from "../config/supabase.js";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface VerifiedTokenUser {
  id: string;
  email: string | null;
  exp: number | null;
}

export async function verifyToken(token: string): Promise<VerifiedTokenUser | null> {
  const { data, error } = await supabase.auth.getClaims(token);
  if (error) {
    if ([400, 401, 403].includes(error.status ?? 0)) return null;
    throw error;
  }
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const exp =
    typeof claims.exp === "number"
      ? claims.exp
      : typeof claims.exp === "string"
        ? Number(claims.exp)
        : null;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    exp: exp !== null && Number.isFinite(exp) ? exp : null,
  };
}

export async function getUserFromRequest(req: Request): Promise<AuthUser | null> {
  const authorization = req.headers.authorization;
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!bearer) return null;
  const verified = await verifyToken(bearer[1]);
  return verified ? { id: verified.id, email: verified.email } : null;
}