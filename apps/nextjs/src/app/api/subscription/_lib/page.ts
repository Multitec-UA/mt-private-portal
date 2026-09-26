/**
 * "Mi suscripción": what a member sees when they have no live membership subscription in
 * Stripe, and the one decision that sends everybody else straight into Stripe's portal.
 *
 * Sergio, 2026-09-26: a member opened "Gestionar suscripción", typed their e-mail into
 * Stripe's generic login and got nothing and no word, because they still paid by hand and
 * Stripe had no customer for them. Now the panel, which already knows who is asking (IAP),
 * decides by itself: a live membership subscription goes to Stripe with no e-mail and no
 * code; anything else gets this page, which says in plain Spanish where they stand and
 * gives them their own renewal link.
 *
 * The facts come from the `member-subscription` feed, which quantumpc publishes hourly by
 * joining the members' book to Stripe (bin/qpc-portal-feed). A pure module, so it is tested
 * without Stripe or a session.
 */

export const MEMBERSHIP_PRODUCT = "prod_TL62rjjzyfFv4c";
export const PAYMENT_LINK = "https://buy.stripe.com/bJefZg4Hu6Zw1zc0nT8IU00";
export const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;

/** One member's row in the `member-subscription` feed. */
export interface SubscriptionRow {
  nombre?: string | null;
  cuotaHasta?: string | null;
  diasRestantes?: number | null;
  stripeCliente?: string | null;
  stripeActiva?: boolean;
  renovarUrl?: string | null;
}

interface StripeSubscriptionLike {
  status?: string;
  items?: { data?: { price?: { product?: string | { id?: string } } }[] };
}

/** True when any of these subscriptions is a live Multitec membership (a Claude seat is not). */
export const hasLiveMembership = (subs: StripeSubscriptionLike[]): boolean =>
  subs.some(
    (sub) =>
      (LIVE_STATUSES as readonly string[]).includes(sub.status ?? "") &&
      (sub.items?.data ?? []).some((item) => {
        const product = item.price?.product;
        return (typeof product === "string" ? product : product?.id) === MEMBERSHIP_PRODUCT;
      }),
  );

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Where the big button goes: their personal link (data prefilled, days kept), else the Payment Link. */
export const renewTarget = (row: SubscriptionRow | undefined, email: string): string => {
  if (row?.renovarUrl && /^https:\/\/n8n\.multitecua\.com\/webhook\/renovar\?t=[A-Za-z0-9_-]{16,64}$/.test(row.renovarUrl)) {
    return row.renovarUrl;
  }
  const url = new URL(PAYMENT_LINK);
  url.searchParams.set("locale", "es");
  if (email) url.searchParams.set("prefilled_email", email);
  return url.toString();
};

/** The sentence under the title, from the days left on their cuota. */
export const situation = (row: SubscriptionRow | undefined): { title: string; text: string; tone: "ok" | "soon" | "late" } => {
  const days = row?.diasRestantes;
  const until = row?.cuotaHasta;
  if (days === null || days === undefined || !until) {
    return {
      title: "No tienes una suscripción activa en Stripe",
      text: "No encuentro tu cuota en el libro de socios. Si crees que es un error, escribe a direccion@multitecua.com.",
      tone: "soon",
    };
  }
  if (days > 2) {
    return {
      title: `Tu cuota está al día hasta el ${until}`,
      text:
        `Te quedan ${days} días, pero aún no tienes una suscripción en Stripe que la renueve sola. ` +
        `Actívala hoy y no pagas nada hasta el ${until}: ese día se cobran los 12 € y tu cuota sigue sin cortes.`,
      tone: "ok",
    };
  }
  if (days >= 0) {
    return {
      title: `Tu cuota vence el ${until}`,
      text: "Vence en muy pocos días y todavía no tienes una suscripción en Stripe. Actívala ahora para no perder nada.",
      tone: "soon",
    };
  }
  return {
    title: `Tu cuota venció el ${until}`,
    text: "Todavía no tienes una suscripción en Stripe. Actívala y vuelves a estar al día hoy mismo.",
    tone: "late",
  };
};

/** The whole page. Inline styles, one column, the same look as the renewal mail. */
export const renderPage = (row: SubscriptionRow | undefined, email: string, hasStripeCustomer: boolean): string => {
  const s = situation(row);
  const accent = s.tone === "ok" ? "#0F7B5F" : s.tone === "soon" ? "#B7791F" : "#A30006";
  const greeting = row?.nombre ? `Hola ${esc(row.nombre)}` : "Hola";
  const history = hasStripeCustomer
    ? `<p style="margin:18px 0 0 0;font-size:14px;"><a href="/api/subscription?portal=1" style="color:#A30006;">Ver mis pagos anteriores en Stripe</a></p>`
    : "";
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mi suscripción · MultitecUA</title></head>
<body style="margin:0;background:#F2F2F2;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1E2121;">
<div style="max-width:560px;margin:24px auto;padding:0 12px;">
  <div style="background:#A30006;color:#fff;border-radius:16px 16px 0 0;padding:22px 20px;">
    <div style="font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:#FFD9DA;font-weight:600;">MultitecUA</div>
    <div style="font-size:24px;font-weight:700;margin-top:4px;">Mi suscripción</div>
  </div>
  <div style="background:#fff;border-radius:0 0 16px 16px;padding:22px 20px;font-size:16px;line-height:1.55;">
    <div style="font-size:19px;font-weight:700;">${greeting} 👋</div>
    <div style="border-left:4px solid ${accent};background:#F6F6F6;border-radius:0 10px 10px 0;padding:12px 14px;margin:14px 0;">
      <div style="font-weight:700;color:${accent};">${esc(s.title)}</div>
      <div style="font-size:15px;margin-top:4px;">${esc(s.text)}</div>
    </div>
    <p style="margin:0 0 6px 0;font-size:15px;color:#3A3D3D;">Hasta 2025 la cuota se pagaba a mano una vez al año. Ahora va con Stripe: <b>12 € al año con tarjeta</b>, se renueva sola y la cancelas cuando quieras.</p>
    <a href="${esc(renewTarget(row, email))}" style="display:block;text-align:center;background:#DB0008;color:#fff;text-decoration:none;font-weight:700;font-size:17px;padding:15px 12px;border-radius:14px;margin-top:16px;">Activar mi suscripción</a>
    <div style="font-size:13px;color:#7C8484;text-align:center;margin-top:8px;">Tus datos ya vienen rellenados. Solo revisas y confirmas.</div>
    ${history}
    <p style="margin:18px 0 0 0;font-size:13px;color:#7C8484;">¿Ya la activaste hace un momento? Puede tardar hasta una hora en aparecer aquí. Cualquier duda: <a href="mailto:direccion@multitecua.com" style="color:#A30006;">direccion@multitecua.com</a></p>
  </div>
</div></body></html>`;
};
