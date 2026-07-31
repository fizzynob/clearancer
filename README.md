# clearancer

A retro, paper-ledger-styled desktop app for tracking Learning Activity Sheet (LAS) and quiz scores across subjects — built with [Tauri](https://tauri.app) (Rust + TypeScript, no frontend framework).

Everything is stored locally as a single JSON file and autosaved every 10 seconds — no account, no server, no cloud sync required (Google Classroom sync is optional).

## Features

- **Six subject tabs** (Science, Filipino, Araling Pan., TLE, CommArts, Math), each with its own LAS and quiz tables
- **Inline quick-edit** — click a CD/WW/quiz score or a status tag to edit it in place, like a spreadsheet cell; right-click a row for the full edit form
- **Drag-to-paint status** — shift+drag to mark a run of rows "graded", ctrl+drag for "pending", shift+right-drag for "submitted"
- **Auto-calculated subject completion** — weighted percentage and progress bar computed from graded LAS + quiz scores
- **Google Classroom sync** — connects with your own Google Cloud OAuth client, detects your classes, matches each one to a subject by name, and imports its coursework/materials/announcement attachments as LAS entries (see setup below)
- **Numeric LAS tag parsing** — understands `[LAS 01]`, `LAS 01 - Title`, `1Q7 Title`, `LAS5A`, decimal sub-numbers (`2.1`), etc., and sorts LAS entries numerically
- **Dark mode** — follows your OS preference by default, or toggle it manually
- **System Media Transport Controls widget** — shows what's currently playing on Windows with a small animated equalizer (metadata only; there's no raw audio to visualize, so it's a stylized pulse tied to play/pause state, not a real audio-reactive visualizer)
- **Local autosave** — atomic writes to a JSON file in the OS app-data directory, plus a manual save button

## Development

Prerequisites: [Node.js](https://nodejs.org), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform (Windows: WebView2, which ships with Windows 10/11).

```bash
npm install
npm run tauri dev
```

## Building a release binary

```bash
npm run tauri build
```

This produces a standalone executable and an installer (NSIS/MSI on Windows) under `src-tauri/target/release/`.

## Google Classroom setup

Sync requires your own Google Cloud OAuth client — this repo doesn't (and can't safely) ship a shared one.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Enable the **Google Classroom API** for it.
3. Under **APIs & Services → OAuth consent screen**, choose **External**, fill in the basic app info, add these scopes:
   - `.../auth/classroom.courses.readonly`
   - `.../auth/classroom.coursework.me.readonly`
   - `.../auth/classroom.student-submissions.me.readonly`
   - `.../auth/classroom.courseworkmaterials.readonly`
   - `.../auth/classroom.announcements.readonly`
   - `.../auth/userinfo.email`
   and add your own Google account as a test user. Leave it in **Testing** mode — no verification needed for personal use.
4. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Desktop app**. Copy the Client ID and Client Secret.
5. In the app, open **las options → sync to google classroom**, paste in the Client ID/Secret, and connect. Your browser will show an "unverified app" warning — that's expected for a personal OAuth client; click through it to continue.

## Data storage

All tracker data lives in a single `data.json` in the OS app-data directory (findable via **las options → show data file in explorer**). Google OAuth tokens are stored separately in `google_auth.json` in the same directory, in plain text — this is a personal local tool, not a hardened credential store.

## License

No license is granted. The source is public for reference, but all rights are reserved by the author.
