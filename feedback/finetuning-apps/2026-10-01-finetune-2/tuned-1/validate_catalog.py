"""Reusable catalog validator.

Loads catalog.json (a JSON array of product objects) and validates it so a
bad catalog update fails loudly instead of rendering garbage.
"""
import json
import os
import sys

REQUIRED_FIELDS = ("id", "category", "name", "price_pence", "available", "description")
CATEGORIES = {"breakfast", "sweets"}


def _label(product, index):
    """Human-friendly name for a product in error messages."""
    if isinstance(product, dict) and isinstance(product.get("id"), str) and product["id"]:
        return f"product {product['id']!r}"
    return f"item at index {index}"


def validate(path="catalog.json"):
    """Validate the catalog at path. Returns the list of products on success,
    raises ValueError with a clear message on failure."""
    if not os.path.exists(path):
        raise ValueError(f"catalog file not found: {path}")

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"catalog file is not valid JSON: {e}")

    if not isinstance(data, list):
        raise ValueError(f"top level must be a list, got {type(data).__name__}")

    seen_ids = set()
    for index, product in enumerate(data):
        label = _label(product, index)

        if not isinstance(product, dict):
            raise ValueError(f"{label}: must be an object, got {type(product).__name__}")

        for field in REQUIRED_FIELDS:
            if field not in product:
                raise ValueError(f"{label}: missing required field {field!r}")

        pid = product["id"]
        if not isinstance(pid, str):
            raise ValueError(f"{label}: 'id' must be a string, got {type(pid).__name__}")
        if pid in seen_ids:
            raise ValueError(f"{label}: duplicate id {pid!r}")
        seen_ids.add(pid)

        category = product["category"]
        if not isinstance(category, str):
            raise ValueError(f"{label}: 'category' must be a string, got {type(category).__name__}")
        if category not in CATEGORIES:
            raise ValueError(f"{label}: 'category' must be one of {sorted(CATEGORIES)}, got {category!r}")

        name = product["name"]
        if not isinstance(name, str) or not name:
            raise ValueError(f"{label}: 'name' must be a non-empty string")

        price = product["price_pence"]
        if isinstance(price, bool) or not isinstance(price, int):
            raise ValueError(f"{label}: 'price_pence' must be an integer, got {type(price).__name__}")
        if price <= 0:
            raise ValueError(f"{label}: 'price_pence' must be positive, got {price}")

        available = product["available"]
        if not isinstance(available, bool):
            raise ValueError(f"{label}: 'available' must be a boolean, got {type(available).__name__}")

        description = product["description"]
        if not isinstance(description, str) or not description:
            raise ValueError(f"{label}: 'description' must be a non-empty string")

    return data


if __name__ == "__main__":
    catalog_path = sys.argv[1] if len(sys.argv) > 1 else "catalog.json"
    try:
        products = validate(catalog_path)
    except ValueError as e:
        print(f"ERROR: {e}")
        sys.exit(1)
    print(f"OK: {len(products)} products")