# Node installation and upgrade

Supported hosts are Ubuntu and Debian on `amd64` or `arm64`, with Docker Engine and Docker Compose v2. The node uses host networking and `NET_ADMIN`; run one node per configured `NODE_PORT`.

## Install

1. In the panel, create the node and copy the generated `docker-compose.yml`. The generated file already contains the one-time traffic-audit credential.
2. On the node VPS, verify Docker and the selected port before writing the compose file:

   ```sh
   docker version
   docker compose version
   test "$(uname -s)" = Linux
   case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) echo "Unsupported architecture"; exit 1;; esac
   sudo ss -H -lntup "sport = :2222"
   sudo ufw status verbose 2>/dev/null || true
   sudo nft list ruleset 2>/dev/null | grep -E 'hook input|dport (2222|{[^}]*2222)' || true
   ```

   Replace `2222` with the node port selected in the panel. `ss` must return no conflicting listener. Allow inbound TCP on that port in the VPS provider firewall and the host firewall, restricted to the panel address where possible. Do not publish the internal Xray API port `61000`.
3. Save the generated file as `/opt/remnanode/docker-compose.yml`, then validate and start it:

   ```sh
   cd /opt/remnanode
   docker compose config --quiet
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

## Health and diagnostics

The Compose healthcheck verifies that the TLS listener is accepting TCP connections on `NODE_PORT`. Check the node with:

```sh
cd /opt/remnanode
docker compose ps
docker inspect --format '{{json .State.Health}}' remnanode
docker compose logs --tail=200 remnanode
sudo ss -lntup | grep ':2222 '
```

Replace `2222` if a different port is configured. For Xray output, run `docker exec remnanode xlogs`; for Xray errors, run `docker exec remnanode xerrors`. A healthy container proves that the node listener is available; panel connectivity and an active Xray configuration must also be checked in the panel.

## Bundled Xray and licenses

The node image contains Remnawave Node application code under AGPL-3.0-only and a bundled Xray-core binary under MPL-2.0. The combined image is labelled with both licenses and keeps the notices inside the container:

```sh
docker image inspect ghcr.io/moroz-374/remnawave-node:stable \
  --format '{{json .Config.Labels}}'
docker exec remnanode cat /usr/share/doc/remnawave-node/THIRD-PARTY-NOTICES.txt
docker exec remnanode cat /usr/share/licenses/remnawave-node/LICENSE
docker exec remnanode cat /usr/share/licenses/xray-core/LICENSE
docker exec remnanode cat /usr/share/licenses/xray-core/NOTICE
docker exec remnanode rw-core version
```

The `org.remnawave.xray.*` labels identify the exact Xray-core fork repository, version, source revision and release asset checksums used by the image. The release manifest and source bundle repeat the same values.

## Upgrade

Upgrade the panel first. If the panel reports that traffic audit is not configured, rotate the node traffic-audit credential and replace the compose file with the newly generated one. Rotation revokes the previous credential immediately.

For a normal image update, keep the compose file and run exactly:

```sh
cd /opt/remnanode
docker compose pull && docker compose down && docker compose up -d
```

Then repeat the health and diagnostics commands above. The `stable` tag moves only after release acceptance; a generated compose can be archived before an update for operational rollback.
