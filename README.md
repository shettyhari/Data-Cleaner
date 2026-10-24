# Data Cleaner

A local web app that finds duplicate files on any drive or folder, lets you delete them, and organizes messy folders.

## Run

Double-click `start.bat`, or:

```
node server.js
```

Then open http://localhost:4321. Requires Node.js 18+ and no other dependencies.

## Hosted / browser mode

If the page is opened without `server.js` running (for example deployed as a static site on Vercel or GitHub Pages), it automatically switches to **browser mode**:

- Uses the browser's File System Access API, so it works in **Chrome or Edge** on a computer.
- You pick a folder with the browser's own dialog. Browsers don't allow picking whole system drives such as `C:\`, but subfolders are fine.
- Deleted duplicates are removed permanently, because browsers can't use the Recycle Bin.
- Organize and undo work the same way. The undo history lasts until the page is reloaded.

For full drive access and Recycle Bin support, run the app locally with `start.bat`.

## Features

**Duplicate Finder**
- Pick any drive (C:, D:, USB…) or folder through the built-in folder browser.
- Compares files by size, then a quick partial hash, then a full SHA-256 hash, so only byte-identical files are reported.
- Filters: minimum file size, file type (images, videos, audio, documents, archives), hidden files.
- Auto-select rules: keep oldest, keep newest, or keep shortest path.
- Delete to the **Recycle Bin** (default) or permanently.
- Safety: the server only deletes files that came from a scan, and refuses to delete every copy of a file.
- System folders (Windows, Program Files, $Recycle.Bin, System Volume Information, node_modules, .git) are skipped.

**Organize Folder**
- Sort a folder's files into sub-folders by type, date (year/month), type + year, extension, or size.
- Optional: pull in files from sub-folders too.
- Preview every move before applying. Name clashes get ` (1)`, ` (2)`… suffixes; nothing is overwritten.
- **Undo** the last organize (files go back, empty folders are removed).

The server listens on 127.0.0.1 only and rejects requests from other websites.
