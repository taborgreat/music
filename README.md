# songs

A small web player for the audio files in `D:\o`, with public comments.
No dependencies.

```
copy .env.example .env     (set ADMIN_KEY)
npm start
```

or double-click `start.cmd`. Then open http://localhost:3000, or the LAN
address it prints from any device on your VPN.

## What it does

- Scans the top level of the songs folder for mp3 / wav / ogg / m4a / flac
  (subfolders and `.flp` files are ignored). Hit ⟳ to rescan after saving
  new songs there.
- Lists songs by file date, newest first (or oldest first, or A–Z).
- Browse by year and month in the sidebar; search by name, comment text, or
  date (`jan 2023`, `2023-01-10`, `1-10-2023` all work).
- Random, previous and next. Arrows move through the list as it is currently
  filtered and sorted. Random pulls from every year regardless of the year
  tab you are on (search and Marked still apply) and jumps the list to the
  song. Shuffle makes a finished song jump to a random one.
- Anyone can leave comments on a song, no sign-in. Enter posts, Shift+Enter
  makes a new line.
- Mark songs with ★ and see them all under **Marked**. Marking and deleting
  comments need the admin key: click 🔑 in the header and enter it once per
  browser.

## Keyboard

| Key | Action |
| --- | --- |
| ← / → | previous / next |
| Space | play / pause |
| R | random |
| M | mark / unmark (admin) |
| / | focus search |

## Comment protection

All in memory, per visitor IP, no sign-in:

- at least 2 seconds between posts (kills double posts), max 6 a minute,
  40 an hour, 150 a day; max 5 per song per 10 minutes; max 60 a minute
  site-wide
- the same text from the same IP within a day, or on the same song from
  anyone within 10 minutes, is refused
- max 600 characters, 2 links, no 30+ repeated characters, no empty or
  symbol-only posts; control characters stripped
- a hidden honeypot field bots tend to fill: those posts are accepted and
  thrown away
- caps of 300 comments per song and 20 000 total
- 120 API requests and 600 audio requests a minute per IP; 10 wrong admin
  keys per 10 minutes
- comments store a short salted hash of the poster's IP, visible only with
  the admin key, so repeat offenders can be recognised

Limits live in `LIMITS` at the top of `server.js`.

## Config

`.env` next to `server.js` (or real environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_KEY` | unset | required for marks and deletes; unset means anyone can |
| `SONGS_DIR` | `D:\o` | folder to serve |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | bind address |
| `TRUST_PROXY` | unset | `1` to read client IPs from `X-Forwarded-For` behind a tunnel or proxy |

Marks and comments live in `data.json` next to `server.js`, keyed by file
name. Last played song, volume, sort, view, your name and the admin key are
remembered per browser.

## Putting it online

Expose port 3000 through a tunnel (cloudflared, ngrok, Tailscale Funnel) or a
reverse proxy, set `TRUST_PROXY=1` so rate limits see real visitor IPs, and
set a long `ADMIN_KEY`. Without the key anyone who finds the URL can mark
songs and delete comments.
