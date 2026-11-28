# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# The server's platform-independent part (#116), circagraph-server-platform.tar.gz: the
# editor and the Next.js platform built on Linux, the converter's sources with their Rust
# crates (to build offline), the documentation and the Homebrew commands. The FreeBSD package
# (deploy/freebsd-server/build.sh) and the Homebrew formula (deploy/homebrew) build cg-convert
# and pgmp for their systems from it. Use scripts/server-package.mjs platform.
#   OCH_BUILD_COMMIT, OCH_BUILD_VERSION

# The Rust crates of cg-convert, vendored into the platform's source archive.
FROM rust:1.100.0-bookworm@sha256:75d26c23c24cc6ea1cdabf0714a6bff8fd7bf3248716043fd7ae86dac7f41b94 AS native
WORKDIR /build
COPY native-store native-store
COPY vendor/sqlite-rational vendor/sqlite-rational
RUN cargo vendor --locked --manifest-path native-store/Cargo.toml /build/rust-dependencies

# The editor and the Next.js platform: plain JavaScript, the same for every distribution.
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS app
# apt retries a failed download and gives up on a stalled mirror after 30 s (#367).
RUN printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ARG OCH_BUILD_COMMIT
ARG OCH_BUILD_VERSION
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/rational-ordered-map-0.1.0.tgz vendor/
RUN npm ci
# As deploy/Dockerfile.app: the platform links its complete source, including the Rust
# crates of the bundled cg-convert.
COPY scripts scripts
COPY LICENSE NOTICE THIRD_PARTY.md ./
COPY legal legal
COPY src src
COPY server server
COPY platform platform
COPY native-store native-store
COPY src-tauri src-tauri
COPY vendor vendor
COPY docs docs
COPY deploy deploy
COPY test test
COPY .github .github
COPY README.md compose.yml tsconfig.json pnpm-lock.yaml yarn.lock .yarnrc.yml .dockerignore .gitignore .env.example ./
COPY --from=native /build/rust-dependencies /app/rust-dependencies
RUN --mount=type=bind,target=/build-context \
    export OCH_BUILD_CONTEXT=/build-context OCH_BUILD_COMMIT="$OCH_BUILD_COMMIT" \
      OCH_BUILD_VERSION="$OCH_BUILD_VERSION" \
    && npm run build \
    && node scripts/source.mjs --rust-vendor /app/rust-dependencies \
    && cp dist/circagraph-web-source.tar.gz platform/public/

# The application, laid out as the Linux packages do, without their Linux-only image library
# (the platform does not optimize images) and without a Node.js runtime: FreeBSD's node24
# package and Homebrew's node@24 provide it.
FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e AS tree
COPY --from=app /app/platform/.next/standalone /out/lib/circagraph/
COPY --from=app /app/platform/.next/static /out/lib/circagraph/platform/.next/static
COPY --from=app /app/platform/public /out/lib/circagraph/platform/public
COPY --from=app /app/dist /out/lib/circagraph/dist
COPY --from=app /app/package.json /out/lib/circagraph/
COPY --from=app /app/server /out/lib/circagraph/server
COPY --from=app /app/legal /out/lib/circagraph/legal
COPY deploy/debian-server/circagraph-server.mjs /out/lib/circagraph/circagraph-server.mjs
# The docs first, so the project's README, not docs/README.md, is the one installed.
COPY docs /out/doc/
COPY LICENSE NOTICE THIRD_PARTY.md README.md /out/doc/
# cg-convert's sources and crates, with cargo set to build from them offline.
COPY native-store /out/native/native-store
COPY vendor/sqlite-rational /out/native/vendor/sqlite-rational
COPY --from=native /build/rust-dependencies /out/native/rust-dependencies
COPY deploy/homebrew/cargo-config.toml /out/native/.cargo/config.toml
# The Homebrew formula's commands and configuration templates (deploy/homebrew).
COPY deploy/homebrew /out/homebrew
COPY deploy/debian-server/circagraph.env deploy/debian-server/syslog.env \
    deploy/debian-server/github.env /out/homebrew/
RUN rm -rf /out/lib/circagraph/node_modules/@img /out/homebrew/cargo-config.toml \
    /out/homebrew/*.rb.in /out/homebrew/tap-README.md /out/homebrew/README.md \
    && tar -C /out -czf /circagraph-server-platform.tar.gz lib doc native homebrew

FROM scratch AS export
COPY --from=tree /circagraph-server-platform.tar.gz /
