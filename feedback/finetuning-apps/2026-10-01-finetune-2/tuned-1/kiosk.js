import { app, embed, row, button } from "@teapilot/discord-play";

// café kiosk: offline catalog browser
// - state: { category, index }
// - category switch resets index to 0
// - prev/next wrap around within the category
// - unavailable products still shown, marked "Sold out"

const CATALOG = [
  { id: "b1", category: "breakfast", name: "egg roll", price_pence: 325, available: true, description: "egg in a soft roll" },
  { id: "b2", category: "breakfast", name: "toast", price_pence: 180, available: true, description: "two slices with butter" },
  { id: "b3", category: "breakfast", name: "porridge", price_pence: 290, available: false, description: "warm oats with apple" },
  { id: "b4", category: "breakfast", name: "oat pot", price_pence: 240, available: true, description: "creamy oats in a pot" },
  { id: "s1", category: "sweets", name: "brownie", price_pence: 260, available: true, description: "chocolate brownie" },
  { id: "s2", category: "sweets", name: "lemon slice", price_pence: 245, available: false, description: "lemon sponge slice" },
  { id: "s3", category: "sweets", name: "flapjack", price_pence: 210, available: true, description: "oat and syrup bar" },
];

const COLOR = 0x8B4513; // saddlebrown

function productsFor(category) {
  return CATALOG.filter((p) => p.category === category);
}

function formatPrice(pence) {
  return `£${(pence / 100).toFixed(2)}`;
}

export default app({
  init() {
    return { category: "breakfast", index: 0 };
  },

  update(state, action) {
    if (action.kind !== "button") return state;
    const count = productsFor(state.category).length;
    switch (action.id) {
      case "breakfast":
        return { category: "breakfast", index: 0 };
      case "sweets":
        return { category: "sweets", index: 0 };
      case "prev":
        return { ...state, index: (state.index - 1 + count) % count };
      case "next":
        return { ...state, index: (state.index + 1) % count };
      default:
        return state;
    }
  },

  view(state) {
    const list = productsFor(state.category);
    const count = list.length;
    const product = list[state.index % count];

    const e = embed({
      title: product.name,
      description: product.description,
      color: COLOR,
      fields: [
        { name: "Price", value: formatPrice(product.price_pence) },
        { name: "Availability", value: product.available ? "Available" : "Sold out" },
      ],
      footer: `morning counter · ${state.category} · ${state.index + 1}/${count}`,
    });

    const r = row(
      button("breakfast", "🍳 Breakfast", { style: state.category === "breakfast" ? "primary" : "secondary" }),
      button("sweets", "🍰 Sweets", { style: state.category === "sweets" ? "primary" : "secondary" }),
      button("prev", "◀ Prev", { style: "secondary" }),
      button("next", "Next ▶", { style: "secondary" })
    );

    return { embeds: [e], rows: [r] };
  },
});