# Streamed progress, no Job state

The V2 model — `quickDownload` RPC → backend-assigned Job ID → `task_update` push messages over a service-worker message bus → multiple subscribers reconciling state through `jobWatchers` / `terminalJobHandled` / `confettiDoneForJobId` / `jobUiMonotone` maps — is deleted. V3 uses one RPC per click; the backend streams free-form `progress` messages on the same Native-Host port until the call returns `done` or `error`.

Chosen because the V2 complexity comes from the cross-tab + multi-subscriber state model, not from progress events themselves. Native Messaging's port is bidirectional, so progress streaming is free. Removing Job IDs, the queue, cancellation, and the multi-subscriber bus deletes hundreds of lines of state-management code.

## Consequences

- Concurrent imports across two LCSC tabs are not supported. Backend returns `busy`; the second tab shows that as an error.
- No persistence of in-flight jobs across SW restarts. If the SW dies mid-conversion, the call fails; user retries.
- The Job Progress UI module from V2 is not ported — its responsibilities shrink to "render the current `progress` message on the active button".
