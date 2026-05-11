SHELL := /bin/bash

# This Makefile lives at clients/macos-tray/Makefile.
# All paths are relative to this directory; invoke via:
#   make -C clients/macos-tray <target>
# or from the repo root with --package-path:
#   swift build --package-path clients/macos-tray
#
# The SwiftPM target and compiled binary keep the name "AnalyticsTray" for
# historical reasons.  The installed .app bundle is "ToTally.app"; the
# binary is renamed to "ToTally" when copied into the bundle (macOS uses
# the bundle directory name to locate the executable when CFBundleExecutable
# is absent from Info.plist).
#
# For production installs prefer the top-level `make install` which delegates
# to scripts/install-tray.sh and handles atomic replacement + app restart.

# SwiftPM target / compiled binary name (do not rename without updating Package.swift).
SWIFT_EXECUTABLE    := AnalyticsTray

# User-visible app bundle / install names.
APP_NAME            := ToTally
APP_DISPLAY_NAME    := ToTally
BUNDLE_NAME         := $(APP_NAME).app

BUILD_CONFIGURATION := release
BUILD_DIR           := .build/$(BUILD_CONFIGURATION)
DIST_DIR            := dist
BUNDLE_DIR          := $(DIST_DIR)/$(BUNDLE_NAME)
CONTENTS_DIR        := $(BUNDLE_DIR)/Contents
MACOS_DIR           := $(CONTENTS_DIR)/MacOS
RESOURCES_DIR       := $(CONTENTS_DIR)/Resources
INSTALL_DIR         := /Applications

.PHONY: build install test run clean

build:
	@set -euo pipefail; \
	swift build --configuration "$(BUILD_CONFIGURATION)"; \
	rm -rf "$(BUNDLE_DIR)"; \
	mkdir -p "$(MACOS_DIR)" "$(RESOURCES_DIR)"; \
	cp "$(BUILD_DIR)/$(SWIFT_EXECUTABLE)" "$(MACOS_DIR)/$(APP_NAME)"; \
	cp "AnalyticsTray/Resources/Info.plist" "$(CONTENTS_DIR)/Info.plist"; \
	chmod 755 "$(MACOS_DIR)/$(APP_NAME)"; \
	xattr -cr "$(BUNDLE_DIR)" 2>/dev/null || true; \
	echo "Built $(BUNDLE_DIR)"

install: build
	@set -euo pipefail; \
	rm -rf "$(INSTALL_DIR)/$(BUNDLE_NAME)"; \
	cp -R "$(BUNDLE_DIR)" "$(INSTALL_DIR)/$(BUNDLE_NAME)"; \
	echo "Installed $(APP_DISPLAY_NAME) to $(INSTALL_DIR)/$(BUNDLE_NAME)"

test:
	@if ! xcrun --find xctest >/dev/null 2>&1; then \
	  printf '\nERROR: xctest not found — full Xcode is required to run Swift tests.\n'; \
	  printf '  Install Xcode from the App Store, then switch the active developer tools:\n'; \
	  printf '    sudo xcode-select --switch /Applications/Xcode.app\n'; \
	  printf '  Then retry '"'"'make -C clients/macos-tray test'"'"'.\n\n'; \
	  exit 1; \
	fi
	@swift test

run: build
	@open "$(BUNDLE_DIR)"

clean:
	@rm -rf "$(DIST_DIR)" .build
