# FastChange CDN Server — Makefile
# For local development (not needed on server, start.sh bootstraps everything)

APP_NAME = app

.PHONY: all clean

# Build and run locally (requires Go installed)
run:
	@echo "[INFO] Running start.sh bootstrap..."
	bash start.sh

# Build locally (requires Go installed)
build:
	go build -ldflags="-s -w" -o $(APP_NAME) .
	@echo "[INFO] Built: $(APP_NAME) ($(shell file $(APP_NAME) 2>/dev/null || echo ''))"

# Clean build artifacts
clean:
	rm -f $(APP_NAME)
	rm -rf uploads/
	rm -rf .go/

# Format code
fmt:
	go fmt ./...

# Show file structure
files:
	@echo "Files to upload to server:"
	@echo "   main.go    — CDN server source"
	@echo "   go.mod     — Go module (minimum for detection)"
	@echo "   start.sh   — Bootstrap launcher (downloads Go + compiles)"
