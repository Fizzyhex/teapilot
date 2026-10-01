#!/usr/bin/env python3
"""Validate a café catalog JSON file.

Usage:
    python3 validate_catalog.py [path-to-catalog.json]

Defaults to catalog.json in the current directory when no path is given.
Exits 0 on success, 1 on any validation failure (with a message on stderr).
"""

import json
import sys

REQUIRED_FIELDS = {
    "id": str,
    "category": str,
    "name": str,
    "price_pence": int,
    "available": bool,
    "description": str,
}
ALLOWED_CATEGORIES = {"breakfast", "sweets"}


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def check_product(product, index, seen_ids):
    """Validate one product dict; return its id."""
    label = f"product[{index}]"
    if not isinstance(product, dict):
        fail(f"{label} is not an object")

    if "id" in product and isinstance(product["id"], str):
        label = f"product[{index}] (id={product['id']!r})"

    # Exact field set: no more, no fewer.
    actual = set(product.keys())
    expected = set(REQUIRED_FIELDS)
    missing = expected - actual
    extra = actual - expected
    if missing:
        fail(f"{label} is missing field(s): {', '.join(sorted(missing))}")
    if extra:
        fail(f"{label} has unexpected field(s): {', '.join(sorted(extra))}")

    # id: string, unique.
    pid = product["id"]
    if not isinstance(pid, str):
        fail(f"{label} field 'id' must be a string, got {type(pid).__name__}")
    if pid in seen_ids:
        fail(f"{label} has duplicate id {pid!r}")
    seen_ids.add(pid)

    # category: string in allowed set.
    category = product["category"]
    if not isinstance(category, str):
        fail(f"{label} field 'category' must be a string, got {type(category).__name__}")
    if category not in ALLOWED_CATEGORIES:
        fail(f"{label} field 'category' must be one of {sorted(ALLOWED_CATEGORIES)}, got {category!r}")

    # name, description: strings.
    for field in ("name", "description"):
        value = product[field]
        if not isinstance(value, str):
            fail(f"{label} field {field!r} must be a string, got {type(value).__name__}")

    # price_pence: int (not bool, not float), > 0.
    price = product["price_pence"]
    if isinstance(price, bool) or not isinstance(price, int):
        fail(f"{label} field 'price_pence' must be an integer, got {type(price).__name__}")
    if price <= 0:
        fail(f"{label} field 'price_pence' must be > 0, got {price}")

    # available: boolean.
    if not isinstance(product["available"], bool):
        fail(f"{label} field 'available' must be a boolean, got {type(product['available']).__name__}")

    return pid


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "catalog.json"

    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        fail(f"cannot read {path!r}: {e.strerror or e}")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"invalid JSON in {path!r}: {e}")

    if not isinstance(data, list):
        fail(f"top level must be a JSON array, got {type(data).__name__}")
    if not data:
        fail("catalog array is empty")

    seen_ids = set()
    for index, product in enumerate(data):
        check_product(product, index, seen_ids)

    print(f"catalog OK: {len(data)} products")


if __name__ == "__main__":
    main()