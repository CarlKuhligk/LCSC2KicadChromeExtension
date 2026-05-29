# V3 ships as a new Chrome Web Store listing; V2 unpublished at release

V3 is published under a **new Chrome Web Store listing** (new extension ID). V2 is **unpublished** from the Store at V3 release — no soft-deprecation, no final pointer-update banner, no `chrome.storage` migration code. Existing V2 installations continue working but receive no further updates; new users only discover V3.

Chosen over a same-listing in-place upgrade because V3's install ceremony is materially different (Native-Host install required, see [0001](0001-backend-via-chrome-native-messaging.md)) — auto-upgrading V2 users into a state that requires a backend they don't have would silently break their working setup. A clean break is honest about the discontinuity.

## Consequences

- V3 codebase has **no migration code**. No reading V2 settings, no compat shims.
- V3 has its own onboarding flow assuming zero prior state — Categories, Library list, Templates all start empty.
- V2 reviews and install-count do not transfer; V3 starts at zero.
- V3 schema decisions (Templates layout, Category Rule shape, etc.) optimize for V3 only — no V2 round-trip compatibility.
