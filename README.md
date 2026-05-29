# Claude Desktop Plus

Claude Desktop Plus adds Simplified Chinese support, local localization patches, and a lightweight Plus entry to Claude Desktop.

This project does not redistribute Claude Desktop binaries. It scans the user's local Claude Desktop installation and applies recoverable local changes.

## Quick Install

Download the installer for your platform from GitHub Releases:

- Windows: install the `.msi` or `.exe` package.
- macOS: open the `.dmg` and move Claude Desktop Plus to Applications.
- Linux: install the `.deb` or `.rpm`, or run the AppImage.

On first launch, Claude Desktop Plus automatically scans your local Claude Desktop, installs the language pack, writes the Plus entry, and creates a `Claude Desktop Plus` launcher icon. Use that new launcher to start the enhanced Claude Desktop.

## Updates

Claude Desktop Plus uses the Tauri updater. Open the About page and click **Check for updates**. Release assets and `latest.json` are published on GitHub Releases.

If the built-in updater is unavailable, download the newest installer from:

https://github.com/duanluan/claude-desktop-plus/releases/latest

Each release also includes `SHA256SUMS` for manual checksum verification.

## Restore

Use the app's Restore action or run:

```sh
pnpm cdp:restore
```

Restore removes the Plus launcher state and restores the tracked local Claude Desktop changes where possible.

## Release

Formal desktop releases are built from tags with GitHub Actions.

Required secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_UPDATER_PUBKEY` (optional when using the committed public key)
- `CLAUDE_DESKTOP_PLUS_RELEASE_TOKEN` (optional when using `GITHUB_TOKEN`)

Required for a formal signed macOS release:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Local release checks:

```sh
pnpm release:doctor
pnpm release:desktop
pnpm release:publish --dry-run
```

Linux AppImage can be built in the Ubuntu 22.04 Docker environment:

```sh
pnpm release:linux-appimage
```

## Development

```sh
pnpm install
pnpm tauri:build
```

Useful local commands:

```sh
pnpm cdp:setup
pnpm cdp:launch
pnpm cdp:doctor
pnpm cdp:restore
```
