#!/usr/bin/env python3
"""Validate a kiosk catalog JSON file: a list of products with exactly 6 fields."""
import json
import os
import sys

FIELDS = {"id": str, "category": str, "name": str, "price_pence": int, "available": bool, "description": str}
CATEGORIES = {"breakfast", "sweets"}


def validate(data):
    problems = []
    if not isinstance(data, list):
        return ["top-level: expected a JSON list, got %s" % type(data).__name__]
    seen_ids = set()
    for i, p in enumerate(data):
        where = "product[%d]" % i
        if not isinstance(p, dict):
            problems.append("%s: expected an object, got %s" % (where, type(p).__name__))
            continue
        if isinstance(p.get("id"), str) and p["id"]:
            where = "product[%d] (id=%s)" % (i, p["id"])
        for f, t in FIELDS.items():
            if f not in p:
                problems.append("%s: missing field '%s'" % (where, f))
                continue
            v = p[f]
            if t is int and isinstance(v, bool):
                problems.append("%s: field '%s' must be an integer, got boolean" % (where, f))
            elif not isinstance(v, t):
                problems.append("%s: field '%s' must be %s, got %s" % (where, f, t.__name__, type(v).__name__))
        for f in p:
            if f not in FIELDS:
                problems.append("%s: unexpected field '%s'" % (where, f))
        if isinstance(p.get("id"), str):
            if not p["id"]:
                problems.append("%s: field 'id' must be non-empty" % where)
            elif p["id"] in seen_ids:
                problems.append("%s: field 'id' is not unique" % where)
            else:
                seen_ids.add(p["id"])
        if isinstance(p.get("category"), str) and p["category"] not in CATEGORIES:
            problems.append("%s: field 'category' must be one of %s, got '%s'" % (where, sorted(CATEGORIES), p["category"]))
        for f in ("name", "description"):
            if isinstance(p.get(f), str) and not p[f]:
                problems.append("%s: field '%s' must be non-empty" % (where, f))
        if isinstance(p.get("price_pence"), int) and not isinstance(p.get("price_pence"), bool) and p["price_pence"] <= 0:
            problems.append("%s: field 'price_pence' must be > 0, got %d" % (where, p["price_pence"]))
    return problems


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "kiosk_catalog.json")
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        print("error: cannot read %s: %s" % (path, e))
        return 1
    problems = validate(data)
    if problems:
        for p in problems:
            print(p)
        return 1
    counts = {"breakfast": 0, "sweets": 0}
    for p in data:
        counts[p["category"]] += 1
    print("OK: %d products (%d breakfast, %d sweets)" % (len(data), counts["breakfast"], counts["sweets"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())