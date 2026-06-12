SHELL := /bin/bash

# ToTally — top-level orchestrator Makefile.
#
# All real work lives in scripts/; this Makefile is intentionally thin so
# that `make install` remains a single memorable entry-point while keeping
# per-component logic auditable in its own script.
#
# Usage:
#   make install      — idempotent install / update after `git pull`
#   make install cli  — install / update only the token-tally CLI and database
#   make install-cli  — same as `make install cli`
#   make uninstall    — remove installed components (user data kept by default)
#   make doctor       — diagnostic check of all components
#   make test         — run all tests

TOKEN_TALLY_DATA_DIR := $(if $(XDG_DATA_HOME),$(XDG_DATA_HOME),$(HOME)/.local/share)/token-tally

.PHONY: install cli install-cli uninstall doctor test

install:
ifeq ($(filter cli,$(MAKECMDGOALS)),cli)
	@scripts/install-store.sh "$(CURDIR)" "$(TOKEN_TALLY_DATA_DIR)"
else
	@scripts/install.sh
endif

cli:
ifeq ($(filter install,$(MAKECMDGOALS)),install)
	@:
else
	@scripts/install-store.sh "$(CURDIR)" "$(TOKEN_TALLY_DATA_DIR)"
endif

install-cli: cli

uninstall:
	@scripts/uninstall.sh

doctor:
	@scripts/doctor.sh

test:
	@pnpm --filter @token-tally/store build
	@pnpm --filter @token-tally/store test
	@pnpm --filter @token-tally/claude-code-writer build
	@pnpm --filter @token-tally/claude-code-writer test
	@pnpm --filter @token-tally/cursor-writer build
	@pnpm --filter @token-tally/cursor-writer test
	@pnpm --filter @token-tally/web-explorer build:server
	@pnpm --filter @token-tally/web-explorer test
	@if ! xcrun --find xctest >/dev/null 2>&1; then \
	  printf '\nERROR: xctest not found — full Xcode is required to run Swift tests.\n'; \
	  printf '  Install Xcode from the App Store, then switch the active developer tools:\n'; \
	  printf '    sudo xcode-select --switch /Applications/Xcode.app\n'; \
	  printf '  Then retry '"'"'make test'"'"'.\n\n'; \
	  exit 1; \
	fi
	@swift test --package-path clients/macos-tray \
	  --filter "AnalyticsQueriesTests|FormattersTests|AnalyticsTrayTests"
