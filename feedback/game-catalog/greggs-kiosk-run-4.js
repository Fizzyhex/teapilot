import { app, embed, row, button, select, text, step, ephemeral } from "@teapilot/discord-play";

const PRODUCTS = [
  {
    id: "bacon_sausage_roll",
    name: "Bacon & Sausage Roll",
    description: "The iconic Greggs roll, packed with crispy bacon and a juicy pork sausage. A flaky pastry favourite that's been a breakfast staple for decades.",
    category: "breakfast",
    nutrition: { energy_kcal: 420, fat_g: 24, sat_g: 10, sugar_g: 5, salt_g: 1.8 }
  },
  {
    id: "chicken_leek_roll",
    name: "Chicken & Leek Roll",
    description: "Tender chicken and sweet leek wrapped in a golden flaky pastry. A lighter, savoury option with a gentle, comforting flavour.",
    category: "breakfast",
    nutrition: { energy_kcal: 320, fat_g: 16, sat_g: 6, sugar_g: 6, salt_g: 1.2 }
  },
  {
    id: "beef_cheddar_roll",
    name: "Beef & Cheddar Roll",
    description: "Seasoned beef and sharp cheddar cheese in a buttery pastry shell. A hearty, savoury roll with a rich, cheesy bite.",
    category: "breakfast",
    nutrition: { energy_kcal: 380, fat_g: 21, sat_g: 9, sugar_g: 5, salt_g: 1.5 }
  },
  {
    id: "bacon_roll",
    name: "Bacon Roll",
    description: "Crispy streaky bacon folded into a flaky, golden pastry. Simple, smoky and satisfyingly savoury.",
    category: "breakfast",
    nutrition: { energy_kcal: 350, fat_g: 19, sat_g: 8, sugar_g: 5, salt_g: 1.6 }
  },
  {
    id: "sausage_roll",
    name: "Sausage Roll",
    description: "A classic pork sausage encased in a crisp, flaky pastry. The timeless pub and breakfast favourite, done the Greggs way.",
    category: "breakfast",
    nutrition: { energy_kcal: 390, fat_g: 22, sat_g: 9, sugar_g: 5, salt_g: 1.4 }
  },
  {
    id: "cinnamon_roll",
    name: "Cinnamon Roll",
    description: "Soft, swirled pastry filled with cinnamon sugar and a hint of icing. A warm, spiced sweet treat that's perfect with a coffee.",
    category: "sweet_treats",
    nutrition: { energy_kcal: 340, fat_g: 14, sat_g: 7, sugar_g: 22, salt_g: 0.6 }
  },
  {
    id: "chocolate_roll",
    name: "Chocolate Roll",
    description: "Flaky pastry rolled around a rich chocolate filling. A decadent, indulgent treat for chocolate lovers.",
    category: "sweet_treats",
    nutrition: { energy_kcal: 360, fat_g: 15, sat_g: 8, sugar_g: 24, salt_g: 0.5 }
  },
  {
    id: "strawberry_roll",
    name: "Strawberry Roll",
    description: "Buttery pastry filled with sweet strawberry cream. A fruity, light and refreshing sweet treat.",
    category: "sweet_treats",
    nutrition: { energy_kcal: 310, fat_g: 12, sat_g: 6, sugar_g: 20, salt_g: 0.5 }
  },
  {
    id: "vanilla_roll",
    name: "Vanilla Roll",
    description: "Golden flaky pastry with a smooth vanilla cream filling. A classic, comforting sweet treat with a soft, creamy centre.",
    category: "sweet_treats",
    nutrition: { energy_kcal: 320, fat_g: 13, sat_g: 6, sugar_g: 21, salt_g: 0.6 }
  },
  {
    id: "blueberry_roll",
    name: "Blueberry Roll",
    description: "Flaky pastry filled with tangy blueberry cream. A fruity, slightly zesty sweet treat with a burst of berry flavour.",
    category: "sweet_treats",
    nutrition: { energy_kcal: 300, fat_g: 12, sat_g: 6, sugar_g: 19, salt_g: 0.5 }
  }
];

function itemsInCategory(category) {
  return PRODUCTS.filter((p) => p.category === category);
}

function defaultUserState() {
  return { page: "browse", category: "breakfast", index: 0 };
}

// 5-step green->red scale helpers
function fatStyle(v) {
  if (v < 10) return "success";
  if (v < 15) return "success";
  if (v < 20) return "secondary";
  if (v < 25) return "secondary";
  return "danger";
}
function satStyle(v) {
  if (v < 4) return "success";
  if (v < 6) return "success";
  if (v < 8) return "secondary";
  if (v < 10) return "secondary";
  return "danger";
}
function sugarStyle(v) {
  if (v < 5) return "success";
  if (v < 10) return "success";
  if (v < 15) return "secondary";
  if (v < 20) return "secondary";
  return "danger";
}
function saltStyle(v) {
  if (v < 0.5) return "success";
  if (v < 1) return "success";
  if (v < 1.5) return "secondary";
  if (v < 2) return "secondary";
  return "danger";
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : String(v);
}

function browseView(user) {
  const items = itemsInCategory(user.category);
  const count = items.length;
  const item = items[user.index % count];

  const e = embed({
    title: "Find your yummy",
    description: "Browse our menu of breakfast rolls and sweet treats",
    color: 0x3498db,
    footer: "Showing: " + item.name
  });

  const cat = select("category", [
    { value: "breakfast", label: "Breakfast" },
    { value: "sweet_treats", label: "Sweet Treats" }
  ], "Choose a category");

  const nav = row(
    button("prev", "◀ Prev", { style: "secondary" }),
    button("next", "Next ▶", { style: "secondary" }),
    button("view_details", "View Details", { style: "primary" })
  );

  return { embeds: [e], rows: [cat, nav] };
}

function detailView(user) {
  const items = itemsInCategory(user.category);
  const item = items[user.index % items.length];
  const n = item.nutrition;

  const e = embed({
    title: item.name,
    description: item.description,
    color: 0xe67e22
  });

  const nutrition = row(
    button("energy", "Energy: " + fmt(n.energy_kcal) + " kcal", { style: "secondary" }),
    button("fat", "Fat: " + fmt(n.fat_g) + "g", { style: fatStyle(n.fat_g) }),
    button("sat", "Sat: " + fmt(n.sat_g) + "g", { style: satStyle(n.sat_g) }),
    button("sugar", "Sugar: " + fmt(n.sugar_g) + "g", { style: sugarStyle(n.sugar_g) }),
    button("salt", "Salt: " + fmt(n.salt_g) + "g", { style: saltStyle(n.salt_g) })
  );

  const back = row(button("back", "◀ Back", { style: "secondary" }));

  // "You may also like": up to 3 other items in same category, fill from other
  const same = items.filter((p) => p.id !== item.id);
  const otherCat = user.category === "breakfast" ? "sweet_treats" : "breakfast";
  const others = itemsInCategory(otherCat);
  const recs = [];
  for (const p of same) {
    if (recs.length >= 3) break;
    recs.push(p);
  }
  for (const p of others) {
    if (recs.length >= 3) break;
    recs.push(p);
  }

  const recRow = row(...recs.map((p) => button(p.id, p.name, { style: "secondary" })));

  const rows = [nutrition, back];
  if (recRow) rows.push(recRow);

  return { embeds: [e], rows };
}

export default app({
  init(ctx) {
    return {
      page: "browse",
      lastUser: null,
      users: {}
    };
  },

  update(state, action, ctx) {
    const userId = action.user.id;
    const users = { ...state.users };
    const user = users[userId] || defaultUserState();

    if (action.kind === "select" && action.id === "category") {
      const category = action.values[0];
      users[userId] = { ...user, category, index: 0, page: "browse" };
    } else if (action.kind === "button") {
      const items = itemsInCategory(user.category);
      const count = items.length;

      if (action.id === "prev") {
        users[userId] = { ...user, index: (user.index - 1 + count) % count };
      } else if (action.id === "next") {
        users[userId] = { ...user, index: (user.index + 1) % count };
      } else if (action.id === "view_details") {
        users[userId] = { ...user, page: "detail" };
      } else if (action.id === "back") {
        users[userId] = { ...user, page: "browse" };
      } else if (action.id === "energy" || action.id === "fat" || action.id === "sat" || action.id === "sugar" || action.id === "salt") {
        // nutrition buttons: no state change
      } else {
        // recommendation button: id = product id
        const product = PRODUCTS.find((p) => p.id === action.id);
        if (product) {
          const catItems = itemsInCategory(product.category);
          const idx = catItems.findIndex((p) => p.id === product.id);
          users[userId] = { ...user, category: product.category, index: idx, page: "detail" };
        }
      }
    }

    return {
      ...state,
      lastUser: userId,
      users
    };
  },

  view(state, ctx) {
    const userId = state.lastUser || Object.keys(state.users)[0];
    const user = (userId && state.users[userId]) || defaultUserState();

    if (user.page === "detail") {
      return detailView(user);
    }
    return browseView(user);
  }
});