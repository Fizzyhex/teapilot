#!/usr/bin/env python3
"""Validate a catalog.json file.

Usage: python3 validate_catalog.py [path]   (default: catalog.json)

Rules:
- File must be valid JSON containing a non-empty JSON array.
- Each element must be an object with:
    id (string), category (string: "breakfast" or "sweets"),
    name (string), price_pence (int > 0), available (bool),
    description (string).
- All id values must be unique.

Exits 0 on success, 1 on failure. Stdlib only.
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
VALID_CATEGORIES = ("breakfast", "sweets")


def validate(data):
    """Return a list of error strings (empty list == valid)."""
    errors = []

    if not isinstance(data, list):
        return ["top-level JSON value must be an array, got %s"
                % type(data).__name__]

    if len(data) == 0:
        return ["array must not be empty"]

    seen_ids = {}
    for i, item in enumerate(data):
        label = "item %d" % i
        if not isinstance(item, dict):
            errors.append("%s: must be an object, got %s"
                          % (label, type(item).__name__))
            continue

        # Use the id as a friendlier label if present and valid.
        item_id = item.get("id")
        if isinstance(item_id, str) and item_id:
            label = "item %d (id=%r)" % (i, item_id)

        for field, ftype in REQUIRED_FIELDS.items():
            if field not in item:
                errors.append("%s: missing required field %r" % (label, field))
                continue
            value = item[field]
            # bool is a subclass of int; reject it where int is required.
            if ftype is int and isinstance(value, bool):
                errors.append("%s: field %r must be an integer, got boolean"
                              % (label, field))
                continue
            if not isinstance(value, ftype):
                errors.append("%s: field %r must be %s, got %s"
                              % (label, field, ftype.__name__,
                                 type(value).__name__))
                continue
            if field == "category" and value not in VALID_CATEGORIES:
                errors.append("%s: field 'category' must be one of %s, got %r"
                              % (label, "/".join(VALID_CATEGORIES), value))
            if field == "price_pence" and value <= 0:
                errors.append("%s: field 'price_pence' must be > 0, got %d"
                              % (label, value))

        # Uniqueness of id.
        if isinstance(item_id, str):
            if item_id in seen_ids:
                errors.append("duplicate id %r (first at item %d, again at item %d)"
                              % (item_id, seen_ids[item_id], i))
            else:
                seen_ids[item_id] = i

    return errors


def main(argv):
    path = argv[1] if len(argv) > 1 else "catalog.json"

    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        print("%s: ERROR: cannot read file: %s" % (path, e), file=sys.stderr)
        return 1

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print("%s: ERROR: invalid JSON: %s" % (path, e), file=sys.stderr)
        return 1

    errors = validate(data)
    if errors:
        print("%s: FAILED with %d problem(s):" % (path, len(errors)))
        for err in errors:
            print("  - %s" % err)
        return 1

    print("%s: OK (%d products)" % (path, len(data)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))