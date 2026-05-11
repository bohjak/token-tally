SHELL := /bin/bash

# ToTally — top-level orchestrator Makefile.
#
# All real work lives in scripts/; this Makefile is intentionally thin so
# that `make install` remains a single memorable entry-point while keeping
# per-component logic auditable in its own script.
#
# Usage:
#   make install    — idempotent install / update after `git pull`
#   make uninstall  — remove installed components (user data kept by default)
#   make doctor     — diagnostic check of all components
#   make test       — run all tests

.PHONY: install uninstall doctor test

install:
	@scripts/install.sh

uninstall:
	@scripts/uninstall.sh

doctor:
	@scripts/doctor.sh

test:
	@swift test --package-path clients/macos-tray
	# pnpm -r test is enabled in T13 once store tests exist
