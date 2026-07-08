FROM node:24.14-alpine AS build

ARG TARGETARCH
ARG XRAY_CORE_REPOSITORY=moroz-374/Xray-core
ARG XRAY_CORE_VERSION=v26.3.27-rw.1-rc.1
ARG XRAY_CORE_REVISION=d69534e75e12bd901671a87f0edf5709db98edd9
ARG XRAY_CORE_AMD64_SHA256=84493d09e23a24812dd021dcdc8189dc20a59ec8ad7474c24afa23b3c452f55f
ARG XRAY_CORE_ARM64_SHA256=597a747f5e542623ee09c54dec87a9b8c07badbc71ab94db429f4b84ca0dc6b9

WORKDIR /opt/app

ADD . .

RUN npm ci --legacy-peer-deps
RUN npm run build --omit=dev
RUN npm run test:traffic-audit

RUN apk add --no-cache curl unzip \
    && set -eux; \
    case "${TARGETARCH}" in \
        amd64) xray_asset="Xray-linux-64.zip"; xray_sha256="${XRAY_CORE_AMD64_SHA256}" ;; \
        arm64) xray_asset="Xray-linux-arm64-v8a.zip"; xray_sha256="${XRAY_CORE_ARM64_SHA256}" ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    xray_base_url="https://github.com/${XRAY_CORE_REPOSITORY}/releases/download/${XRAY_CORE_VERSION}"; \
    xray_tmp="$(mktemp -d)"; \
    cd "${xray_tmp}"; \
    curl --fail --location --show-error --proto '=https' --tlsv1.2 --output "${xray_asset}" "${xray_base_url}/${xray_asset}"; \
    curl --fail --location --show-error --proto '=https' --tlsv1.2 --output "${xray_asset}.sha256" "${xray_base_url}/${xray_asset}.sha256"; \
    grep -Eq "^[0-9a-f]{64}[[:space:]]+\\*?${xray_asset}$" "${xray_asset}.sha256"; \
    sha256sum -c "${xray_asset}.sha256"; \
    printf '%s  %s\n' "${xray_sha256}" "${xray_asset}" | sha256sum -c -; \
    unzip -q "${xray_asset}" -d xray; \
    mkdir -p /usr/local/share/xray; \
    install -m 0755 xray/xray /usr/local/bin/xray; \
    install -m 0644 xray/geoip.dat /usr/local/share/xray/geoip.dat; \
    install -m 0644 xray/geosite.dat /usr/local/share/xray/geosite.dat; \
    cd /; \
    rm -rf "${xray_tmp}"

RUN echo '#!/bin/sh' > /usr/local/bin/xlogs \
    && echo 'tail -n +1 -f /var/log/supervisor/xray.out.log' >> /usr/local/bin/xlogs \
    && chmod +x /usr/local/bin/xlogs

RUN echo '#!/bin/sh' > /usr/local/bin/xerrors \
    && echo 'tail -n +1 -f /var/log/supervisor/xray.err.log' >> /usr/local/bin/xerrors \
    && chmod +x /usr/local/bin/xerrors


FROM node:24.14-alpine

ARG XRAY_CORE_REPOSITORY=moroz-374/Xray-core
ARG XRAY_CORE_VERSION=v26.3.27-rw.1-rc.1
ARG XRAY_CORE_REVISION=d69534e75e12bd901671a87f0edf5709db98edd9
ARG XRAY_CORE_AMD64_SHA256=84493d09e23a24812dd021dcdc8189dc20a59ec8ad7474c24afa23b3c452f55f
ARG XRAY_CORE_ARM64_SHA256=597a747f5e542623ee09c54dec87a9b8c07badbc71ab94db429f4b84ca0dc6b9

LABEL org.opencontainers.image.title="Remnawave Node"
LABEL org.opencontainers.image.description="Remnawave Node with built-in XRay Core"
LABEL org.opencontainers.image.url="https://github.com/moroz-374/node"
LABEL org.opencontainers.image.source="https://github.com/moroz-374/node"
LABEL org.opencontainers.image.vendor="Remnawave"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.documentation="https://docs.rw"
LABEL org.remnawave.xray.repository="${XRAY_CORE_REPOSITORY}"
LABEL org.remnawave.xray.version="${XRAY_CORE_VERSION}"
LABEL org.remnawave.xray.revision="${XRAY_CORE_REVISION}"
LABEL org.remnawave.xray.asset.linux-amd64.sha256="${XRAY_CORE_AMD64_SHA256}"
LABEL org.remnawave.xray.asset.linux-arm64.sha256="${XRAY_CORE_ARM64_SHA256}"

WORKDIR /opt/app

COPY --from=build /opt/app/dist /opt/app/dist
COPY --from=build /usr/local/bin/xray /usr/local/bin/xray
COPY --from=build /usr/local/share/xray/geoip.dat /usr/local/share/xray/geoip.dat
COPY --from=build /usr/local/share/xray/geosite.dat /usr/local/share/xray/geosite.dat
COPY --from=build /usr/local/bin/xlogs /usr/local/bin/xlogs
COPY --from=build /usr/local/bin/xerrors /usr/local/bin/xerrors

COPY supervisord.conf /etc/supervisord.conf
COPY docker-entrypoint.sh /usr/local/bin/
COPY package*.json ./
COPY ./libs ./libs

RUN apk add --no-cache supervisor libnftnl libmnl && \
    mkdir -p /var/log/supervisor /var/log/xray && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh && \
    ln -s /usr/local/bin/xray /usr/local/bin/rw-core

RUN npm ci --omit=dev --legacy-peer-deps \
    && npm cache clean --force \
    && npm link

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-http-header-size=65536"
ENV UV_THREADPOOL_SIZE=24

ENV XTLS_API_PORT=61000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/src/main"]
