import { app, embed, row, button, select } from "@teapilot/discord-play";

// morning counter — offline, reads catalog.json (7 products: breakfast + sweets)
// controls: category select (breakfast/sweets), prev/next buttons, product display
// state: { category, index, products }  (products loaded from catalog.json at init)
// unavailable products show a ❌ state; prev/next wrap within the category

const CATALOG = [
  { id: "b1", category: "breakfast", name: "egg roll", price_pence: 325, available: true, description: "egg in a soft roll" },
  { id: "b2", category: "breakfast", name: "toast", price_pence: 180, available: true, description: "two slices with butter" },
  { id: "b3", category: "breakfast", name: "porridge", price_pence: 290, available: false, description: "warm oats with apple" },
  { id: "b4", category: "breakfast", name: "oat pot", price_pence: 240, available: true, description: "warm oat porridge" },
  { id: "s1", category: "sweets", name: "brownie", price_pence: 260, available: true, description: "chocolate brownie" },
  { id: "s2", category: "sweets", name: "lemon slice", price_pence: 245, available: false, description: "lemon sponge slice" },
  { id: "s3", category: "sweets", name: "flapjack", price_pence: 210, available: true, description: "oat and syrup bar" },
];

function gbp(pence) {
  return "£" + (pence / 100).toFixed(2);
}

function itemsFor(category, products) {
  return products.filter((p) => p.category === category);
}

export default app({
  init(ctx) {
    // validate the catalog shape before rendering (mirrors validate_catalog.py)
    const problems = [];
    if (!Array.isArray(CATALOG) || CATALOG.length === 0) problems.push("catalog is empty");
    const seen = new Set();
    for (const p of CATALOG) {
      if (typeof p.id !== "string") problems.push("bad id");
      if (seen.has(p.id)) problems.push("duplicate id " + p.id);
      seen.add(p.id);
      if (!["breakfast", "sweets"].includes(p.category)) problems.push("bad category " + p.category);
      if (typeof p.price_pence !== "number" || p.price_pence <= 0) problems.push("bad price " + p.id);
      if (typeof p.available !== "boolean") problems.push("bad available " + p.id);
    }
    if (problems.length) {
      return { error: problems.join("; "), category: "breakfast", index: 0, products: CATALOG };
    }
    return { error: null, category: "breakfast", index: 0, products: CATALOG };
  },

  update(state, action, ctx) {
    if (state.error) return state;
    if (action.kind === "select" && action.id === "category") {
      const cat = action.values[0];
      return { ...state, category: cat, index: 0 };
    }
    if (action.kind === "button" && (action.id === "prev" || action.id === "next")) {
      const items = itemsFor(state.category, state.products);
      const n = items.length;
      let i = state.index + (action.id === "next" ? 1 : -1);
      i = ((i % n) + n) % n; // wrap
      return { ...state, index: i };
    }
    return state;
  },

  view(state, ctx) {
    if (state.error) {
      return {
        embeds: [embed({
          title: "⚠️ catalog error",
          description: state.error,
          color: 0xed4245,
        })],
      };
    }
    const items = itemsFor(state.category, state.products);
    const p = items[state.index];
    const status = p.available ? "✅ available" : "❌ sold out";
    const desc = p.available
      ? `**${p.name}**\n${p.description}\n\n**${gbp(p.price_pence)}** · ${status}`
      : `**${p.name}**\n${p.description}\n\n**${gbp(p.price_pence)}** · ${status}`;

    return {
      embeds: [embed({
        title: "☕ morning counter",
        description: desc,
        color: 0x5865f2,
        footer: { text: `${state.category} · ${state.index + 1}/${items.length}` },
      })],
      rows: [
        row(select("category", [
          { value: "breakfast", label: "breakfast", emoji: "🍳", default: state.category === "breakfast" },
          { value: "sweets", label: "sweets", emoji: "🍫", default: state.category === "sweets" },
        ], { placeholder: "choose a category" })),
        row(button("prev", "◀ prev", { style: "secondary" }), button("next", "next ▶", { style: "secondary" })),
      ],
    };
  },
});