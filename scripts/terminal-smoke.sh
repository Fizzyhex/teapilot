#!/bin/sh
# Linux PTY check (util-linux script): selection validation, hidden input, cancel.
# Run from an isolated checkout with dependencies and dist already available.
set -eu
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export TEAPILOT_TERMINAL_PROFILE="$scratch/profile"
{
  sleep 2
  printf '9\n'
  sleep 1
  printf '2\n'
  sleep 1
  printf '\n'
  sleep 1
  printf 'http://127.0.0.1:1/v1\n'
  sleep 1
  printf 'test-model\n'
  sleep 1
  printf '\n'
  sleep 1
  printf 'hidden-pty-test-value'
  sleep 1
  printf '\003'
} | script -qefc 'node dist/cli.js setup --config-dir "$TEAPILOT_TERMINAL_PROFILE"' "$scratch/transcript" || true
grep -q 'Enter a number from 1 to 3' "$scratch/transcript"
grep -q 'API key if required (hidden' "$scratch/transcript"
grep -q 'Cancelled' "$scratch/transcript"
if grep -q 'hidden-pty-test-value' "$scratch/transcript"; then
  printf 'Hidden input was exposed\n' >&2
  exit 1
fi
test ! -e "$scratch/profile/.env"
printf 'Linux PTY selection, hidden input, and cancellation passed.\n'
