// Zen Easel — the Easels section of Zen's library.
//
// Zen's library is a sidebar of sections. This adds one. The panel width and
// the search field belong to zen-library.css; nothing here sets
// --zen-library-content-width, which is the knob Spaces uses to grow the panel.
// The cards are the older framed easel cards, scaled to that native column.
// The on-board switcher (modules/library.uc.js) is a different thing and stays
// on the board.
//
// The section class is registered once per document. Custom elements cannot be
// replaced, so the class only forwards into this object — a Sine reload swaps
// the object and the already-defined element keeps working.

"use strict";

(function () {
(() => {
  // Mirrors Zen's light/dark state onto <html data-zl-scheme>. Same snippet lives in Zen Easel.
  const rootEl = document.documentElement;
  const apply = () => {
    let dark; try { dark = window.gZenThemePicker?.isDarkMode; } catch {}
    if (typeof dark !== "boolean") dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const value = dark ? "dark" : "light";
    if (rootEl.getAttribute("data-zl-scheme") !== value) rootEl.setAttribute("data-zl-scheme", value);
  };
  apply();
  if (window.__zlSchemeWatch) { window.__zlSchemeWatch.apply = apply; return; }
  window.__zlSchemeWatch = { apply };
  const run = () => window.__zlSchemeWatch.apply();
  new MutationObserver(run).observe(rootEl, { attributes: true });
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", run); } catch {}
  for (const pref of ["browser.theme.toolbar-theme", "browser.theme.content-theme", "zen.theme.color-prefs.use-workspace-colors"]) {
    try { Services.prefs.addObserver(pref, { observe: () => setTimeout(run, 50) }); } catch {}
  }
  window.addEventListener("focus", run);
})();
    const BASE = "chrome://sine/content/zen-easel/";
    const STORE = BASE + "background/store.sys.mjs";
    const SECTION_ID = "easels";
    const LIBRARY_MODULE = "moz-src:///zen/library/ZenLibrary.mjs";
    const SEARCH_MODULE = "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
    const LIT_MODULE = "chrome://global/content/vendor/lit.all.mjs";

    // Tiny cross-mod registry (same snippet lives in Zen Notes). Whichever mod loads
    // first creates it. When a "notes" provider is present, this section becomes the
    // merged "Easels & Notes" tab; when it is absent, this stays a plain Easels tab.
    const hub = (window.ZenLibraryHub ||= (() => {
        const providers = new Map(), subs = new Set();
        const emit = type => { for (const fn of [...subs]) try { fn(type); } catch (e) { console.error(e); } };
        return {
            providers,
            subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
            register(provider) { providers.set(provider.id, provider); emit("providers"); },
            unregister(id, provider) { if (!provider || providers.get(id) === provider) { providers.delete(id); emit("providers"); } },
            changed() { emit("items"); }
        };
    })());
    const merged = () => hub.providers.has("notes");

    const inBackground = event =>
        !!event && (event.button === 1 || event.getModifierState("Accel"));

    function lastTabPref() {
        try { return Services.prefs.getStringPref("zen.library.last-tab", ""); }
        catch (e) { return ""; }
    }

    function promptText(title, message, initial) {
        const value = { value: initial };
        const ok = Services.prompt.prompt(window, title, message, value, null, { value: false });
        return ok ? value.value : null;
    }

    const ZenEaselLibrarySection = {
        _cancelled: false,
        _labelWatch: new WeakMap(),
        _observers: new Set(),
        _liveBg: new Map(),

        _closeLibrary(section) {
            const lib = section?.library ?? document.querySelector("zen-library");
            const Library = lib?.constructor;
            if (Library?.animateProgress) Library.animateProgress(0);
            else Library?.toggle?.();
        },

        install() {
            this._cancelled = false;
            // Read now: the library's constructor rewrites last-tab to "history" before this section exists.
            this._lastTab = lastTabPref();
            this._provider = { id: "easels", label: "Easels", newLabel: "Easel" };
            this._hubUnsub = hub.subscribe(type => this._onHub(type));
            // Tiles follow edits made in an open easel: live while a background is dragged, then on every save.
            this._indexObserver = {
                observe: (subject, topic, data) => {
                    if (topic === "zen-easel-live-background") {
                        try {
                            const { id, background } = JSON.parse(data);
                            this._liveBg.set(id, background);
                            document.querySelector("zen-library-easels-section")?.requestUpdate();
                        } catch (e) { }
                        return;
                    }
                    this._liveBg.delete(data);
                    clearTimeout(this._reloadTimer);
                    this._reloadTimer = setTimeout(() => this._reloadOpen(), 120);
                }
            };
            for (const topic of ["zen-easel-index-changed", "zen-easel-live-background"]) Services.obs.addObserver(this._indexObserver, topic);
            hub.register(this._provider);
            const run = () => {
                if (this._cancelled || window.ZenEaselLibrarySection !== this) return;
                try { this._start(); }
                catch (e) { console.error("[zen-easel] could not add the library section:", e); }
            };
            if (customElements.get("zen-library")) {
                run();
                return;
            }
            customElements.whenDefined("zen-library").then(run).catch(() => {});
            // Zen defines <zen-library> and creates it in one call, so the wrap needs the module loaded before the first open.
            this._preload = window.requestIdleCallback(() => {
                this._preload = null;
                if (this._cancelled || customElements.get("zen-library")) return;
                try {
                    if (!Services.prefs.getBoolPref("zen.library.enabled", true)) return;
                    ChromeUtils.importESModule(LIBRARY_MODULE, { global: "current" });
                } catch (e) {
                    console.error("[zen-easel] could not load Zen's library:", e);
                }
            }, { timeout: 10000 });
        },

        destroy() {
            this._cancelled = true;
            this._hubUnsub?.(); this._hubUnsub = null;
            if (this._indexObserver) {
                for (const topic of ["zen-easel-index-changed", "zen-easel-live-background"]) { try { Services.obs.removeObserver(this._indexObserver, topic); } catch (e) { } }
                this._indexObserver = null;
            }
            clearTimeout(this._reloadTimer);
            hub.unregister("easels", this._provider); this._provider = null;
            if (this._preload) {
                window.cancelIdleCallback(this._preload);
                this._preload = null;
            }
            for (const observer of this._observers) observer.disconnect();
            this._observers.clear();
            for (const section of document.querySelectorAll("zen-library-easels-section")) {
                this.disconnect(section);
            }
        },

        _onHub(type) {
            if (this._cancelled) return;
            if (type === "providers") {
                const lib = customElements.get("zen-library")?.getInstance?.(false);
                if (lib) this._fixLabel(lib);
            }
            for (const section of document.querySelectorAll("zen-library-easels-section")) {
                if (type === "providers") this.fixSection(section);
                if (section.isConnected) section.requestUpdate();
            }
        },

        _start() {
            const ZenLibrary = customElements.get("zen-library");
            // The Zen-Library mod defines its own <zen-library> without this API; leave that one alone.
            if (typeof ZenLibrary?.getInstance !== "function" || typeof ZenLibrary.toggle !== "function") return;
            this._defineElement();
            if (!customElements.get("zen-library-easels-section")) return;

            if (!ZenLibrary.__zenEaselWrapped) {
                ZenLibrary.__zenEaselWrapped = true;
                const original = ZenLibrary.getInstance;
                // Zen calls this on hot paths (compact mode, swipes), so only the creating call adopts.
                ZenLibrary.getInstance = function (createIfMissing = true) {
                    const creating = createIfMissing && !this.instance;
                    const lib = original.call(this, createIfMissing);
                    if (lib && creating) window.ZenEaselLibrarySection?.adopt(lib, { restoreTab: true });
                    return lib;
                };
            }

            const existing = ZenLibrary.getInstance(false);
            if (existing) this.adopt(existing);
        },

        _defineElement() {
            // The shared module global has no document, and lit reads it while
            // loading. "current" is this browser window, which is where Zen
            // itself loads the library.
            const inWindow = { global: "current" };
            this._lit = ChromeUtils.importESModule(LIT_MODULE, inWindow);
            if (customElements.get("zen-library-easels-section")) return;
            const { ZenLibrarySearchSection } = ChromeUtils.importESModule(SEARCH_MODULE, inWindow);
            const { html } = this._lit;

            class ZenLibraryEaselsSection extends ZenLibrarySearchSection {
                static id = SECTION_ID;
                // Not a Fluent string Zen ships. The sidebar label is filled in
                // after render; leaving the id on the node lets Fluent clear it.
                static label = "library-easels-section-title";

                static render(library) {
                    return html`
                        <zen-library-easels-section
                            class="zen-library-section"
                            data-section=${SECTION_ID}
                            .library=${library}
                        ></zen-library-easels-section>
                    `;
                }

                get searchPlaceholderL10nId() {
                    return "zen-easel-library-search";
                }

                connectedCallback() {
                    super.connectedCallback();
                    window.ZenEaselLibrarySection?.connect(this);
                }

                disconnectedCallback() {
                    window.ZenEaselLibrarySection?.disconnect(this);
                    super.disconnectedCallback();
                }

                onShown() {
                    window.ZenEaselLibrarySection?.load(this);
                }

                onHidden() {
                    window.ZenEaselLibrarySection?.pause(this);
                }

                onLibraryOpening() {
                    window.ZenEaselLibrarySection?.load(this);
                }

                updated(changedProperties) {
                    super.updated?.(changedProperties);
                    window.ZenEaselLibrarySection?.fixSection(this);
                }

                renderItems() {
                    return window.ZenEaselLibrarySection?.renderItems(this) ?? null;
                }
            }

            customElements.define("zen-library-easels-section", ZenLibraryEaselsSection);
        },

        adopt(lib, { restoreTab = false } = {}) {
            if (!lib || this._cancelled) return;
            const Section = customElements.get("zen-library-easels-section");
            if (!Section) return;

            if (!lib.zenLibrarySections[SECTION_ID]) {
                // Right beneath Downloads (Arc's spot); after Media if there is no Downloads.
                const anchor = lib.zenLibrarySections.downloads ? "downloads" : "media";
                const sections = {};
                let placed = false;
                for (const [id, Known] of Object.entries(lib.zenLibrarySections)) {
                    sections[id] = Known;
                    if (id === anchor) {
                        sections[SECTION_ID] = Section;
                        placed = true;
                    }
                }
                if (!placed) sections[SECTION_ID] = Section;
                lib.zenLibrarySections = sections;

                // Only while being created: toggle(tab) sets its own tab afterwards, so an explicit History or Downloads still wins.
                if (restoreTab && this._lastTab === SECTION_ID) lib.activeTab = SECTION_ID;
                lib.requestUpdate();
            }
            this._watchLabel(lib);
        },

        _watchLabel(lib) {
            if (this._labelWatch.has(lib)) {
                this._fixLabel(lib);
                return;
            }
            const observer = new MutationObserver(() => {
                const tabs = lib.querySelector("#zen-library-sidebar-tabs");
                if (tabs && observer._root !== tabs) {
                    observer.disconnect();
                    observer._root = tabs;
                    observer.observe(tabs, {
                        subtree: true,
                        childList: true,
                        characterData: true,
                        attributes: true,
                        attributeFilter: ["data-l10n-id"]
                    });
                }
                this._fixLabel(lib);
            });
            const tabs = lib.querySelector("#zen-library-sidebar-tabs");
            observer._root = tabs || lib;
            observer.observe(observer._root, {
                subtree: true,
                childList: true,
                characterData: !!tabs,
                attributes: true,
                attributeFilter: ["data-l10n-id"]
            });
            this._labelWatch.set(lib, observer);
            this._observers.add(observer);
            this._fixLabel(lib);
        },

        _fixLabel(lib) {
            const label = lib.querySelector(`.zen-library-tab[data-section="${SECTION_ID}"] label`);
            if (!label) return;
            if (label.hasAttribute("data-l10n-id")) label.removeAttribute("data-l10n-id");
            const text = merged() ? "Easels & Notes" : "Easels";
            if (label.textContent !== text) label.textContent = text;
        },

        connect(section) {
            if (section._chromeObserver) {
                this.load(section);
                return;
            }
            const observer = new MutationObserver(() => this.fixSection(section));
            observer.observe(section, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["data-l10n-id", "placeholder"]
            });
            section._chromeObserver = observer;
            this._observers.add(observer);
            this.load(section);
            this.fixSection(section);
        },

        disconnect(section) {
            if (section._loadTimer) {
                clearTimeout(section._loadTimer);
                section._loadTimer = null;
            }
            section._boardGen = (section._boardGen || 0) + 1;
            section._chromeObserver?.disconnect();
            if (section._chromeObserver) this._observers.delete(section._chromeObserver);
            section._chromeObserver = null;
            section._boards = null;
        },

        pause(section) {
            if (section._loadTimer) {
                clearTimeout(section._loadTimer);
                section._loadTimer = null;
            }
        },

        fixSection(section) {
            const input = section.querySelector(".zen-library-search-box input");
            if (!input) return;
            if (input.hasAttribute("data-l10n-id")) input.removeAttribute("data-l10n-id");
            const text = merged() ? "Search Easels & Notes…" : "Search easels";
            if (input.getAttribute("placeholder") !== text) {
                input.setAttribute("placeholder", text);
            }
        },

        // onShown and onLibraryOpening land in the same turn when the panel
        // opens on this tab. One load is enough.
        load(section) {
            if (section._loadTimer) return;
            section._loadTimer = setTimeout(() => {
                section._loadTimer = null;
                if (section.isConnected && !section.hidden) this._loadNow(section);
            }, 0);
        },

        async _loadNow(section) {
            const gen = (section._boardGen || 0) + 1;
            section._boardGen = gen;
            try {
                const { EaselStore } = ChromeUtils.importESModule(STORE);
                window.gZenEaselHost?._useContainer?.();
                const boards = await EaselStore.listEasels();
                if (section._boardGen !== gen || !section.isConnected) return;
                section._boards = boards;
            } catch (e) {
                console.error("[zen-easel] could not list easels:", e);
                if (section._boardGen !== gen) return;
                section._boards = [];
            }
            section.requestUpdate();
        },

        renderItems(section) {
            const { html, repeat } = this._lit;
            const query = (section.searchQuery || "").trim().toLowerCase();
            const notes = hub.providers.get("notes");
            const boards = section._boards;
            const shown = Array.isArray(boards)
                ? boards.filter(board => !query || (board.title || "").toLowerCase().includes(query))
                : null;

            window.__zlSchemeWatch?.apply();
            const entries = [], folders = new Map(); // folders: subfolder name -> note entries
            for (const board of shown || []) {
                const entry = { key: `easel:${board.id}`, updatedAt: board.updatedAt || 0, tpl: n => this._card(html, board, n) };
                if (board.folder) { if (!folders.has(board.folder)) folders.set(board.folder, []); folders.get(board.folder).push(entry); }
                else entries.push(entry);
            }
            if (notes) {
                try {
                    for (const item of notes.items(query)) {
                        const entry = { key: item.key, updatedAt: item.updatedAt || 0, tpl: n => { const c = item.node.querySelector?.(".zn-note-count"); if (c) c.textContent = String(n); return html`${item.node}`; } };
                        if (item.folder) { if (!folders.has(item.folder)) folders.set(item.folder, []); folders.get(item.folder).push(entry); }
                        else entries.push(entry);
                    }
                } catch (e) { console.error("[zen-easel] could not list notes:", e); }
            }
            entries.sort((a, b) => b.updatedAt - a.updatedAt);
            // Main folder first, then each subfolder alphabetically with its own heading, line and numbering.
            const folderBlocks = [...folders].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base", numeric: true }))
                .map(([name, list]) => html`
                    <div class="zl-folder-block">
                        <div class="zl-folder-head"><span>${name}</span>
                            <button class="zl-folder-new" type="button" title=${`New in ${name}`}
                                @click=${event => { event.stopPropagation(); this.create(event.currentTarget, name); }}>New</button></div>
                        <div class="easel-card-grid">
                            ${repeat(list.sort((a, b) => b.updatedAt - a.updatedAt), entry => entry.key, (entry, i) => entry.tpl(list.length - i))}
                        </div>
                    </div>`);

            const noun = notes ? "easels or notes" : "easels";
            const empty = shown == null
                ? html`<div class="zen-library-empty">Loading…</div>`
                : entries.length || folders.size
                    ? null
                    : html`
                        <div class="zen-library-empty easel-card-empty">
                            <div>${query ? `No ${noun} match` : `No ${noun} yet`}</div>
                            <div class="easel-card-empty-note">
                                ${query ? "Try a different search." : notes ? "Use the + card to start one." : "Press Ctrl+Alt+E to start one."}
                            </div>
                        </div>
                    `;
            const footer = notes?.footer?.() ?? null;
            if (footer) setTimeout(() => notes.place?.(), 60);

            return html`
                <div class="easel-card-grid">
                    <button class="easel-card easel-card-new" type="button"
                        title=${notes ? "New Easel/Note" : "New easel"} ?data-merged=${!!notes}
                        @click=${event => window.ZenEaselLibrarySection?.create(event.currentTarget)}></button>
                    ${entries.length
                        ? repeat(entries, entry => entry.key, (entry, i) => entry.tpl(entries.length - i))
                        : empty}
                </div>
                ${folderBlocks}
                ${footer}
            `;
        },

        // The tile takes on the board's own background: the card body, its text and the accent follow it.
        _bgStyle(key) {
            const PRESETS = { arc: "#FAFAFC", white: "#FFFFFF", paper: "#F6F2E9", mist: "#E9EDF1", slate: "#2A2E35", ink: "#161B2E", black: "#0B0B0C" };
            let hex, alpha = 1;
            const custom = /^custom:(#[0-9a-f]{6}):([01](?:\.\d{1,2})?)$/i.exec(key || "");
            if (custom) { hex = custom[1]; alpha = parseFloat(custom[2]); if (alpha < 0.2) return ""; }
            else hex = PRESETS[key];
            if (!hex) return ""; // "theme" and "transparent" keep the default card
            alpha = Math.max(alpha, 0.6);
            const dark = document.documentElement.getAttribute("data-zl-scheme") === "dark";
            const base = dark ? [42, 42, 42] : [232, 232, 232];
            const rgb = [1, 3, 5].map((i, n) => Math.round(base[n] * (1 - alpha) + parseInt(hex.slice(i, i + 2), 16) * alpha));
            const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 140;
            const toward = light ? 0 : 255;
            const hover = rgb.map(v => Math.round(v * 0.92 + toward * 0.08));
            return `--zl-body: rgb(${rgb}); --zl-body-hover: rgb(${hover}); --zl-ink: ${light ? "#111111" : "#ffffff"}; --zl-mix: ${light ? "#000000" : "#ffffff"};`;
        },

        _tooltip(board) {
            if (!board.createdAt) return board.title || "Untitled Easel";
            return "Created " + new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(board.createdAt));
        },

        _card(html, board, count) {
            const open = event => window.ZenEaselLibrarySection?.open(board, event);
            const title = board.title || "Untitled Easel";
            // By code point, so an emoji at the cut is not split into a lone surrogate.
            const chars = [...title];
            const short = chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : title;
            const renaming = this._renamingId === board.id;
            const icon = board.icon;
            const safeSrc = icon?.src ? String(icon.src).replace(/["\\]/g, "") : "";
            const mark = icon?.emoji
                ? html`<div class="easel-card-mark is-emoji"><span class="easel-card-emoji">${icon.emoji}</span></div>`
                : icon?.src
                    ? html`<div class="easel-card-mark"><span class=${icon.plain ? "easel-card-icon is-plain" : "easel-card-icon"} style=${icon.plain ? `background-image:url("${safeSrc}")` : `-webkit-mask-image:url("${safeSrc}");mask-image:url("${safeSrc}")`}></span></div>`
                    : html`
                <div class="easel-card-mark">
                    <svg class="easel-card-squiggle" viewBox="20 38 76 68" fill="none" aria-hidden="true">
                        <path d="M 79.08 42.08 C 91.19 54.79 88.45 58.62 81.98 56.04 C 75.51 53.47 66.12 44.54 59.62 47.55 C 53.12 50.56 91.47 84.24 77.76 86.61 C 72.57 87.51 43.87 53.27 34.03 56.04 C 23.75 58.94 58.53 84.24 60.64 100.31" stroke="currentColor" stroke-width="7.1" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                </div>`;
            const style = this._bgStyle(this._liveBg.get(board.id) ?? board.background);
            if (renaming) {
                // Not a <button> while renaming: a text field inside a button cannot take focus or spaces.
                return html`
                    <div class="easel-card" role="group" title=${this._tooltip(board)}>
                        <div class="easel-card-frame">
                            <div class="easel-card-body" style=${style}>
                                <div class="easel-card-count">${count}</div>
                                <div class="easel-card-copy">
                                    ${mark}
                                    <input class="easel-card-rename" type="text" .value=${title} spellcheck="false"
                                        @click=${event => event.stopPropagation()}
                                        @input=${event => window.gZenEaselHost?.previewRename?.(board.id, event.target.value)}
                                        @keydown=${event => {
                                            event.stopPropagation();
                                            if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); this._finishRename(board, event.target.value); }
                                            else if (event.key === "Escape") { event.preventDefault(); this._finishRename(board, null); }
                                        }}
                                        @blur=${event => this._finishRename(board, event.target.value)}>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
            return html`
                <button class="easel-card" type="button" title=${this._tooltip(board)}
                    @click=${event => { if (event.button === 0) open(event); }}
                    @auxclick=${event => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        open(event);
                    }}
                    @contextmenu=${event => window.ZenEaselLibrarySection?.menu(board, event)}>
                    <div class="easel-card-frame">
                        <div class="easel-card-body" style=${style}>
                            <div class="easel-card-count">${count}</div>
                            <div class="easel-card-copy">
                                ${mark}
                                <div class="easel-card-title">${short}</div>
                            </div>
                        </div>
                    </div>
                </button>
            `;
        },

        open(board, event) {
            const host = window.gZenEaselHost;
            const section = document.querySelector("zen-library-easels-section");
            if (!host || !board) return;
            if (inBackground(event) && section?.library?.keepOpenWhile) {
                section.library.keepOpenWhile(() => host.openEasel(board.id, { inBackground: true }));
                return;
            }
            host.openEasel(board.id);
            this._closeLibrary(section);
        },

        // With Notes installed the + card asks which one to make; alone it makes an easel.
        // `folder`: a library subfolder to create the new easel or note in.
        create(anchor, folder = "") {
            const notes = hub.providers.get("notes");
            if (!notes || !anchor) { this._createEasel(folder); return; }
            const popup = document.createXULElement("menupopup");
            const add = (label, command) => {
                const item = document.createXULElement("menuitem");
                item.setAttribute("label", label);
                item.addEventListener("command", command, { once: true });
                popup.appendChild(item);
            };
            add("New Easel", () => this._createEasel(folder));
            add("New Note", () => notes.create(folder).catch(e => console.error("[zen-easel] could not create note:", e)));
            popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
            document.getElementById("mainPopupSet")?.appendChild(popup);
            popup.openPopup(anchor, "after_start");
        },

        // No name prompt: the new board opens with its heading already selected, so typing names it.
        _createEasel(folder = "") {
            window.gZenEaselHost?.createEasel("Untitled Easel", folder)
                .then(() => this._closeLibrary(document.querySelector("zen-library-easels-section")))
                .catch(e => console.error("[zen-easel] could not create easel:", e));
        },

        menu(board, event) {
            event.preventDefault();
            event.stopPropagation();
            const popup = document.createXULElement("menupopup");
            const add = (label, command) => {
                const item = document.createXULElement("menuitem");
                item.setAttribute("label", label);
                item.addEventListener("command", command, { once: true });
                popup.appendChild(item);
            };
            add("Open Easel", () => this.open(board, null));
            add("Rename Easel…", () => this.rename(board));
            add("Duplicate Easel", () => this.duplicate(board));
            if (board.icon) add("Reset Icon", () => window.gZenEaselHost?.setBoardIcon(board.id, null));
            popup.appendChild(document.createXULElement("menuseparator"));
            add("Delete Easel", () => this.remove(board));
            popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
            document.getElementById("mainPopupSet")?.appendChild(popup);
            popup.openPopupAtScreen(event.screenX, event.screenY, true);
        },

        // Renames in place on the tile, like a note. Falls back to a prompt if the library is not on screen.
        rename(board) {
            const section = document.querySelector("zen-library-easels-section");
            if (!section?.isConnected) {
                let title;
                try { title = promptText("Rename easel", "New name:", board.title || "Untitled Easel"); }
                catch (e) { console.error("[zen-easel] could not ask for an easel name:", e); return; }
                this._finishRename(board, title, true);
                return;
            }
            this._renamingId = board.id;
            section.requestUpdate();
            Promise.resolve(section.updateComplete).then(() => {
                const input = section.querySelector(".easel-card-rename");
                input?.focus();
                input?.select();
            });
        },

        _finishRename(board, value, force = false) {
            if (!force && this._renamingId !== board.id) return; // already finished (Enter then blur)
            this._renamingId = null;
            const trimmed = value == null ? "" : String(value).trim();
            document.querySelector("zen-library-easels-section")?.requestUpdate();
            const commit = !!trimmed && trimmed !== board.title;
            // Cancelled, empty or unchanged: an open copy goes back to its name. Otherwise the rename below settles it.
            window.gZenEaselHost?.previewRename?.(board.id, commit ? undefined : null);
            if (!commit) return;
            window.gZenEaselHost?.renameBoard(board.id, trimmed)
                .then(() => this._reloadOpen())
                .catch(e => console.error("[zen-easel] could not rename easel:", e));
        },

        // The copy opens straight away, like a duplicated note.
        duplicate(board) {
            window.gZenEaselHost?.duplicateBoard(board.id)
                .then(entry => {
                    this._reloadOpen();
                    if (!entry) return;
                    window.gZenEaselHost.openEasel(entry.id);
                    this._closeLibrary(document.querySelector("zen-library-easels-section"));
                })
                .catch(e => console.error("[zen-easel] could not duplicate easel:", e));
        },

        remove(board) {
            let confirmed = false;
            try {
                confirmed = Services.prompt.confirm(
                    window,
                    "Delete easel",
                    `Delete "${board.title || "Untitled Easel"}" and everything on it? This cannot be undone.`
                );
            } catch (e) {
                console.error("[zen-easel] could not confirm delete:", e);
                return;
            }
            if (!confirmed) return;
            window.gZenEaselHost?.deleteBoard(board.id)
                .then(() => this._reloadOpen())
                .catch(e => console.error("[zen-easel] could not delete easel:", e));
        },

        _reloadOpen() {
            const section = document.querySelector("zen-library-easels-section");
            if (section?.isConnected) this.load(section);
        }
    };

    window.ZenEaselLibrarySection = ZenEaselLibrarySection;
})();
