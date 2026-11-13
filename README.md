# Herdr Plugin for Snowflake Cortex Code

[Herdr](https://herdr.dev) integration for the Snowflake Cortex Code (`cortex`) CLI.

## Requirements

- Herdr 0.7.0 or later
- Node.js available as `node`
- Snowflake Cortex Code available as `cortex`

The plugin is public and distributed under the [MIT License](LICENSE).

## Install

Install from GitHub:

```bash
herdr plugin install hvkiefer/herdr-plugin-snowflake-cortex-code
```

For local development:

```bash
herdr plugin link /path/to/herdr-plugin-snowflake-cortex-code
```

Linking the plugin runs its startup action and installs the Cortex lifecycle hook. You can manually reinstall or remove that hook through the **Cortex Code: Install Herdr hooks** and **Cortex Code: Uninstall Herdr hooks** actions.

## Features

### Agent state and session restore

When Cortex Code runs in a Herdr pane, the installed hook reports its lifecycle to Herdr:

| Cortex Code event | Herdr state or action |
| --- | --- |
| `SessionStart` | Claims the pane as a `cortex` agent, records the session ID and transcript path, and stores `cortex --resume <session-id>` when valid. |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | Reports `working`. |
| `PermissionRequest` | Reports `blocked` and identifies the requested tool. |
| `PreToolUse` for `ask_user_question` | Reports `blocked` while waiting for an answer. |
| `Stop` | Reports `idle`. |
| `SessionEnd` | Releases the agent unless Cortex Code cleared the session. |

The hook exits immediately outside a Herdr-managed pane. It only changes hook entries that it owns in `~/.snowflake/cortex/hooks.json`.

### Actions

| Action ID | Description |
| --- | --- |
| `snowflake.cortex-code.split-right` | Split right and launch Cortex Code. |
| `snowflake.cortex-code.split-down` | Split down and launch Cortex Code. |
| `snowflake.cortex-code.new-tab` | Create a `cortex` tab and launch Cortex Code. |
| `snowflake.cortex-code.open-overlay` | Open Cortex Code in an overlay pane. |
| `snowflake.cortex-code.resume` | Open the Cortex Code session picker in an overlay pane. |
| `snowflake.cortex-code.send-selection` | Send terminal selection to an existing Cortex Code pane, or start one in a split. |
| `snowflake.cortex-code.install-hooks` | Install or refresh the lifecycle hook. |
| `snowflake.cortex-code.uninstall-hooks` | Remove the lifecycle hook. |

### Managed panes

```bash
herdr plugin pane open --plugin snowflake.cortex-code --entrypoint cortex
herdr plugin pane open --plugin snowflake.cortex-code --entrypoint resume --placement popup --width 80% --height 80%
```

## Optional keybindings

Add the desired actions to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+c"
type = "plugin_action"
command = "snowflake.cortex-code.split-right"
description = "split right and launch Cortex Code"

[[keys.command]]
key = "prefix+C"
type = "plugin_action"
command = "snowflake.cortex-code.open-overlay"
description = "open Cortex Code overlay"

[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "snowflake.cortex-code.resume"
description = "resume Cortex Code session"
```

These keybindings are independent of other plugin configuration, including `[[plugins.herdr-app-tab.tabs]]`; retain those sections when updating your local Herdr configuration.

## Verify

```bash
herdr plugin list
herdr plugin action list --plugin snowflake.cortex-code
herdr plugin log list --plugin snowflake.cortex-code
herdr agent list
```

To list the plugin in the Herdr Marketplace after publishing, add the `herdr-plugin` GitHub topic to the public repository.
