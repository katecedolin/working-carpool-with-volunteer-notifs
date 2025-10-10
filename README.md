# Carpool Automator (Netlify-ready)

A static, client‑side web app that builds carpool groups from a Google Sheets responses tab.

## How to deploy on Netlify
1. Download the ZIP from ChatGPT.
2. Drag‑and‑drop it into Netlify (or push these files to a repo and connect it).
3. That’s it — no build step required.

## Usage
- Paste the Google Sheets link (must be readable by **Anyone with the link**).
- Enter the total event capacity (includes drivers, self‑drivers, and riders).
- Click **Build Carpool**.

### Expected Columns
- `Name`
- `Transportation?`
- `If you can provide transportation for others` (integer seat count for drivers)

### Transportation options recognized
- **I can provide transportation for others** → driver (we expect a positive seat count)
- **I have transportation for myself** → self driver
- **I need transportation provided** → rider

All parsing happens in the browser. No server, no keys, no data leaves the client.
