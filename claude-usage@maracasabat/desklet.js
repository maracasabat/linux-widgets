const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const Mainloop = imports.mainloop;
const ByteArray = imports.byteArray;

const UUID = "claude-usage@maracasabat";

// Конфігурація через середовище (пріоритет над налаштуваннями):
//   CLAUDE_OAUTH_TOKEN — токен напряму, без читання credentials.json
//   CLAUDE_CREDS_PATH  — власний шлях до credentials.json
//   CLAUDE_USAGE_URL   — власний ендпоінт API
// Джерела: змінні процесу Cinnamon або файл ~/.config/claude-usage-desklet/.env
const ENV_FILE = GLib.get_home_dir() + "/.config/claude-usage-desklet/.env";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_CREDS_PATH = "~/.claude/.credentials.json";

// Команда, яку десклет виконує на віддаленій машині в режимі SSH. Токен
// читається і запит до API робиться ПРЯМО ТАМ — назад повертається лише JSON
// із використанням. Сам токен ніколи не залишає віддалену машину.
const DEFAULT_REMOTE_CMD =
    "python3 -c \"import json,os,sys,urllib.request as u; " +
    "d=json.load(open(os.path.expanduser('~/.claude/.credentials.json'))); " +
    "t=d['claudeAiOauth']['accessToken']; " +
    "sys.stdout.write(u.urlopen(u.Request('https://api.anthropic.com/api/oauth/usage', " +
    "headers={'Authorization':'Bearer '+t,'anthropic-beta':'oauth-2025-04-20'," +
    "'Content-Type':'application/json'}), timeout=15).read().decode())\"";
const SSH_TIMEOUT_SEC = 30;

function main(metadata, deskletId) {
    return new ClaudeUsageDesklet(metadata, deskletId);
}

function ClaudeUsageDesklet(metadata, deskletId) {
    this._init(metadata, deskletId);
}

ClaudeUsageDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function(metadata, deskletId) {
        Desklet.Desklet.prototype._init.call(this, metadata, deskletId);
        this.setHeader("Claude — ліміти");

        this.settings = new Settings.DeskletSettings(this, UUID, deskletId);
        // Три категорії реакції: перезапуск таймера, повторний запит даних
        // (джерело змінилось), просто перемалювати (вигляд/кольори).
        const bindTimer = (key, prop) => this.settings.bind(key, prop, () => this._onTimerSettingChanged());
        const bindSource = (key, prop) => this.settings.bind(key, prop, () => this._onSourceSettingChanged());
        const bindDisplay = (key, prop) => this.settings.bind(key, prop, () => this._render());
        // Загальні
        bindTimer("refresh-minutes", "refreshMinutes");
        // Джерело даних
        bindSource("source-mode", "sourceMode");
        bindSource("ssh-target", "sshTarget");
        bindSource("remote-command", "remoteCommand");
        bindSource("creds-path", "credsPath");
        // Вигляд
        bindDisplay("bar-width", "barWidth");
        bindDisplay("font-size", "fontSize");
        bindDisplay("bar-height", "barHeight");
        bindDisplay("border-radius", "borderRadius");
        bindDisplay("show-header", "showHeader");
        bindDisplay("show-updated", "showUpdated");
        bindDisplay("show-reset", "showReset");
        bindDisplay("bg-color", "bgColor");
        bindDisplay("bg-opacity", "bgOpacity");
        // Кольори
        bindDisplay("title-color", "titleColor");
        bindDisplay("text-color", "textColor");
        bindDisplay("color-ok", "colorOk");
        bindDisplay("color-warn", "colorWarn");
        bindDisplay("color-crit", "colorCrit");
        bindDisplay("warn-threshold", "warnThreshold");
        bindDisplay("crit-threshold", "critThreshold");

        this._http = (Soup.MAJOR_VERSION === 2) ? new Soup.SessionAsync() : new Soup.Session();
        this._http.timeout = 15;
        this._http.user_agent = "claude-usage-desklet/1.2";

        this._timerId = 0;
        this._settingsReloadId = 0;
        this._settingsMonitor = null;
        this._sshProc = null;
        this._sshKillId = 0;
        this._limits = null;
        this._lastUpdated = null;
        this._error = null;
        this._removed = false;
        this._envFile = {};

        this._box = new St.BoxLayout({ vertical: true });
        this.setContent(this._box);

        // Клік по віджету — оновити негайно
        this.actor.connect("button-press-event", () => {
            this._refresh();
            return false;
        });

        this._watchSettingsFile();
        this._render();
        this._refresh();
        this._startTimer();
    },

    on_desklet_removed: function() {
        this._removed = true;
        this._stopTimer();
        if (this._settingsReloadId) {
            Mainloop.source_remove(this._settingsReloadId);
            this._settingsReloadId = 0;
        }
        if (this._settingsMonitor) {
            this._settingsMonitor.cancel();
            this._settingsMonitor = null;
        }
        this._cleanupSsh();
        if (this._http && this._http.abort)
            this._http.abort();
        if (this.settings)
            this.settings.finalize();
    },

    _onTimerSettingChanged: function() {
        this._startTimer();
    },

    _onSourceSettingChanged: function() {
        this._render();
        this._refresh();
    },

    // Cinnamon доставляє зміни налаштувань через DBus, але його діалог іноді
    // губить це сповіщення (запис у файл є, а працюючий десклет лишається
    // зі старими значеннями до перезавантаження). Стежимо за файлом самі й
    // застосовуємо зміни надійно.
    _watchSettingsFile: function() {
        if (!this.settings || !this.settings.file)
            return;
        try {
            this._settingsMonitor = this.settings.file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._settingsMonitor.connect("changed", (mon, file, other, event) => {
                if (this._removed) return;
                // Реагуємо лише після завершення запису, з дебаунсом.
                if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT
                    && event !== Gio.FileMonitorEvent.CREATED)
                    return;
                if (this._settingsReloadId)
                    Mainloop.source_remove(this._settingsReloadId);
                this._settingsReloadId = Mainloop.timeout_add(250, () => {
                    this._settingsReloadId = 0;
                    if (this._removed) return false;
                    try {
                        this.settings._checkSettings();
                    } catch (e) {
                        global.logWarning("[" + UUID + "] settings reload failed: " + e);
                    }
                    return false;
                });
            });
        } catch (e) {
            global.logWarning("[" + UUID + "] cannot watch settings file: " + e);
        }
    },

    _startTimer: function() {
        this._stopTimer();
        const sec = Math.max(60, (this.refreshMinutes || 5) * 60);
        this._timerId = Mainloop.timeout_add_seconds(sec, () => {
            this._refresh();
            return true;
        });
    },

    _stopTimer: function() {
        if (this._timerId) {
            Mainloop.source_remove(this._timerId);
            this._timerId = 0;
        }
    },

    // ---- Конфігурація та авторизація ------------------------------------

    _expandPath: function(p) {
        return p.startsWith("~") ? GLib.get_home_dir() + p.slice(1) : p;
    },

    _readEnvFile: function() {
        let ok, bytes;
        try {
            [ok, bytes] = GLib.file_get_contents(ENV_FILE);
        } catch (e) {
            return {};
        }
        if (!ok) return {};
        const out = {};
        for (const line of ByteArray.toString(bytes).split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const i = t.indexOf("=");
            if (i < 1) continue;
            let v = t.slice(i + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
                v = v.slice(1, -1);
            out[t.slice(0, i).trim()] = v;
        }
        return out;
    },

    _envLookup: function(name) {
        return GLib.getenv(name) || this._envFile[name] || null;
    },

    _usageUrl: function() {
        return this._envLookup("CLAUDE_USAGE_URL") || DEFAULT_USAGE_URL;
    },

    _resolveAuth: function() {
        this._envFile = this._readEnvFile();

        const direct = this._envLookup("CLAUDE_OAUTH_TOKEN");
        if (direct)
            return { token: direct, expiresAt: 0 };

        const rawPath = this._envLookup("CLAUDE_CREDS_PATH")
            || (this.credsPath && this.credsPath.trim())
            || DEFAULT_CREDS_PATH;
        const path = this._expandPath(rawPath);

        let ok, bytes;
        try {
            [ok, bytes] = GLib.file_get_contents(path);
        } catch (e) {
            return { error: "Не знайдено " + path };
        }
        if (!ok)
            return { error: "Не вдалося прочитати " + path };
        let data;
        try {
            data = JSON.parse(ByteArray.toString(bytes));
        } catch (e) {
            return { error: "Пошкоджений JSON: " + path };
        }
        const oauth = data.claudeAiOauth;
        if (!oauth || !oauth.accessToken)
            return { error: "Немає OAuth-токена. Увійдіть у Claude Code." };
        return { token: oauth.accessToken, expiresAt: oauth.expiresAt || 0 };
    },

    // ---- Запит до API ----------------------------------------------------

    _refresh: function() {
        if ((this.sourceMode || "local") === "ssh")
            this._refreshViaSsh();
        else
            this._refreshLocal();
    },

    // Режим SSH: увесь запит (читання токена + виклик API) виконується на
    // віддаленій машині. Назад приходить лише JSON — токен не залишає сервер.
    _cleanupSsh: function() {
        if (this._sshKillId) {
            Mainloop.source_remove(this._sshKillId);
            this._sshKillId = 0;
        }
        if (this._sshProc) {
            try { this._sshProc.force_exit(); } catch (e) {}
            this._sshProc = null;
        }
    },

    _refreshViaSsh: function() {
        const target = (this.sshTarget || "").trim();
        if (!target) {
            this._error = "Вкажіть SSH-адресу (user@host) у налаштуваннях.";
            this._render();
            return;
        }
        const remoteCmd = (this.remoteCommand && this.remoteCommand.trim()) || DEFAULT_REMOTE_CMD;
        const argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, remoteCmd];

        this._cleanupSsh();
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._error = "Не вдалося запустити ssh: " + e.message;
            this._render();
            return;
        }
        this._sshProc = proc;
        // Захист від зависання: примусово вбити процес за таймаутом.
        this._sshKillId = Mainloop.timeout_add_seconds(SSH_TIMEOUT_SEC, () => {
            this._sshKillId = 0;
            if (this._sshProc) {
                try { this._sshProc.force_exit(); } catch (e) {}
            }
            return false;
        });

        proc.communicate_utf8_async(null, null, (p, res) => {
            if (this._sshKillId) {
                Mainloop.source_remove(this._sshKillId);
                this._sshKillId = 0;
            }
            this._sshProc = null;
            if (this._removed) return;

            let ok, stdout, stderr;
            try {
                [ok, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                this._error = "Помилка SSH: " + e.message;
                this._render();
                return;
            }
            if (p.get_exit_status() !== 0) {
                const tail = (stderr || "").trim().split("\n").filter(s => s.trim()).pop();
                this._error = "SSH: " + (tail || ("код " + p.get_exit_status()));
                this._render();
                return;
            }
            this._onResponse(stdout);
        });
    },

    _refreshLocal: function() {
        const auth = this._resolveAuth();
        if (auth.error) {
            this._error = auth.error;
            this._render();
            return;
        }
        if (auth.expiresAt && auth.expiresAt < Date.now()) {
            this._error = "Токен протермінувався. Запустіть Claude Code, щоб він оновився.";
            this._render();
            return;
        }

        const msg = Soup.Message.new("GET", this._usageUrl());
        msg.request_headers.append("Authorization", "Bearer " + auth.token);
        msg.request_headers.append("anthropic-beta", "oauth-2025-04-20");
        msg.request_headers.append("Content-Type", "application/json");

        if (Soup.MAJOR_VERSION === 2) {
            this._http.queue_message(msg, (session, m) => {
                if (this._removed) return;
                if (m.status_code === 200)
                    this._onResponse(m.response_body.data);
                else
                    this._onHttpError(m.status_code);
            });
        } else {
            this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                if (this._removed) return;
                let text = null;
                try {
                    const bytes = session.send_and_read_finish(res);
                    text = ByteArray.toString(bytes.get_data());
                } catch (e) {
                    this._error = "Помилка мережі: " + e.message;
                    this._render();
                    return;
                }
                if (msg.status_code === 200)
                    this._onResponse(text);
                else
                    this._onHttpError(msg.status_code);
            });
        }
    },

    _onHttpError: function(code) {
        if (code === 401)
            this._error = "Токен недійсний (401). Відкрийте Claude Code, щоб оновити його.";
        else if (code === 429)
            this._error = "Забагато запитів (429). Спробую пізніше.";
        else
            this._error = "Помилка API: HTTP " + code;
        this._render();
    },

    _onResponse: function(text) {
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            this._error = "Не вдалося розібрати відповідь API";
            this._render();
            return;
        }

        let limits = [];
        if (data.limits && data.limits.length) {
            limits = data.limits.filter(l => l && l.percent != null);
        } else {
            // Запасний варіант для старішого формату відповіді
            if (data.five_hour)
                limits.push({ kind: "session", percent: data.five_hour.utilization || 0, resets_at: data.five_hour.resets_at });
            if (data.seven_day)
                limits.push({ kind: "weekly_all", percent: data.seven_day.utilization || 0, resets_at: data.seven_day.resets_at });
        }
        if (data.extra_usage && data.extra_usage.is_enabled && data.extra_usage.utilization != null)
            limits.push({ kind: "extra", percent: data.extra_usage.utilization, resets_at: null });

        this._limits = limits;
        this._lastUpdated = new Date();
        this._error = null;
        this._render();
    },

    // ---- Відображення ----------------------------------------------------

    _labelFor: function(l) {
        if (l.kind === "session") return "Сесія (5 год)";
        if (l.kind === "weekly_all") return "Тиждень · всі моделі";
        if (l.kind === "weekly_scoped") {
            const name = l.scope && l.scope.model && l.scope.model.display_name;
            return "Тиждень · " + (name || "модель");
        }
        if (l.kind === "weekly_oauth_apps") return "Тиждень · застосунки";
        if (l.kind === "extra") return "Додаткове використання";
        return l.kind;
    },

    _colorFor: function(p) {
        const warn = (this.warnThreshold != null) ? this.warnThreshold : 60;
        const crit = (this.critThreshold != null) ? this.critThreshold : 85;
        if (p >= crit) return this.colorCrit || "rgb(229,72,77)";
        if (p >= warn) return this.colorWarn || "rgb(240,160,75)";
        return this.colorOk || "rgb(105,179,108)";
    },

    _withAlpha: function(color, alpha) {
        if (color) {
            const m = color.match(/rgba?\(([^)]+)\)/);
            if (m) {
                const p = m[1].split(",").map(s => s.trim());
                return "rgba(" + p[0] + "," + p[1] + "," + p[2] + "," + alpha + ")";
            }
            if (color[0] === "#" && color.length >= 7) {
                const r = parseInt(color.substr(1, 2), 16);
                const g = parseInt(color.substr(3, 2), 16);
                const b = parseInt(color.substr(5, 2), 16);
                return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
            }
        }
        return "rgba(30,28,26," + alpha + ")";
    },

    _fmtReset: function(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        let ms = d.getTime() - Date.now();
        if (ms < 0) ms = 0;
        const totalMin = Math.round(ms / 60000);
        const days = Math.floor(totalMin / 1440);
        const h = Math.floor((totalMin % 1440) / 60);
        const m = totalMin % 60;
        let rel;
        if (days > 0) rel = days + " д " + h + " год";
        else if (h > 0) rel = h + " год " + m + " хв";
        else rel = m + " хв";
        const two = n => (n < 10 ? "0" : "") + n;
        let when = two(d.getHours()) + ":" + two(d.getMinutes());
        const now = new Date();
        if (d.getDate() !== now.getDate() || d.getMonth() !== now.getMonth()) {
            const wd = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
            when = wd[d.getDay()] + " " + when;
        }
        return "скидання: " + when + " · через " + rel;
    },

    _makeBar: function(percent, color) {
        const w = this.barWidth || 260;
        const h = this.barHeight || 8;
        const r = Math.max(2, Math.round(h / 2));
        const textColor = this.textColor || "rgb(232,230,227)";
        const outer = new St.Bin({
            x_align: St.Align.START,
            style: "background-color: " + this._withAlpha(textColor, 0.15) + "; border-radius: " + r + "px;"
        });
        outer.set_width(w);
        outer.set_height(h);
        const p = Math.max(0, Math.min(100, percent));
        const fw = Math.round(w * p / 100);
        if (fw > 0) {
            const inner = new St.Bin({ style: "background-color: " + color + "; border-radius: " + r + "px;" });
            inner.set_width(Math.max(fw, r * 2));
            inner.set_height(h);
            outer.set_child(inner);
        }
        return outer;
    },

    _addWrappedLabel: function(box, text, style) {
        const label = new St.Label({ text: text, style: style });
        label.clutter_text.line_wrap = true;
        label.set_width(this.barWidth || 260);
        box.add_actor(label);
    },

    _render: function() {
        this._box.destroy_all_children();

        const base = this.fontSize || 10;
        const fontTitle = (base * 1.15).toFixed(1);
        const fontRow = base.toFixed(1);
        const fontSmall = (base * 0.8).toFixed(1);
        const textColor = this.textColor || "rgb(232,230,227)";
        const dimColor = this._withAlpha(textColor, 0.55);
        const op = (this.bgOpacity != null) ? this.bgOpacity : 0.85;
        const radius = (this.borderRadius != null) ? this.borderRadius : 14;

        this._box.set_style(
            "background-color: " + this._withAlpha(this.bgColor, op) + ";" +
            "border-radius: " + radius + "px;" +
            "border: 1px solid " + this._withAlpha(textColor, 0.09) + ";" +
            "padding: 14px 16px;" +
            "spacing: 12px;"
        );

        // Заголовок: назва + час останнього оновлення
        if (this.showHeader !== false) {
            const header = new St.BoxLayout();
            const title = new St.Label({
                text: "✳ Claude",
                style: "font-size: " + fontTitle + "pt; font-weight: bold; color: " + (this.titleColor || "rgb(217,119,87)") + ";"
            });
            header.add(title, { expand: true, x_fill: false, x_align: St.Align.START });
            if (this._lastUpdated && this.showUpdated !== false) {
                const two = n => (n < 10 ? "0" : "") + n;
                const t = this._lastUpdated;
                header.add(new St.Label({
                    text: two(t.getHours()) + ":" + two(t.getMinutes()),
                    style: "font-size: " + fontSmall + "pt; color: " + dimColor + ";"
                }), { x_align: St.Align.END });
            }
            this._box.add_actor(header);
        }

        if (!this._limits && !this._error) {
            this._addWrappedLabel(this._box, "Завантаження…", "font-size: " + fontRow + "pt; color: " + dimColor + ";");
            return;
        }

        if (this._limits) {
            for (const l of this._limits) {
                const row = new St.BoxLayout({ vertical: true, style: "spacing: 3px;" });

                const top = new St.BoxLayout();
                const name = new St.Label({
                    text: this._labelFor(l),
                    style: "font-size: " + fontRow + "pt; color: " + textColor + ";"
                });
                const pct = new St.Label({
                    text: Math.round(l.percent) + "%",
                    style: "font-size: " + fontRow + "pt; font-weight: bold; color: " + this._colorFor(l.percent) + ";"
                });
                top.add(name, { expand: true, x_fill: false, x_align: St.Align.START });
                top.add(pct, { x_align: St.Align.END });
                row.add_actor(top);

                row.add_actor(this._makeBar(l.percent, this._colorFor(l.percent)));

                if (this.showReset !== false) {
                    const resetText = this._fmtReset(l.resets_at);
                    if (resetText) {
                        row.add_actor(new St.Label({
                            text: resetText,
                            style: "font-size: " + fontSmall + "pt; color: " + dimColor + ";"
                        }));
                    }
                }
                this._box.add_actor(row);
            }
        }

        if (this._error) {
            this._addWrappedLabel(this._box, "⚠ " + this._error,
                "font-size: " + fontSmall + "pt; color: " + (this.colorWarn || "rgb(240,160,75)") + ";");
        }
    }
};
