# Sideloading GRETTA into Word

These steps install the **development build** of GRETTA into Word on each platform. They assume:

```bash
pnpm install
pnpm certs:install    # localhost dev certificate created and trusted
pnpm dev              # dev server running at https://localhost:3000
```

Before sideloading, confirm the pane loads in a regular browser at <https://localhost:3000/taskpane.html> with no certificate warning. If the browser warns about the certificate, Word will refuse to load the pane at all — re-run `pnpm certs:install` first.

---

## Word for Windows

Word for Windows installs dev add-ins from a **shared folder catalog**:

1. Create a folder for manifests, e.g. `C:\gretta-manifests`, and copy `manifest\manifest.xml` into it.
2. Share the folder with yourself: right-click → **Properties → Sharing → Share…** → add your own account → **Share**. Note the network path it reports, e.g. `\\YOUR-PC\gretta-manifests`.
3. In Word: **File → Options → Trust Center → Trust Center Settings… → Trusted Add-in Catalogs**.
4. Paste the network path into **Catalog Url**, click **Add catalog**, and tick **Show in Menu**. OK out and **restart Word**.
5. **Home → Add-ins → More Add-ins** (older builds: **Insert → My Add-ins**) → **SHARED FOLDER** tab → **GRETTA** → **Add**.

An **Open GRETTA** button appears on the Home ribbon.

## Word for Mac

**The fast path — one command:**

```bash
pnpm install
pnpm certs:install    # once per machine: trust the localhost dev certificate
pnpm dev:mac          # sideloads the manifest, starts dev server + Ollama proxy
```

`pnpm dev:mac` does everything the manual steps below used to require: it copies
the manifest into Word's `wef` folder, starts the Vite dev server and the
HTTPS→Ollama proxy together (logs are prefixed `[dev]` and `[proxy]`), and tears
both down on Ctrl+C. The only manual step it can't do is restart Word — Word
reads the add-in folder only at launch, so **quit Word completely (⌘Q) and
reopen** after the first run. Then **Home → Add-ins → GRETTA**, and set the
Ollama URL in Settings to `https://localhost:11435`.

Re-run with `pnpm dev:mac --no-sideload` if the manifest is already in place and
you just want the two servers.

<details>
<summary><strong>Manual steps (fallback, if you prefer to run pieces yourself)</strong></summary>

Word for Mac reads dev manifests from its `wef` folder. In three terminals/steps:

1. Copy the manifest (create the folder if it doesn't exist):

   ```bash
   mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
   cp manifest/manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
   ```

2. Start the dev server and, in a second terminal, the proxy:

   ```bash
   pnpm dev      # https://localhost:3000
   pnpm proxy    # https://localhost:11435 → http://127.0.0.1:11434
   ```

3. **Restart Word.**
4. **Home → Add-ins → More Add-ins** (older builds: **Insert → Add-ins ▾ dropdown**) → under **Developer Add-ins** → **GRETTA**.

</details>

> **Mac + Ollama:** the connection check fails against `http://127.0.0.1:11434` —
> that's the WKWebView mixed-content limitation, not a bug. The proxy (started
> for you by `pnpm dev:mac`, or manually by `pnpm proxy`) bridges it; point the
> Ollama URL at `https://localhost:11435`.

## Word on the web

1. Open a document at <https://word.new> (Microsoft 365 account).
2. **Home → Add-ins → More Add-ins** (or **Insert → Add-ins**) → **MY ADD-INS** tab → **Upload My Add-in**.
3. Browse to `manifest/manifest.xml` → **Upload**.

The pane is served from your machine's `https://localhost:3000`, so the dev server must stay running in the same browser session. Chromium-based browsers can call Ollama directly; Safari has the same mixed-content limitation as Word for Mac (use `pnpm proxy`).

---

## Uninstalling

- **Windows:** delete the manifest from the shared folder and/or remove the catalog from Trusted Add-in Catalogs; restart Word.
- **Mac:** delete the manifest from the `wef` folder; restart Word.
- **Web:** uploaded add-ins only last for the session — just reload.

## Troubleshooting

- **Blank pane / "add-in could not be started":** the dev server isn't running, or the certificate isn't trusted — check `pnpm dev` output and re-run `pnpm certs:install`.
- **Add-in doesn't appear in the list:** wrong catalog path (Windows) or wrong `wef` path (Mac); confirm the manifest file is actually in the folder, then restart Word — the list is only read at startup.
- **Changed the manifest?** Word caches manifests aggressively: remove the add-in, restart Word, re-add. (Editing `src/` needs no re-sideload — Vite hot-reloads the pane.)
- **Port 3000 busy:** the dev server uses `strictPort` — stop whatever holds the port; the manifest's URLs are pinned to 3000.
