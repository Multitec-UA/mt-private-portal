#!/usr/bin/env node
/**
 * Render a `customApi` customJsx template against real data, and fail if it would break.
 *
 * WHY THIS EXISTS
 * ---------------
 * A template lives in Homarr's database, is edited through a web form, and renders in the
 * MEMBER'S BROWSER. The portal is behind IAP, so the page cannot be read back by an agent:
 * a template with a typo in it does not fail a build, does not appear in a log, and does not
 * show up in `getData` — it shows a red box on Sergio's dashboard and nowhere else.
 *
 * So the templates get checked here instead. Three things are worth knowing, and each of
 * them is a real failure mode rather than a hypothetical:
 *
 *   1. does the JSX PARSE — an unclosed tag, a stray brace;
 *   2. does every expression RESOLVE — `{data.raid.color}` when the feed calls it `colour`
 *      renders as nothing at all, silently, and the tile just looks empty;
 *   3. does it only use components the WHITELIST admits — anything else is dropped by
 *      `allowUnknownElements={false}` with no message.
 *
 * WHY THE COMPONENTS ARE STUBS
 * ----------------------------
 * Mantine's real components need a `MantineProvider`, a colour scheme and a browser. None of
 * that is what breaks; the three things above are. Every whitelisted name is replaced by a
 * `<span>` that renders its children, so the check is about the template and not about
 * Mantine's runtime — and it stays fast enough to run on every change.
 *
 * The stub list is PARSED OUT OF `jsx-whitelist.ts` rather than written here, so a component
 * upstream adds or removes is reflected automatically and a template using something that is
 * not on the list fails here rather than rendering blank in production.
 *
 * Usage:
 *   node check-jsx-template.mjs <template-file> <data-json-file>
 *
 * Exit 0 = it renders. Exit 1 = it would not.
 */

import { readFileSync } from "node:fs";
import { Children, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JsxParser from "react-jsx-parser";

const [templatePath, dataPath] = process.argv.slice(2);
if (!templatePath || !dataPath) {
  console.error("usage: check-jsx-template.mjs <template-file> <data-json-file>");
  process.exit(2);
}

const template = readFileSync(templatePath, "utf8");
const apiData = JSON.parse(readFileSync(dataPath, "utf8"));

// ---------------------------------------------------------------------------------------
// The whitelist, read from the fork's own source so the two cannot drift.
// ---------------------------------------------------------------------------------------

const whitelistSource = readFileSync(
  new URL("../../../packages/widgets/src/custom-api/jsx-whitelist.ts", import.meta.url),
  "utf8",
);

const block = whitelistSource.match(
  /export const WHITELISTED_COMPONENTS[^=]*=\s*\{([\s\S]*?)\n\};/,
);
if (!block) {
  console.error("check-jsx-template: could not find WHITELISTED_COMPONENTS in jsx-whitelist.ts");
  process.exit(2);
}

// Entries are either `Stack,` or `"Grid.Col": Grid.Col,` or `Anchor: SafeAnchor,`.
const names = new Set();
for (const line of block[1].split("\n")) {
  const quoted = line.match(/^\s*"([^"]+)"\s*:/);
  const bare = line.match(/^\s*([A-Z][A-Za-z0-9_]*)\s*[,:]/);
  if (quoted) names.add(quoted[1]);
  else if (bare) names.add(bare[1]);
}
if (names.size === 0) {
  console.error("check-jsx-template: parsed the whitelist and found no components");
  process.exit(2);
}

const stub = (name) =>
  function Stub(props) {
    // `data-c` carries the component name into the markup, so the assertions below can see
    // which components a template actually used.
    // `Children.toArray` rather than `props.children`: JsxParser is configured with
    // `disableKeyGeneration`, so React warns "each child in a list should have a unique
    // key" for every element and buries the actual result in three screens of noise.
    // toArray assigns keys, which is the correct fix rather than muting console.error —
    // muting it would also hide the errors this script exists to surface.
    return createElement("span", { "data-c": name }, Children.toArray(props.children ?? null));
  };

const components = Object.fromEntries([...names].map((name) => [name, stub(name)]));

// Dotted names have to hang off their parent as a PROPERTY, not only sit in the map under a
// dotted key.
//
// `WHITELISTED_COMPONENTS` lists `"Table.Tbody": Table.Tbody`, and with real Mantine that
// works for a second reason nobody notices: `Table` itself carries `.Tbody`, so
// `<Table.Tbody>` resolves through the parent. Stubs have no such property, so the first
// template using `<Table.Tbody>` was reported as "unrecognized, and will not be rendered" —
// a false alarm from this checker rather than a fault in the template.
//
// Attaching them makes the stub map behave the way the real one does. Getting this wrong in
// the other direction would be worse: a checker that passes what production drops.
for (const name of names) {
  if (!name.includes(".")) continue;
  const [parent, child] = name.split(".");
  if (components[parent]) components[parent][child] = components[name];
}

// ---------------------------------------------------------------------------------------
// The bindings, mirroring SAFE_BINDINGS
// ---------------------------------------------------------------------------------------

const bindings = {
  data: apiData,
  String: (v) => String(v),
  Number: (v) => Number(v),
  Boolean: (v) => Boolean(v),
  Math,
  JSON,
  Array,
  Object,
};

// ---------------------------------------------------------------------------------------

const errors = [];
let markup = "";
try {
  markup = renderToStaticMarkup(
    createElement(JsxParser, {
      jsx: template,
      components,
      bindings,
      disableKeyGeneration: true,
      componentsOnly: true,
      allowUnknownElements: false,
      renderInWrapper: false,
      onError: (error) => errors.push(String(error?.message ?? error)),
    }),
  );
} catch (error) {
  errors.push(`threw while rendering: ${String(error?.message ?? error)}`);
}

// An expression that resolves to nothing renders as nothing, so "it rendered" is not the
// same as "it rendered something". These are the shapes that mean a field name is wrong.
const literalUndefined = /undefined|\[object Object\]|NaN/.exec(markup);
const usedComponents = [...markup.matchAll(/data-c="([^"]+)"/g)].map((m) => m[1]);

// Every `{...}` in the template should have produced output. Counting them is crude, but it
// catches the case this is really for: a renamed field, where the tile silently loses a line.
const expressions = (template.match(/\{[^{}]+\}/g) ?? []).filter(
  (expression) => !/^\{\s*\/\*/.test(expression),
);

if (errors.length) {
  console.error("FAIL  the template does not render:");
  for (const error of errors) console.error(`        ${error}`);
  process.exit(1);
}
if (literalUndefined) {
  console.error(`FAIL  the rendered output contains "${literalUndefined[0]}" — a field name is probably wrong`);
  console.error(`        ${markup.slice(Math.max(0, literalUndefined.index - 80), literalUndefined.index + 80)}`);
  process.exit(1);
}
if (usedComponents.length === 0) {
  console.error("FAIL  nothing rendered — every component was dropped as unknown");
  process.exit(1);
}

const text = markup.replace(/<[^>]+>/g, "").trim();
console.log(`OK    ${usedComponents.length} component(s), ${expressions.length} expression(s)`);
console.log(`      components: ${[...new Set(usedComponents)].join(", ")}`);
console.log(`      text: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
