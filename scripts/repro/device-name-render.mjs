#!/usr/bin/env node
/**
 * Self-contained, no-argument demonstration of the rendering issue fixed in
 * src/components/playback/playerSelectionMenu.js.
 *
 * A session's device name is server-supplied data (it comes from the
 * `Device` field of the caller's Authorization header, stored by Jellyfin's
 * core server and returned verbatim by the `/Sessions` API -- it is not
 * something this client chooses or sanitizes on the way in). The target
 * picker shown when you first open the cast/"Play On" menu
 * (components/actionSheet/actionSheet.ts) already treats that field as
 * plain text. The follow-up dialog shown when you reopen the cast menu
 * while already connected to a remote target
 * (components/playback/playerSelectionMenu.js) did not, and built that
 * dialog's markup by string concatenation instead.
 *
 * This script never talks to a real Jellyfin server or network. It starts
 * a local HTTP server implementing just the handful of read-only endpoints
 * this client calls while signing in and opening the cast menu, seeds one
 * fake remote session whose device name is a short, inert HTML snippet,
 * and drives a real, visible browser through:
 *
 *   1. sign in
 *   2. open the cast menu       (the picker: the seeded name shows as plain
 *                                 text here -- this dialog is unaffected)
 *   3. select the seeded target (ordinary client-side state, no network)
 *   4. reopen the cast menu     (the dialog this fix changes)
 *
 * Before the fix, step 4 renders the seeded string as markup and a native
 * dialog box appears; after the fix, the same string displays as plain
 * text and no dialog appears. Either way the script finishes on its own.
 *
 * Usage:
 *   npm run repro:device-name-render
 *   (or: node scripts/repro/device-name-render.mjs)
 *
 * No arguments. No account. No existing server. The only interaction this
 * script asks of you is dismissing that dialog box if it appears -- click
 * OK to close it and let the script finish.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const PORT = 18096;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SERVER_ID = 'repro0000000000000000000000000000';
const USER_ID = 'repro-user-0000000000000000000000';
const USER_NAME = 'demo';
// Credential for the local fixture server started below, not a real account.
// eslint-disable-next-line sonarjs/no-hardcoded-passwords
const PASSWORD = 'demo';
const ACCESS_TOKEN = 'repro-access-token-00000000000000';
const VICTIM_DEVICE_ID = 'repro-victim-device';
const SEEDED_DEVICE_ID = 'repro-seeded-remote-device';

// Short and inert: proves the point (a real element renders, a dialog box
// opens) without doing anything beyond that.
const SEEDED_DEVICE_NAME =
    '<img src=x onerror="alert(\'This device name rendered as markup instead of as text.\')">';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8'
};

function log(msg) {
    console.log(`[repro] ${msg}`);
}

async function ensureBuilt() {
    if (existsSync(DIST_DIR)) {
        log(`reusing existing build at ${DIST_DIR}`);
        return;
    }
    log('no dist/ found -- building the web client once (this can take a minute)');
    await execFileAsync('npm', ['run', 'build:production'], {
        cwd: REPO_ROOT,
        env: { ...process.env, NODE_ENV: 'production' }
    });
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text)
    });
    res.end(text);
}

function userDto() {
    return {
        Name: USER_NAME,
        ServerId: SERVER_ID,
        Id: USER_ID,
        HasPassword: true,
        HasConfiguredPassword: true,
        HasConfiguredEasyPassword: false,
        EnableAutoLogin: false,
        LastLoginDate: new Date().toISOString(),
        LastActivityDate: new Date().toISOString(),
        Configuration: {
            PlayDefaultAudioTrack: true,
            GroupedFolders: [],
            OrderedViews: [],
            LatestItemsExcludes: [],
            MyMediaExcludes: [],
            SubtitleMode: 'Default',
            DisplayMissingEpisodes: false
        },
        Policy: {
            IsAdministrator: false,
            IsHidden: true,
            IsDisabled: false,
            EnableRemoteControlOfOtherUsers: false,
            EnableSharedDeviceControl: true,
            EnableRemoteAccess: true,
            EnableMediaPlayback: true,
            EnabledFolders: [],
            EnableAllFolders: true,
            EnabledChannels: [],
            EnableAllChannels: true,
            EnabledDevices: [],
            EnableAllDevices: true,
            AccessSchedules: [],
            BlockedTags: [],
            AllowedTags: [],
            BlockUnratedItems: [],
            SyncPlayAccess: 'CreateAndJoinGroups'
        }
    };
}

// A flat sequence of route checks for a local test fixture, not app logic.
// eslint-disable-next-line sonarjs/cognitive-complexity
async function handleApi(req, res, pathname) {
    const lower = pathname.toLowerCase();

    if (req.method === 'GET' && lower === '/system/info/public') {
        return sendJson(res, 200, {
            LocalAddress: BASE_URL,
            ServerName: 'repro',
            Version: '13.0.0',
            ProductName: 'Jellyfin Server',
            Id: SERVER_ID,
            StartupWizardCompleted: true
        });
    }

    if (req.method === 'GET' && lower === '/quickconnect/enabled') {
        return sendJson(res, 200, false);
    }

    if (req.method === 'GET' && (lower === '/users/public' || lower === '/branding/configuration')) {
        return sendJson(res, 200, lower === '/users/public' ? [] : {});
    }

    if (req.method === 'POST' && lower === '/users/authenticatebyname') {
        await readBody(req); // credentials are accepted unconditionally; this is a local fixture, not an auth check
        return sendJson(res, 200, {
            User: userDto(),
            SessionInfo: {
                Id: 'repro-victim-session',
                UserId: USER_ID,
                UserName: USER_NAME,
                Client: 'repro',
                DeviceName: 'repro-victim-browser',
                DeviceId: VICTIM_DEVICE_ID,
                ApplicationVersion: '13.0.0',
                SupportsRemoteControl: false,
                PlayState: {},
                AdditionalUsers: [],
                Capabilities: { PlayableMediaTypes: [], SupportedCommands: [] },
                SupportedCommands: []
            },
            AccessToken: ACCESS_TOKEN,
            ServerId: SERVER_ID
        });
    }

    if (req.method === 'POST' && lower === '/sessions/capabilities/full') {
        await readBody(req);
        res.writeHead(204);
        return res.end();
    }

    if (req.method === 'GET' && lower === `/users/${USER_ID.toLowerCase()}`) {
        return sendJson(res, 200, userDto());
    }

    if (req.method === 'GET' && lower === '/syncplay/list') {
        return sendJson(res, 200, []);
    }

    if (req.method === 'GET' && lower.startsWith('/displaypreferences/')) {
        // The post-login flow fetches this before it will render the home
        // page; it just needs to look like a valid (if empty) preferences
        // object, with a `CustomPrefs` bag the client mutates in place.
        return sendJson(res, 200, {
            Id: 'usersettings',
            ViewType: 'Poster',
            SortBy: 'SortName',
            CustomPrefs: {}
        });
    }

    if (req.method === 'GET' && lower === '/sessions') {
        // The one seeded "remote" session: a device name carrying the sample
        // string, visible to this signed-in user as a cast/"Play On" target.
        return sendJson(res, 200, [
            {
                Id: 'repro-seeded-session',
                UserId: USER_ID,
                UserName: USER_NAME,
                Client: 'repro-remote-client',
                DeviceName: SEEDED_DEVICE_NAME,
                DeviceId: SEEDED_DEVICE_ID,
                ApplicationVersion: '13.0.0',
                SupportsRemoteControl: true,
                PlayableMediaTypes: ['Video', 'Audio'],
                Capabilities: { SupportedCommands: ['DisplayContent'] },
                PlayState: {}
            }
        ]);
    }

    // Everything else this client might politely ask for while idling on
    // the home page (library lists, views, etc.): answer with a generic
    // empty-but-valid body so nothing throws. None of it matters for this
    // demonstration.
    if (req.method === 'GET') {
        return sendJson(res, 200, { Items: [], TotalRecordCount: 0 });
    }
    res.writeHead(204);
    res.end();
}

async function serveStatic(req, res, pathname) {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(DIST_DIR, decodeURIComponent(filePath));
    if (!filePath.startsWith(DIST_DIR)) {
        res.writeHead(403);
        return res.end();
    }
    try {
        const st = await stat(filePath);
        if (st.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        }
    } catch {
        // fall through to SPA index for client-side routes like /web/#/home
    }
    try {
        const data = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    } catch {
        const index = await readFile(path.join(DIST_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(index);
    }
}

async function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, BASE_URL);
            if (url.pathname.startsWith('/web/') || url.pathname === '/web') {
                return await serveStatic(req, res, url.pathname.replace(/^\/web/, '') || '/index.html');
            }
            if (
                [
                    '/system', '/quickconnect', '/users', '/userviews', '/sessions', '/branding', '/displaypreferences', '/syncplay'
                ].some((p) => url.pathname.toLowerCase().startsWith(p))
            ) {
                return await handleApi(req, res, url.pathname);
            }
            return await serveStatic(req, res, url.pathname);
        } catch (err) {
            res.writeHead(500);
            res.end(String(err));
        }
    });

    // A real client opens a WebSocket after signing in. This fixture has
    // nothing to say over it, so fail the upgrade fast and cleanly rather
    // than hanging the connection; the app already tolerates that.
    server.on('upgrade', (req, socket) => {
        socket.destroy();
    });

    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    log(`fixture server listening on ${BASE_URL}`);
    return server;
}

async function launchBrowser() {
    const launchOptions = { headless: false, args: ['--window-size=1200,860'] };
    try {
        return await puppeteer.launch(launchOptions);
    } catch (err) {
        if (!/Could not find (Chrome|Chromium)/.test(String(err))) {
            throw err;
        }
        // This repo's .npmrc sets ignore-scripts=true, so puppeteer's own
        // postinstall download never ran as part of `npm install`. Fetch its
        // browser build explicitly instead of asking the user to do it.
        log('no local browser found for puppeteer -- installing one once (this can take a minute)');
        await execFileAsync('npx', ['--yes', 'puppeteer', 'browsers', 'install', 'chrome'], { cwd: REPO_ROOT });
        return puppeteer.launch(launchOptions);
    }
}

async function main() {
    await ensureBuilt();
    const server = await startServer();

    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });

        let dialogSeen = false;
        page.on('dialog', (dialog) => {
            dialogSeen = true;
            log(`a dialog box opened: ${JSON.stringify(dialog.message())}`);
            log('dismiss it (click OK) to let the script finish.');
            // Deliberately not calling dialog.dismiss()/accept() here: this
            // is a real, visible browser window, and letting a real person
            // close the dialog is the point.
        });

        log(`opening ${BASE_URL}/web/ in a visible browser window`);
        await page.goto(`${BASE_URL}/web/`, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('#txtManualName', { visible: true, timeout: 15000 }).catch(() => undefined);
        const manualBtn = await page.$('.btnManual');
        if (manualBtn) {
            const visible = await page.evaluate((el) => window.getComputedStyle(el).display !== 'none' && !el.closest('.hide'), manualBtn);
            if (visible) await manualBtn.click();
        }
        await page.waitForSelector('#txtManualName', { visible: true, timeout: 15000 });
        await page.type('#txtManualName', USER_NAME, { delay: 15 });
        await page.type('#txtManualPassword', PASSWORD, { delay: 15 });

        log('signing in');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => undefined),
            page.click('.manualLoginForm .button-submit')
        ]);

        const domClick = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

        await page.waitForFunction(
            (sel) => {
                const el = document.querySelector(sel);
                return el && window.getComputedStyle(el).display !== 'none' && !el.classList.contains('hide');
            },
            { timeout: 20000 },
            '.headerCastButton'
        );

        log('opening the cast menu (target picker -- unaffected by this fix, renders as text here)');
        await domClick('.headerCastButton');
        await page.waitForSelector('.actionSheetMenuItem', { timeout: 10000 });

        const selected = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('.actionSheetMenuItem'))
                .find((e) => e.textContent.includes('onerror'));
            if (el) {
                el.click();
                return true;
            }
            return false;
        });
        if (!selected) {
            throw new Error('seeded target did not appear in the cast menu');
        }
        await new Promise((r) => setTimeout(r, 1000));

        log('reopening the cast menu (this is the dialog the fix changes)');
        await domClick('.headerCastButton');
        await new Promise((r) => setTimeout(r, 1500));

        if (dialogSeen) {
            log('RESULT: a dialog box opened -- the device name rendered as markup (pre-fix behavior).');
            log('Waiting for you to dismiss it...');
            await page.waitForFunction(() => true, { timeout: 60000 }).catch(() => undefined);
            // Give puppeteer a moment to notice the dialog actually closed.
            await new Promise((r) => setTimeout(r, 500));
        } else {
            const text = await page.evaluate(() => document.querySelector('.promptDialogContent h2')?.textContent);
            log(`RESULT: no dialog box opened -- the device name displayed as plain text: ${JSON.stringify(text)}`);
            log('(this is the fixed behavior)');
        }
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch((err) => {
    console.error('[repro] failed:', err);
    process.exitCode = 1;
});
