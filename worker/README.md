# Execution Log sync server

A small Cloudflare Worker that keeps one copy of everything the Execution Log saves. It is used by:

- **The app** on every device. It syncs through Sync in the footer, so your phone and the claude.ai version share data.
- **Meta Muse and Claude**, through an MCP endpoint, so they can read your day and stats, check off blocks and add journal notes.

Data lives in a single Durable Object in your own Cloudflare account. Every request needs your secret key.

## Set it up (about 5 minutes, free plan)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Go to **Workers & Pages → Create → Import a repository**. Connect GitHub, pick **Journal-Tracking**, and set **Root directory** to `worker`. Leave the other settings as they are, then click **Deploy**.
3. Open the new Worker and go to **Settings → Variables and Secrets → Add**. Choose type **Secret**, name it `ELOG_KEY`, and set the value to a long random string (at least 16 characters). Save, then redeploy if Cloudflare asks.
4. Copy the Worker URL, which looks like `https://execution-log-sync.<you>.workers.dev`. Opening it should say "Execution Log sync is running."

## Connect things

| Where | What to enter |
|---|---|
| Execution Log app (each device) | Tap **Saved on this device** at the bottom, then paste the Worker URL and your key, then **Connect**. |
| Meta Muse | Add a custom MCP integration with URL `https://…workers.dev/mcp/<your key>` |
| Claude (claude.ai) | **Settings → Connectors → Add custom connector** with the same `/mcp/<your key>` URL |

The key in the MCP URL works like a password. Don't share that URL.

## MCP tools

| Tool | What it does |
|---|---|
| `get_day` | Blocks for a date, with times, categories and done flags, plus any wake-up adjustment and journal entries |
| `get_stats` | Done out of scheduled per box (for example, Journal 1 · 20/35) over the last N days |
| `get_week_schedule` | The planned blocks for each weekday, as saved in **Edit week** |
| `set_block_done` | Check off or un-check a block by label, box name or id |
| `add_journal_note` | Append to the morning or evening journal entry |
| `read_tab` | Read-only data from Expenses, Owed, Reading, Pipeline, Car, Portfolio, Recipes or Notes |

## How sync works

- Each saved key is stored as `{v, at}`, and the newer write wins.
- Day records are merged field by field. A box checked off by Muse while your phone was editing the same day keeps both changes.
- When the server has something newer, the app reloads to show it, either when it comes back to the foreground or right after a save.

## Develop

```sh
cd worker
npm test                                      # core logic tests (node --test)
echo 'ELOG_KEY=local-test-key-1234567890' > .dev.vars
npx wrangler dev                              # http://127.0.0.1:8787
```
