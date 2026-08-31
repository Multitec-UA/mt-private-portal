import { NextResponse } from "next/server";

import { auth } from "@homarr/auth/next";

// The generic Stripe customer-portal login page still asks a real customer to click a
// magic-link email before it shows them anything — prefilling the address only saves
// typing it. `claude-seats` (Multitec-UA/claude-seats, app/main.py `/portal`) already
// solved the actual problem for the same Stripe account: look the signed-in member up
// as a Customer, then mint them a **billing portal session**, which is a one-time,
// already-authenticated link straight into their own panel. This route is that same
// two-call shape, ported to this fork's own signed-in session.
const STRIPE_PORTAL_LOGIN_URL = "https://billing.stripe.com/p/login/9B63cu0re4Ro0v83A58IU01";
const RETURN_URL = "https://socios.multitecua.com/boards/socios";

function genericLoginRedirect(email: string | undefined) {
  const url = new URL(STRIPE_PORTAL_LOGIN_URL);
  url.searchParams.set("locale", "es");
  if (email) {
    url.searchParams.set("prefilled_email", email);
  }
  return NextResponse.redirect(url.toString(), 307);
}

export async function GET() {
  const session = await auth();
  const email = session?.user.email ?? undefined;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!email || !secretKey) {
    // No session, or the key isn't wired into this environment (e.g. a preview deploy) —
    // the prefilled login page is still a real, working fallback, never a dead end.
    return genericLoginRedirect(email);
  }

  const auth_header = { Authorization: `Bearer ${secretKey}` };

  const customerSearch = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
    { headers: auth_header },
  );
  if (!customerSearch.ok) {
    return genericLoginRedirect(email);
  }
  const customers = (await customerSearch.json()) as { data: { id: string }[] };
  const customerId = customers.data[0]?.id;
  if (!customerId) {
    // A real member with no Stripe customer yet (or one under a different email) — send
    // them to the page where they can still identify themselves.
    return genericLoginRedirect(email);
  }

  const portalSession = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { ...auth_header, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ customer: customerId, return_url: RETURN_URL }),
  });
  if (!portalSession.ok) {
    return genericLoginRedirect(email);
  }
  const { url } = (await portalSession.json()) as { url: string };

  return NextResponse.redirect(url, 307);
}
