SHELL := /bin/bash

APP_NAME := AnalyticsTray
APP_DISPLAY_NAME := pi Analytics Tray
BUNDLE_NAME := $(APP_NAME).app
BUILD_CONFIGURATION := release
BUILD_DIR := .build/$(BUILD_CONFIGURATION)
DIST_DIR := dist
BUNDLE_DIR := $(DIST_DIR)/$(BUNDLE_NAME)
CONTENTS_DIR := $(BUNDLE_DIR)/Contents
MACOS_DIR := $(CONTENTS_DIR)/MacOS
RESOURCES_DIR := $(CONTENTS_DIR)/Resources
INSTALL_DIR := /Applications

.PHONY: build install test run clean

build:
	@set -euo pipefail; \
	swift build --configuration "$(BUILD_CONFIGURATION)"; \
	rm -rf "$(BUNDLE_DIR)"; \
	mkdir -p "$(MACOS_DIR)" "$(RESOURCES_DIR)"; \
	cp "$(BUILD_DIR)/$(APP_NAME)" "$(MACOS_DIR)/$(APP_NAME)"; \
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
	@swift test

run: build
	@open "$(BUNDLE_DIR)"

clean:
	@rm -rf "$(DIST_DIR)" .build
