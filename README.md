# Cookie Knight

Cookie Knight is a Manifest V3 Chrome extension for removing unwanted cookies while keeping trusted sites protected.

It clears cookies after the final open tab for a site domain is closed. Exact domains and wildcard patterns such as `*.example.com` can be added to the whitelist, so sites you trust can keep their cookies.

## Features

- Automatically removes cookies after the last tab for a site domain is closed.
- Whitelist supports exact domains, subdomains, and wildcard patterns.
- Modern responsive popup for quick whitelist changes and cookie inspection.
- Per-cookie and per-tab cookie removal from the popup.
- Optional toolbar quick action to add or remove the current site from the whitelist.
- Optional context menu actions, requested only when enabled.
- Toolbar badge shows active cookie count for the current tab and hides zero.
- Configurable cleanup delay after the final tab closes.
- Optional cleanup of related isolated partitioned cookies.
- Optional localStorage cleanup with the optional `browsingData` permission.
- Optional startup cleanup for cookies not protected by the whitelist.
- Export and import for settings and whitelist.
- Light and dark toolbar icon themes selectable in settings.
- Localized interface for English, Russian, German, Polish, Spanish, Italian, Portuguese, Turkish, Ukrainian, French, Japanese, Korean, Simplified Chinese, and Hindi.

## Privacy

Cookie Knight works locally in the browser. It does not collect, sell, transmit, or share browsing data, cookies, domains, settings, or usage analytics.

## Chrome Web Store Readiness

- Built for Manifest V3.
- No remote code execution.
- No analytics or external tracking.
- Optional permissions are requested only after the related feature is enabled.
- Host access is used only for reading cookie counts and removing cookies according to user settings.
- Settings and whitelist data stay in Chrome storage and can be exported or imported by the user.

## Permissions

Cookie Knight uses the minimum permissions needed for its cookie workflow:

- `cookies`: read cookie counts and remove selected cookies.
- `storage`: save settings, whitelist, counters, and import/export state.
- `alarms`: run delayed cleanup reliably when the Manifest V3 service worker is asleep.
- `<all_urls>` host access: required by Chrome to read and remove cookies for visited sites.

Optional permissions:

- `contextMenus`: requested only if context menu integration is enabled.
- `browsingData`: requested only if localStorage cleanup is enabled.

## Toolbar Icon Theme

The settings page includes a toolbar icon theme selector. Users can choose a light or dark icon style so the Cookie Knight button remains clear on different Chrome themes. The extension also changes the icon color to indicate whether the current site is protected by the whitelist.

## Install Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project folder.

## Chrome Web Store Copy

Short description:

```text
Cookie Knight: Remove unwanted cookies
```

Detailed description:

```text
Cookie Knight removes unwanted cookies after the last tab for a site closes, while protecting trusted domains with a flexible whitelist. Add exact domains or wildcard rules, inspect cookies in a modern popup, remove individual cookies, and choose light or dark toolbar icons for your browser theme.
```

Privacy summary:

```text
Cookie Knight runs locally in Chrome. It does not collect, transmit, sell, or share browsing data, cookies, domains, settings, or analytics.
```

## License

MIT License. See [LICENSE](LICENSE).
