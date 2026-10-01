import { app, embed, row, button, colors } from "@teapilot/discord-play";

// embedded copy of kiosk_catalog.json (app runs sandboxed, no file access)
const CATALOG = [
  { id: "b1", category: "breakfast", name: "egg roll", price_pence: 325, available: true, description: "egg in a soft roll" },
  { id: "b2", category: "breakfast", name: "toast", price_pence: 180, available: true, description: "two slices with butter" },
  { id: "b3", category: "breakfast", name: "porridge", price_pence: 290, available: false, description: "warm oats with apple" },
  { id: "b4", category: "breakfast", name: "oat pot", price_pence: 240, available: true, description: "oats with milk and honey" },
  { id: "s1", category: "sweets", name: "brownie", price_pence: 260, available: true, description: "chocolate brownie" },
  { id: "s2", category: "sweets", name: "lemon slice", price_pence: 245, available: false, description: "lemon sponge slice" },
  { id: "s3", category: "sweets", name: "flapjack", price_pence: 210, available: true, description: "oat and syrup bar" },
];

const fmtPrice = (pence) => `£${(pence / 100).toFixed(2)}`;

export default app({
  init(ctx) {
    return { category: "breakfast", index: 0 };
  },

  update(state, action, ctx) {
    if (action.kind !== "button") return state;
    const products = CATALOG.filter((p) => p.category === state.category);
    const n = products.length;
    switch (action.id) {
      case "breakfast":
        return { category: "breakfast", index: 0 };
      case "sweets":
        return { category: "sweets", index: 0 };
      case "prev":
        return { ...state, index: (state.index - 1 + n) % n };
      case "next":
        return { ...state, index: (state.index + 1) % n };
      default:
        return state;
    }
  },

  view(state, ctx) {
    const products = CATALOG.filter((p) => p.category === state.category);
    const product = products[state.index];
    const e = embed({
      title: product.name,
      description: product.description,
      color: colors.blue,
      fields: [
        { name: "Price", value: fmtPrice(product.price_pence) },
        { name: "Availability", value: product.available ? "✅ available" : "❌ sold out" },
      ],
      footer: `morning counter — product ${state.index + 1} of ${products.length} in ${state.category}`,
    });
    const r = row(
      button("breakfast", "breakfast", { style: state.category === "breakfast" ? "primary" : "secondary" }),
      button("sweets", "sweets", { style: state.category === "sweets" ? "primary" : "secondary" }),
      button("prev", "prev", { style: "secondary" }),
      button("next", "next", { style: "secondary" }),
    );
    return { embeds: [e], rows: [r] };
  },
});