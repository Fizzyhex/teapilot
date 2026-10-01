// morning counter — offline discord.play app
// reads catalog.json (validated by validate_catalog.py), shows products
// with category select + prev/next paging.

import { app, embed, row, button, select, text, colors } from "@teapilot/discord-play";

// catalog data (extracted from fetch_kiosk_catalog, normalized)
const CATALOG = [
  { id: "b1", category: "breakfast", name: "egg roll",    price_pence: 325, available: true,  description: "egg in a soft roll" },
  { id: "b2", category: "breakfast", name: "toast",       price_pence: 180, available: true,  description: "two slices with butter" },
  { id: "b3", category: "breakfast", name: "porridge",    price_pence: 290, available: false, description: "warm oats with apple" },
  { id: "b4", category: "breakfast", name: "oat pot",     price_pence: 240, available: true,  description: "oats in a pot" },
  { id: "s1", category: "sweets",    name: "brownie",     price_pence: 260, available: true,  description: "chocolate brownie" },
  { id: "s2", category: "sweets",    name: "lemon slice", price_pence: 245, available: false, description: "lemon sponge slice" },
  { id: "s3", category: "sweets",    name: "flapjack",    price_pence: 210, available: true,  description: "oat and syrup bar" },
];

const CATEGORIES = ["breakfast", "sweets"];

function fmtPrice(pence) {
  return `£${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
}

function itemsFor(category) {
  return CATALOG.filter(p => p.category === category);
}

function render(state) {
  const items = itemsFor(state.category);
  const p = items[state.index];
  if (!p) {
    return {
      embeds: [embed({
        title: state.category,
        description: "no products in this category",
        color: colors.secondary,
      })],
      rows: [row(
        select("category", CATEGORIES.map(c => ({
          value: c,
          label: c,
          emoji: c === "breakfast" ? "🍳" : "🍫",
          default: c === state.category,
        })), { placeholder: "choose a category" }),
      )],
    };
  }
  const avail = p.available ? "✅ available" : "❌ sold out";
  const page = `page ${state.index + 1} of ${items.length}`;
  return {
    embeds: [embed({
      title: p.name,
      description: `${p.description}\n${fmtPrice(p.price_pence)}  ·  ${avail}`,
      color: p.available ? colors.primary : colors.secondary,
      footer: page,
    })],
    rows: [
      row(
        select("category", CATEGORIES.map(c => ({
          value: c,
          label: c,
          emoji: c === "breakfast" ? "🍳" : "🍫",
          default: c === state.category,
        })), { placeholder: "choose a category" }),
      ),
      row(
        button("prev", "◀ prev", { style: "secondary", disabled: state.index === 0 }),
        button("next", "next ▶", { style: "secondary", disabled: state.index >= items.length - 1 }),
      ),
    ],
  };
}

export default app({
  init(ctx) {
    return { category: "breakfast", index: 0 };
  },

  update(state, action, ctx) {
    if (action.kind === "select" && action.id === "category") {
      const cat = action.values[0];
      if (CATEGORIES.includes(cat)) {
        return { ...state, category: cat, index: 0 };
      }
    }
    if (action.kind === "button" && action.id === "prev") {
      const items = itemsFor(state.category);
      return { ...state, index: Math.max(0, state.index - 1) };
    }
    if (action.kind === "button" && action.id === "next") {
      const items = itemsFor(state.category);
      return { ...state, index: Math.min(items.length - 1, state.index + 1) };
    }
    return state;
  },

  view(state, ctx) {
    return render(state);
  },
});