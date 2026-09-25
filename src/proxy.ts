import { type NextRequest, NextResponse } from "next/server";
import { requireBasicAuth } from "./lib/auth.ts";

export function proxy(request: NextRequest) {
  const response = requireBasicAuth(request) ?? NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "microphone=(self), camera=()");
  return response;
}

export const config = {
  // Keep /api and /models protected, including requests with extensions.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
