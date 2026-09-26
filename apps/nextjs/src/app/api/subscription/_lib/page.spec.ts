import { describe, expect, test } from "vitest";

import { hasLiveMembership, renderPage, renewTarget, situation } from "./page";

const MEMBERSHIP = { price: { product: "prod_TL62rjjzyfFv4c" } };
const SEAT = { price: { product: "prod_VA6XwzBIPeZs36" } };

describe("hasLiveMembership", () => {
  test("an active membership subscription counts", () => {
    expect(hasLiveMembership([{ status: "active", items: { data: [MEMBERSHIP] } }])).toBe(true);
  });
  test("a trial counts: the member renewed early and keeps their days", () => {
    expect(hasLiveMembership([{ status: "trialing", items: { data: [MEMBERSHIP] } }])).toBe(true);
  });
  test("a Claude seat is not a membership", () => {
    expect(hasLiveMembership([{ status: "active", items: { data: [SEAT] } }])).toBe(false);
  });
  test("a cancelled membership is not live", () => {
    expect(hasLiveMembership([{ status: "canceled", items: { data: [MEMBERSHIP] } }])).toBe(false);
  });
  test("an expanded product object is read too", () => {
    expect(hasLiveMembership([{ status: "active", items: { data: [{ price: { product: { id: "prod_TL62rjjzyfFv4c" } } }] } }])).toBe(true);
  });
});

describe("situation", () => {
  test("days left: they keep them, nothing is charged until the date", () => {
    const s = situation({ cuotaHasta: "13/10/2026", diasRestantes: 17 });
    expect(s.tone).toBe("ok");
    expect(s.text).toContain("no pagas nada hasta el 13/10/2026");
  });
  test("expired", () => {
    expect(situation({ cuotaHasta: "09/07/2026", diasRestantes: -79 }).title).toBe("Tu cuota venció el 09/07/2026");
  });
  test("no row: says so, never a blank page", () => {
    expect(situation(undefined).text).toContain("direccion@multitecua.com");
  });
});

describe("renewTarget", () => {
  test("their personal link when the feed has one", () => {
    const url = "https://n8n.multitecua.com/webhook/renovar?t=AbCdEfGhIjKlMnOpQrSt12";
    expect(renewTarget({ renovarUrl: url }, "a@multitecua.com")).toBe(url);
  });
  test("anything else in that field is not followed", () => {
    expect(renewTarget({ renovarUrl: "https://evil.example/x" }, "a@multitecua.com")).toContain("buy.stripe.com");
  });
  test("no link: the Payment Link with their address prefilled", () => {
    expect(renewTarget(undefined, "a@multitecua.com")).toContain("prefilled_email=a%40multitecua.com");
  });
});

describe("renderPage", () => {
  test("escapes what it prints", () => {
    expect(renderPage({ nombre: "<script>", cuotaHasta: "01/01/2027", diasRestantes: 90 }, "x@multitecua.com", false)).not.toContain("<script>");
  });
  test("offers past payments only to somebody with a Stripe customer", () => {
    expect(renderPage(undefined, "x@multitecua.com", true)).toContain("/api/subscription?portal=1");
    expect(renderPage(undefined, "x@multitecua.com", false)).not.toContain("portal=1");
  });
});
