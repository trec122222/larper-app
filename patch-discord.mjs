import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { pipeline } from "stream/promises";

const GITHUB_USER = "trec122222";
const GITHUB_REPO = "larper-app";
const GITHUB_BRANCH = "main";

const MANIFEST_MIRRORS = [
    `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}`,
    `https://cdn.jsdelivr.net/gh/${GITHUB_USER}/${GITHUB_REPO}@${GITHUB_BRANCH}`,
];

function argValue(flag, fallback = "") {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const branch = (argValue("--branch", process.env.DISCORD_BRANCH || "stable") || "stable").toLowerCase();
const branchFolder = { stable: "Discord", ptb: "DiscordPTB", canary: "DiscordCanary", auto: "Discord" }[branch] || "Discord";

const venCordDir = path.resolve(argValue("--vencord", process.env.VENCORD_DIR || path.join(localAppData, "Vencord-larper")));
const discordRoot = path.resolve(argValue("--discord", process.env.DISCORD_LOCATION || path.join(localAppData, branchFolder)));
const distDir = path.join(venCordDir, "dist");
const patcherJs = path.join(distDir, "patcher.js");
const versionFile = path.join(venCordDir, ".version");

function fail(msg) { console.error("\n[ERROR]", msg); process.exit(1); }
function ok(msg) { console.log("[OK]", msg); }
function step(msg) { console.log("[..]", msg); }
function warn(msg) { console.log("[WARN]", msg); }

function httpGet(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error("too many redirects"));
        const req = https.get(url, { headers: { "User-Agent": "Larper-Installer/1.0" } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return httpGet(res.headers.location, redirects + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            resolve(res);
        });
        req.on("error", reject);
        req.setTimeout(30000, () => req.destroy(new Error("timeout after 30s")));
    });
}

async function fetchJson(url) {
    const res = await httpGet(url);
    let buf = Buffer.alloc(0);
    for await (const chunk of res) buf = Buffer.concat([buf, chunk]);
    return JSON.parse(buf.toString("utf8"));
}

async function downloadTo(url, destFile) {
    const res = await httpGet(url);
    const tmp = destFile + ".part";
    await pipeline(res, fs.createWriteStream(tmp));
    fs.renameSync(tmp, destFile);
}

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function unzip(zipFile, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    if (process.platform === "win32") {
        const r = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`], { stdio: "inherit" });
        if (r.status !== 0) fail("Unzip failed");
    } else {
        const r = spawnSync("unzip", ["-o", zipFile, "-d", destDir], { stdio: "inherit" });
        if (r.status !== 0) fail("Unzip failed");
    }
}

function semverGt(a, b) {
    const pa = String(a).replace(/^v/, "").split(".").map(Number);
    const pb = String(b).replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

function readInstalledVersion() {
    try { return JSON.parse(fs.readFileSync(versionFile, "utf8")); }
    catch { return null; }
}

async function fetchLatestManifest() {
    const path = `/latest.json?v=${Math.floor(Date.now() / 60000)}`;
    let lastErr;
    for (const base of MANIFEST_MIRRORS) {
        const url = base + path;
        try {
            step(`fetching manifest: ${url}`);
            const manifest = await fetchJson(url);
            if (!manifest.version || !manifest.url || !manifest.sha256) throw new Error("manifest missing fields");
            return manifest;
        } catch (e) {
            warn(`mirror failed: ${e.message}`);
            lastErr = e;
        }
    }
    fail(`Cannot reach update server.\n         Last error: ${lastErr?.message}`);
}

async function ensureLatestBuild(force = false) {
    const manifest = await fetchLatestManifest();
    const installed = readInstalledVersion();

    if (!force && manifest.minVersion && installed && semverGt(manifest.minVersion, installed.version)) {
        fail(`Bản cũ đã bị vô hiệu hoá. Chạy lại: node patch-discord.mjs`);
    }

    if (!force && installed && installed.version === manifest.version && fs.existsSync(patcherJs)) {
        ok(`Using cached build ${installed.version}`);
        return { manifest, installed, downloaded: false };
    }

    const sizeKb = Math.round((manifest.size || 0) / 1024);
    step(`downloading build ${manifest.version}${sizeKb ? ` (~${sizeKb} KB)` : ""}...`);
    fs.mkdirSync(venCordDir, { recursive: true });
    const zipFile = path.join(venCordDir, `.download-${manifest.version}.zip`);
    try {
        await downloadTo(manifest.url, zipFile);
    } catch (e) {
        fail(`Download failed: ${e.message}`);
    }

    step("verifying SHA256...");
    const actual = sha256File(zipFile);
    if (actual !== manifest.sha256.toLowerCase()) {
        try { fs.unlinkSync(zipFile); } catch {}
        fail(`Hash mismatch.\n         expected: ${manifest.sha256}\n         actual:   ${actual}`);
    }
    ok("hash verified");

    if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
    step("extracting...");
    unzip(zipFile, venCordDir);
    try { fs.unlinkSync(zipFile); } catch {}

    if (!fs.existsSync(patcherJs)) fail("Build extracted but dist/patcher.js missing.");

    fs.writeFileSync(versionFile, JSON.stringify({ version: manifest.version, installedAt: Date.now(), sha256: manifest.sha256 }, null, 2));
    ok(`installed build ${manifest.version}`);
    return { manifest, installed: { version: manifest.version }, downloaded: true };
}

function killDiscord() {
    if (process.env.KEEP_DISCORD_OPEN === "1") return;
    step("closing Discord...");
    for (const name of ["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "Update.exe"]) {
        spawnSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore", windowsHide: true });
    }
    const end = Date.now() + 2500;
    while (Date.now() < end) {}
}

function findResourcesDir(root) {
    if (!fs.existsSync(root)) fail(`Discord folder not found: ${root}`);
    if (fs.existsSync(path.join(root, "app.asar")) || fs.existsSync(path.join(root, "_app.asar"))) return root;
    const directResources = path.join(root, "resources");
    if (fs.existsSync(path.join(directResources, "app.asar")) || fs.existsSync(path.join(directResources, "_app.asar"))) return directResources;
    const apps = fs.readdirSync(root).filter(n => n.startsWith("app-")).map(n => ({ name: n, full: path.join(root, n, "resources") })).filter(x => fs.existsSync(x.full)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    if (!apps.length) fail(`No Discord app-*\\resources found under ${root}`);
    return apps[0].full;
}

function writeStubAsar(outFile, patcherPath) {
    const packageJson = '{\n  "name": "discord",\n  "main": "index.js"\n}';
    const indexJs = `require(${JSON.stringify(patcherPath)})`;
    const files = {};
    let contents = Buffer.alloc(0);
    for (const [name, text] of [["index.js", indexJs], ["package.json", packageJson]]) {
        const data = Buffer.from(text, "utf8");
        files[name] = { size: data.length, offset: String(contents.length) };
        contents = Buffer.concat([contents, data]);
    }
    let header = Buffer.from(JSON.stringify({ files }), "utf8");
    const headerStringSize = header.length;
    const dataSize = 4;
    const alignedSize = (headerStringSize + dataSize - 1) & ~(dataSize - 1);
    const headerSize = alignedSize + 8;
    const headerObjectSize = alignedSize + dataSize;
    const diff = alignedSize - headerStringSize;
    if (diff > 0) header = Buffer.concat([header, Buffer.alloc(diff, 0x30)]);

    const fd = fs.openSync(outFile, "w");
    try {
        const u32 = Buffer.alloc(4);
        for (const n of [dataSize, headerSize, headerObjectSize, headerStringSize]) {
            u32.writeUInt32LE(n, 0);
            fs.writeSync(fd, u32);
        }
        fs.writeSync(fd, header);
        fs.writeSync(fd, contents);
    } finally { fs.closeSync(fd); }
}

function isPatched(resourcesDir) {
    const backup = path.join(resourcesDir, "_app.asar");
    const stub = path.join(resourcesDir, "app.asar");
    if (!fs.existsSync(backup) || !fs.existsSync(stub)) return false;
    try {
        const buf = fs.readFileSync(stub);
        return buf.includes(Buffer.from("patcher.js")) && buf.length < 4096;
    } catch { return false; }
}

function patch(resourcesDir) {
    const appAsar = path.join(resourcesDir, "app.asar");
    const backup = path.join(resourcesDir, "_app.asar");
    const appDir = path.join(resourcesDir, "app");
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    if (!fs.existsSync(backup)) {
        if (!fs.existsSync(appAsar)) fail(`Missing app.asar in ${resourcesDir}`);
        const size = fs.statSync(appAsar).size;
        if (size < 4096) fail(`Found tiny app.asar. Reinstall Discord, then retry.`);
        step(`backing up app.asar -> _app.asar`);
        fs.renameSync(appAsar, backup);
    } else {
        if (fs.existsSync(appAsar)) {
            try { fs.unlinkSync(appAsar); }
            catch (e) { fail(`Cannot replace app.asar: ${e.message}`); }
        }
    }
    step("writing stub app.asar");
    writeStubAsar(appAsar, patcherJs);
}

function verify(resourcesDir) {
    const backup = path.join(resourcesDir, "_app.asar");
    const stub = path.join(resourcesDir, "app.asar");
    if (!fs.existsSync(backup)) fail("Verify: _app.asar missing");
    if (!fs.existsSync(stub)) fail("Verify: app.asar missing");
    const buf = fs.readFileSync(stub);
    if (buf.length > 8192) fail(`Verify: stub too large (${buf.length})`);
    if (!buf.includes(Buffer.from("patcher.js"))) fail("Verify: stub missing patcher.js ref");
    ok("Discord patched");
}

(async () => {
    console.log("\n============================================================");
    console.log("  Larper — installer / updater");
    console.log("============================================================");
    console.log("  Repo:      ", `github.com/${GITHUB_USER}/${GITHUB_REPO}@${GITHUB_BRANCH}`);
    console.log("  Branch:    ", branch);
    console.log("  Discord:   ", discordRoot);
    console.log("  Install to:", venCordDir);
    console.log("============================================================\n");

    const checkOnly = hasFlag("--check");
    const force = hasFlag("--force");
    const result = await ensureLatestBuild(force);
    if (checkOnly) {
        ok(`Latest build: ${result.manifest.version}`);
        return;
    }

    killDiscord();
    const resourcesDir = findResourcesDir(discordRoot);
    console.log("[..] target resources:", resourcesDir);
    if (isPatched(resourcesDir)) step("already patched — refreshing stub");
    patch(resourcesDir);
    verify(resourcesDir);

    console.log("\n============================================================");
    console.log("  ✅ DONE");
    console.log("============================================================");
    console.log("  Next:");
    console.log("    1. Open Discord");
    console.log("    2. Settings → Vencord → Plugins → on \"Larper\"");
    console.log("    3. Ctrl+B open tool\n");
})().catch(e => { fail(e.message ?? String(e)); });