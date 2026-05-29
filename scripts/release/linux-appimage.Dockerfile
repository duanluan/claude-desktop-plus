FROM ubuntu:22.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG NODE_VERSION=24.11.1
ARG PNPM_VERSION=10.33.0
ARG UBUNTU_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/ubuntu

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CARGO_REGISTRY=sparse+https://rsproxy.cn/index/ \
    npm_config_registry=https://registry.npmmirror.com \
    RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup \
    RUSTUP_HOME=/opt/rustup \
    RUSTUP_UPDATE_ROOT=https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup \
    PATH=/opt/node/bin:/opt/cargo/bin:/work/.release-cache/pnpm-home:$PATH

RUN set -eux; \
    sed -i \
      -e "s|http://archive.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}/|g" \
      -e "s|http://security.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}/|g" \
      -e "s|https://archive.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}/|g" \
      -e "s|https://security.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}/|g" \
      /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      desktop-file-utils \
      file \
      git \
      jq \
      libappindicator3-dev \
      libfuse2 \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      librsvg2-dev \
      patchelf \
      pkg-config \
      rpm \
      wget \
      xdg-utils \
      xz-utils; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) node_arch="x64"; rust_target="x86_64-unknown-linux-gnu" ;; \
      arm64) node_arch="arm64"; rust_target="aarch64-unknown-linux-gnu" ;; \
      *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/node /opt/cargo "${RUSTUP_HOME}"; \
    curl --http1.1 -fsSL --retry 5 --retry-delay 5 \
      "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ --strip-components=1 -C /opt/node; \
    npm config set registry "${npm_config_registry}"; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    curl --http1.1 -fsSL --retry 5 --retry-delay 5 \
      "${RUSTUP_UPDATE_ROOT}/dist/${rust_target}/rustup-init" \
      -o /tmp/rustup-init; \
    chmod +x /tmp/rustup-init; \
    CARGO_HOME=/opt/cargo /tmp/rustup-init -y --profile minimal --default-toolchain stable; \
    rm /tmp/rustup-init; \
    chmod -R a+rX /opt/cargo "${RUSTUP_HOME}"; \
    node --version; \
    pnpm --version; \
    rustc --version; \
    cargo --version

WORKDIR /work
