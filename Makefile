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
	@pnpm --filter @token-tally/store build
	@pnpm --filter @token-tally/store test
	@pnpm --filter @token-tally/claude-code-writer build
	@pnpm --filter @token-tally/claude-code-writer test
	@if ! xcrun --find xctest >/dev/null 2>&1; then \
	  printf '\nERROR: xctest not found — full Xcode is required to run Swift tests.\n'; \
	  printf '  Install Xcode from the App Store, then switch the active developer tools:\n'; \
	  printf '    sudo xcode-select --switch /Applications/Xcode.app\n'; \
	  printf '  Then retry '"'"'make test'"'"'.\n\n'; \
	  exit 1; \
	fi
	@swift test --package-path clients/macos-tray \
	  --filter "AnalyticsQueriesTests|FormattersTests|AnalyticsTrayTests"
