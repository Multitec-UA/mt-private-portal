import { NextResponse } from "next/server";

import { auth } from "@homarr/auth/next";

import { isEnabled, readFeed } from "../multitec/_lib/feed-store";
import { hasLiveMembership, renderPage, type SubscriptionRow } from "./_lib/page";

// "Gestionar suscripción" (Sergio, 2026-09-26). The member is already signed in (IAP), so
// they never type an e-mail:
//
//   1. Their row in the `member-subscription` feed (quantumpc joins the book to Stripe,
//      hourly) names their Stripe customer. Stripe customers carry the PERSONAL address,
//      so a search by the @multitecua.com one, which is all this service knows, found
//      almost nobody; that was the bug.
//   2. The subscription is re-checked live, so a member who paid a minute ago is not told
//      otherwise by a feed that is an hour old; with no customer in the feed, the customer
//      is searched live by `metadata.multitec_email` (written by n8n's renewal link) and by
//      the corporate address.
//   3. A live membership subscription goes straight into Stripe's portal. Anything else gets
//      the "Mi suscripción" page: where they stand, and their own renewal link.
//
// `?portal=1` opens the portal for any customer they have, for past payments.
const RETURN_URL = "https://socios.multitecua.com/boards/socios";
const STRIPE = "https://api.stripe.com/v1";

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });

async function stripeGet<T>(path: string, key: string): Promise<T | null> {
  try {
    const res = await fetch(`${STRIPE}/${path}`, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (!res.ok) {
      // The status only: a Stripe error body can echo the request.
      console.error("subscription: Stripe GET failed", path.split("?")[0], res.status);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.error("subscription: Stripe GET threw", path.split("?")[0], String(error));
    return null;
  }
}

async function findCustomer(email: string, key: string): Promise<string | undefined> {
  const q = encodeURIComponent(`metadata['multitec_email']:'${email.replace(/'/g, "")}'`);
  const byMeta = await stripeGet<{ data: { id: string }[] }>(`customers/search?query=${q}&limit=1`, key);
  if (byMeta?.data[0]?.id) return byMeta.data[0].id;
  const byEmail = await stripeGet<{ data: { id: string }[] }>(`customers?email=${encodeURIComponent(email)}&limit=1`, key);
  return byEmail?.data[0]?.id;
}

async function portalRedirect(customer: string, key: string): Promise<Response | null> {
  try {
    const res = await fetch(`${STRIPE}/billing_portal/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ customer, return_url: RETURN_URL, locale: "es" }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("subscription: Stripe portal session failed", res.status);
      return null;
    }
    const { url } = (await res.json()) as { url: string };
    return NextResponse.redirect(url, 307);
  } catch (error) {
    console.error("subscription: Stripe portal session threw", String(error));
    return null;
  }
}

export async function GET(request: Request) {
  const session = await auth();
  const email = (session?.user.email ?? "").trim().toLowerCase();
  const key = process.env.STRIPE_SECRET_KEY;
  const wantsPortal = new URL(request.url).searchParams.get("portal") === "1";

  let row: SubscriptionRow | undefined;
  if (email && isEnabled()) {
    const feed = await readFeed("member-subscription");
    const payload = feed?.payload as Record<string, SubscriptionRow> | undefined;
    row = payload?.[email];
  }

  let customer = row?.stripeCliente ?? undefined;
  if (email && key) {
    customer ??= await findCustomer(email, key);
    if (customer) {
      const subs = await stripeGet<{ data: Parameters<typeof hasLiveMembership>[0] }>(`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`, key);
      const live = subs ? hasLiveMembership(subs.data) : Boolean(row?.stripeActiva);
      if (live || wantsPortal) {
        const redirect = await portalRedirect(customer, key);
        if (redirect) return redirect;
      }
    }
  }

  return html(renderPage(row, email, Boolean(customer)));
}
