# pi-autoname

A pi extension that automatically names sessions from the first user message.

## Features

- Generates a concise session title after the first user message
- Customizable prompt
- Uses the current conversation model by default; configurable to any available model
- All settings managed through TUI slash commands
- Built-in debug command to inspect generation status, requests, and responses

## Install

### As a local extension

Copy `extensions/pi-autoname.ts` to your pi extensions directory:

```bash
cp extensions/pi-autoname.ts ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`.

### As a pi package (npm/git)

```bash
pi install git:github.com/yourname/pi-autoname
```

## Commands

| Command | Description |
|---------|-------------|
| `/autoname-now` | Manually generate a title from the latest user message |
| `/autoname-config` | Open the TUI config menu: enable/disable, edit prompt, select model, set max length, reset defaults |
| `/autoname-debug` | Append a debug entry to the transcript showing config, status, last request/response, and errors |

## Configuration

Configuration is stored in `~/.pi/agent/pi-autoname.json`.

```json
{
  "enabled": true,
  "prompt": "You are a session title generator...",
  "model": null,
  "maxLength": 50
}
```

- `enabled`: turn auto-naming on/off
- `prompt`: the system prompt sent to the title model
- `model`: `"provider/modelId"` to use a fixed model, or `null` to use the current conversation model
- `maxLength`: maximum generated title length

## License

MIT
