# HOHE application image (Phase 3): the Go server with the PWA client embedded, on distroless.
# Build context: the repository root (it needs both web/ and server/).
#
#   docker buildx build --build-arg VERSION=<commit> -t hohe:dev .
#
# Stage 1 builds the client on the build platform (the output is platform-independent).
# Stage 2 cross-compiles a static Go binary with that client embedded.
# The final stage is distroless static, run as nonroot.

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web
# The client's npm dependencies exist only in this stage; scan it so the SBOM lists them.
ARG BUILDKIT_SBOM_SCAN_STAGE=true
ARG VERSION=dev
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN HOHE_VERSION="$VERSION" npm run build

FROM --platform=$BUILDPLATFORM golang:1.27 AS build
# Without these the SBOM is empty: the final stage is a single static binary with no
# package database, so the dependency inventory exists only in this stage.
ARG BUILDKIT_SBOM_SCAN_STAGE=true
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# The committed web/static holds only a placeholder; the image embeds the real client.
RUN rm -rf web/static
COPY --from=web /web/dist ./web/static
RUN test -f web/static/sw.js && test -f web/static/index.html
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${VERSION}" -o /out/hohe ./cmd/hohe

FROM gcr.io/distroless/static-debian13:nonroot
ARG VERSION=dev
LABEL org.opencontainers.image.title="hohe" \
      org.opencontainers.image.description="HOHE: a self-hosted ABC123 daily planner (server and PWA)" \
      org.opencontainers.image.source="https://github.com/kevinpinscoe/hohe" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$VERSION
COPY --from=build /out/hohe /hohe
USER nonroot:nonroot
EXPOSE 8080
VOLUME ["/data"]
# Asserts the server answers /healthz with ok (the store is readable), not mere liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/hohe", "healthcheck"]
ENTRYPOINT ["/hohe"]
CMD ["serve", "--config", "/config/config.json"]
