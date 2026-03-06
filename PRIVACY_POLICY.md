# Privacy Policy - Niko Jikkyo

Last updated: 2026-03-07

## Overview

Niko Jikkyo is a Chrome extension that displays Niconico Live comments as an overlay on Netflix video streams. This extension is designed for personal use during the 2026 World Baseball Classic.

## Data Collection

This extension does **not** collect, store, or transmit any personal data.

### What the extension accesses

- **Niconico Live comment data**: Comments are fetched from Niconico's public comment servers and displayed in real-time. Comments are not stored or logged.
- **Channel ID**: The Niconico channel/program ID you enter is saved locally in your browser (`chrome.storage.local`) for convenience. It is never sent to any third party.

### What the extension does NOT do

- Does not collect browsing history
- Does not collect personal information
- Does not track user behavior or analytics
- Does not transmit any data to external servers other than Niconico's official APIs
- Does not store or log comments

## Permissions

- **offscreen**: Required to maintain a persistent connection to Niconico's comment server
- **storage**: Required to save your last-used channel ID locally
- **Host permissions (nicovideo.jp, netflix.com)**: Required to fetch comment data from Niconico and to display comment overlays on Netflix

## Third-party Services

This extension communicates only with:
- `live.nicovideo.jp` / `live2.nicovideo.jp` — Niconico Live APIs (authentication and WebSocket)
- `mpn.live.nicovideo.jp` — Niconico comment streaming server

No data is sent to any other third-party service.

## Contact

For questions or concerns about this privacy policy, please open an issue at the project's GitHub repository.
