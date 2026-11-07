# HOHE Phase 2 spike image: a static Go binary with the PWA embedded, on distroless.
# Build context: the spike/ directory.
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
# Without these the SBOM is empty: the final stage is a single static binary with no
# package database, so the dependency inventory exists only in this stage.
ARG BUILDKIT_SBOM_SCAN_STAGE=true
ARG BUILDKIT_SBOM_SCAN_CONTEXT=true
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/hohe-spike ./cmd/hohe-spike

FROM gcr.io/distroless/static-debian13:nonroot
ARG VERSION=dev
LABEL org.opencontainers.image.title="hohe-spike" \
      org.opencontainers.image.description="HOHE Phase 2 technical spike (synthetic, in-memory data only)" \
      org.opencontainers.image.source="https://github.com/kevinpinscoe/hohe" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$VERSION
COPY --from=build /out/hohe-spike /hohe-spike
USER nonroot:nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/hohe-spike", "--healthcheck"]
ENTRYPOINT ["/hohe-spike"]
