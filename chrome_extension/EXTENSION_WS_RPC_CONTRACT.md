# Extension WebSocket JSON-RPC contract

The service worker opens `ws(s)://<api-host>/ws/extension` and sends messages shaped as `{ id, method, params }`. Replies are `{ id, result }` or `{ id, error: { message, code } }`.

Server push (not RPC): `{ type: "task_update", task_id, payload }`.

## Methods (alphabetical)

| Method | Params (JSON) | Result |
|--------|-----------------|--------|
| `ping` | `{}` | server-defined |
| `health` | `{}` | server-defined |
| `list_tasks` | `{}` | array of task summaries |
| `get_task_detail` | `{ task_id }` | task detail |
| `subscribe_task` | `{ task_id }` | ack |
| `enqueue_task` | `TaskCreatePayload` fields (`lcsc_id`, `output_path`, flags, template, overrides, …) | task summary |
| `libraries_scaffold` | library scaffold request | paths + `created` |
| `libraries_validate` | `{ path }` | library inspection |
| `libraries_component` | `{ path, lcsc_id }` | single component presence (batch multi-ID check removed — unused by the extension) |
| `fs_roots` | `{}` | roots list |
| `fs_list` | `{ path }` | directory listing |
| `fs_check` | `{ path }` | path check |
| `templates_symbols` | `{ lib_path }` | `{ symbols: string[] }` |
| `templates_check` | `{ lib_path }` | `{ [name]: boolean }` |
| `templates_pin_check` | payload | pin check result |
| `templates_gallery_pin_summary` | payload | gallery pin summary |
| `templates_preview_svg` | payload | SVG / preview data |
| `templates_pin_map_context` | payload | context for pin map |
| `lcsc_footprint_preview` | payload | footprint preview bundle |

Parameter and result shapes are defined by Pydantic models in `easyeda2kicad/api/` (see `server.py` / `models.py`). Renaming methods or fields requires updating both the Python handler map and `chrome_extension/background.js` callers.

## Manual smoke (LCSC)

1. Backend running; extension Backend URL matches.
2. Open an LCSC product page; buttons appear; connection state sane.
3. Import one part (with and without template if applicable); job completes.
4. Popup: library list and settings still persist.

## Automated tests

Run `pytest` from the repository root.
