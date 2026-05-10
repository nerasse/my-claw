.PHONY: all check test build build-tar release clean install-deps

VERSION := $(shell cat package.json | grep '"version"' | head -1 | awk -F: '{ print $$2 }' | sed 's/[",]//g' | tr -d '[:space:]')

all: check test build

check:
	bun run check

test:
	bun test

build: build-tar

build-tar:
	bash packaging/build-tar.sh

release:
	@echo "Tagging v$(VERSION)..."
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	git push origin "v$(VERSION)"
	@echo "CI will build and upload the tarball to Package Registry"

clean:
	rm -rf dist/

install-deps:
	sudo apt-get update
	sudo apt-get install -y ffmpeg chromium xvfb x11vnc websockify

# Local install for testing (requires sudo)
install-local: build-tar
	tar xzf "dist/my-claw-$(VERSION)-linux-x64.tar.gz" -C /tmp
	sudo /tmp/my-claw-$(VERSION)-linux-x64/packaging/install.sh --user $(shell whoami)
	rm -rf /tmp/my-claw-$(VERSION)-linux-x64
