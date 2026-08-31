import { NextResponse } from "next/server";

import { auth } from "@homarr/auth/next";

// The generic Stripe customer-portal login page asks every visitor to type their email
// and wait for a magic link. Stripe reads `prefilled_email` from the query string and
// fills that field in, so a signed-in member skips typing it — this is the one thing
// that lets a single shared Homarr link behave as if it were personal per member.
const STRIPE_PORTAL_LOGIN_URL = "https://billing.stripe.com/p/login/9B63cu0re4Ro0v83A58IU01";

export async function GET() {
  const session = await auth();

  const url = new URL(STRIPE_PORTAL_LOGIN_URL);
  url.searchParams.set("locale", "es");
  if (session?.user.email) {
    url.searchParams.set("prefilled_email", session.user.email);
  }

  return NextResponse.redirect(url.toString());
}
