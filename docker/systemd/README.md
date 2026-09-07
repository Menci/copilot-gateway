# Podman Quadlet (systemd) configurations

Podman Quadlets allow you to manage containers as native systemd services. These configuration files allow you to deploy and auto-start Floway using systemd.

## Upgrade from the split dashboard container

This release serves the dashboard from `floway-server`; the separate
`floway-web` image is no longer published. Before updating an existing Quadlet
deployment, remove its `floway-web.container` unit, then reload systemd and
restart `floway-server`:

```bash
rm ~/.config/containers/systemd/floway-web.container
systemctl --user daemon-reload
systemctl --user restart floway-server
```

For a root-managed deployment, replace the path and commands with their `sudo`
equivalents under `/etc/containers/systemd/`.

## Rootless installation

1. Install [Podman](https://podman.io).

   Podman should be preinstalled on Red Hat systems, and can be installed on-demand on other systems.

   On Debian, the Podman package might be missing a `catatonit` dependency. Install it, or Pods might not start.

2. ```bash
   mkdir -p ~/.config/containers/systemd/
   cp floway-data.volume floway-server.container.example floway.pod ~/.config/containers/systemd/
   ```

3. Edit `~/.config/containers/systemd/floway-server.container.example` by replacing `<admin-secret>` with your desired admin secret.

4. ```bash
   mv ~/.config/containers/systemd/floway-server.container.example ~/.config/containers/systemd/floway-server.container
   loginctl enable-linger
   systemctl --user daemon-reload
   systemctl --user restart floway-server
   ```

5. Floway should be available at `http://localhost:18088`.

## Root installation

1. Install [Podman](https://podman.io).

   Podman should be preinstalled on Red Hat systems, and can be installed on-demand on other systems.

   On Debian, the Podman package might be missing a `catatonit` dependency. Install it, or Pods might not start.

2. ```bash
   sudo mkdir -p /etc/containers/systemd/
   sudo cp floway-data.volume floway-server.container.example floway.pod /etc/containers/systemd/
   ```

3. Edit `/etc/containers/systemd/floway-server.container.example` by replacing `<admin-secret>` with your desired admin secret.

4. ```bash
   sudo mv /etc/containers/systemd/floway-server.container.example /etc/containers/systemd/floway-server.container
   sudo systemctl daemon-reload
   sudo systemctl restart floway-server
   ```

5. Floway should be available at `http://localhost:18088`.
