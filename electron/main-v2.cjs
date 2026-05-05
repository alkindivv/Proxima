// Proxima main process — embedded browser + anti-detection + IPC server

const { app, BrowserWindow, ipcMain, shell, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const BrowserManager = require('./browser-manager.cjs');
const { initRestAPI, startRestAPI, stopRestAPI, isRestAPIRunning } = require('./rest-api.cjs');
const providerAPI = require('./provider-api.cjs');

// Cache for API responses — when API captures response, DOM scraping is skipped
const _apiResponseCache = {};

// Anti-detection: must run before any Electron APIs
// These MUST be set before app is ready or any windows are created

// Clean Chrome UA matching Electron 33's Chromium 130
const CHROME_VERSION = '130.0.6723.191';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

// 1. Set user agent at Chromium level
//    Ensures consistent sec-ch-ua brand generation
app.commandLine.appendSwitch('user-agent', CHROME_UA);

// 2. Disable automation flags for proper page rendering
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// 3. Disable unnecessary Electron features
app.commandLine.appendSwitch('disable-features', 'ElectronSerialChooser,OutOfBlinkCors');

// 4. Set the app-wide fallback user agent
app.userAgentFallback = CHROME_UA;

// 5. Apply user agent to all sessions on ready
app.on('ready', () => {

    session.defaultSession.setUserAgent(CHROME_UA);
});


// Store user settings
const userDataPath = app.getPath('userData');
const settingsPath = path.join(userDataPath, 'settings.json');
const enabledProvidersPath = path.join(userDataPath, 'enabled-providers.json');

let mainWindow;
let browserManager;
let ipcServer; // For MCP server communication
let cookieBackupInterval; // For clearing on shutdown

// State tracking for response change detection
const responseState = {
    perplexity: { fingerprint: '', blockCount: 0 },
    chatgpt: { fingerprint: '' },
    claude: { fingerprint: '' },
    gemini: { fingerprint: '' },
    kimi: { fingerprint: '' },
    minimax: { fingerprint: '' },
    mimo: { fingerprint: '' },
    qwen: { fingerprint: '' },
    zai: { fingerprint: '' },
    deepseek: { fingerprint: '' }
};

// Default settings
const defaultSettings = {
    providers: {
        perplexity: { enabled: true, loggedIn: false },
        chatgpt: { enabled: true, loggedIn: false },
        claude: { enabled: false, loggedIn: false },
        gemini: { enabled: true, loggedIn: false },
        kimi: { enabled: false, loggedIn: false },
        minimax: { enabled: false, loggedIn: false },
        mimo: { enabled: false, loggedIn: false },
        qwen: { enabled: false, loggedIn: false },
        zai: { enabled: false, loggedIn: false },
        deepseek: { enabled: false, loggedIn: false }
    },
    ipcPort: 19222, // Port for MCP server IPC communication
    theme: 'dark',
    headlessMode: false, // When true, runs in background without visible window
    startMinimized: false // Start minimized to system tray
};

function normalizeSettings(saved = {}) {
    return {
        ...defaultSettings,
        ...saved,
        providers: {
            ...defaultSettings.providers,
            ...(saved.providers || {})
        }
    };
}

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            return normalizeSettings(saved);
        }
    } catch (e) {
        console.error('Error loading settings:', e);
    }
    return normalizeSettings();
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Error saving settings:', e);
    }
}

function saveEnabledProviders(settings) {
    try {
        const enabled = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        // Primary: Save to user data folder (AppData) — this ALWAYS works
        // The MCP server reads from here first
        fs.writeFileSync(enabledProvidersPath, JSON.stringify({ enabled }, null, 2));

        // Secondary: Also try to save to the app's src folder for MCP server fallback
        // This may fail in packaged app if installed in Program Files (needs admin)
        // That's OK — MCP server reads from AppData first anyway
        try {
            const isDev = !app.isPackaged;
            const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
            const mcpConfigPath = isDev
                ? path.join(__dirname, '..', 'src', 'enabled-providers.json')
                : path.join(resourcesPath, 'app.asar.unpacked', 'src', 'enabled-providers.json');

            fs.writeFileSync(mcpConfigPath, JSON.stringify({ enabled }, null, 2));
        } catch (e2) {
            // Not critical — AppData version is the primary source of truth
            console.log('[Settings] Could not write to app directory (normal in installed mode)');
        }
    } catch (e) {
        console.error('Error saving enabled providers:', e);
    }
}

// Cookie backup/restore — survive app restarts
const cookieBackupDir = path.join(userDataPath, 'cookie-backups');

async function backupCookies(provider, ses) {
    try {
        // Ensure backup directory exists
        if (!fs.existsSync(cookieBackupDir)) {
            fs.mkdirSync(cookieBackupDir, { recursive: true });
        }

        // Get all cookies from the session
        const allCookies = await ses.cookies.get({});

        // Save them with metadata
        const backup = {
            provider,
            timestamp: Date.now(),
            cookies: allCookies.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite || 'no_restriction',
                // Use 1 year expiry for session cookies — prevents premature logout
                expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60)
            }))
        };

        const backupPath = path.join(cookieBackupDir, `${provider}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

    } catch (e) {
        console.error(`[Cookie Backup] Error backing up ${provider}:`, e.message);
    }
}

async function restoreCookies(provider, ses) {
    try {
        const backupPath = path.join(cookieBackupDir, `${provider}.json`);
        if (!fs.existsSync(backupPath)) {
            return false;
        }

        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

        // Check if backup is too old (> 90 days)
        const maxAge = 90 * 24 * 60 * 60 * 1000; // 90 days in ms
        if (Date.now() - backup.timestamp > maxAge) {
            console.log(`[Cookie Restore] Backup too old for ${provider}, deleting`);
            fs.unlinkSync(backupPath);
            return false;
        }

        // Check if there are already valid AUTH cookies in the session
        // Don't just count all cookies — Google sets many tracking/consent cookies
        // that don't indicate login status
        const providerAuthDomains = {
            perplexity: { domain: 'perplexity.ai', authCookies: ['__Secure-next-auth.session-token', 'pplx_'] },
            chatgpt: { domain: 'openai.com', authCookies: ['__Secure-next-auth.session-token', '__cf_bm'] },
            claude: { domain: 'claude.ai', authCookies: ['sessionKey', '__cf_bm'] },
            gemini: { domain: 'google.com', authCookies: ['SID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID'] },
            kimi: { domain: 'kimi.com', authCookies: ['session', 'token', 'auth', 'access'] },
            minimax: { domain: 'minimax.io', authCookies: ['session', 'token', 'auth', 'access'] },
            mimo: { domain: 'xiaomimimo.com', authCookies: ['session', 'token', 'auth', 'access'] },
            qwen: { domain: 'qwen.ai', authCookies: ['session', 'token', 'auth', 'access'] },
            zai: { domain: 'z.ai', authCookies: ['session', 'token', 'auth', 'access'] },
            deepseek: { domain: 'deepseek.com', authCookies: ['session', 'token', 'auth', 'access'] }
        };
        const authConfig = providerAuthDomains[provider];
        if (authConfig) {
            const existing = await ses.cookies.get({});
            const domainCookies = existing.filter(c => c.domain.includes(authConfig.domain));
            const hasAuth = authConfig.authCookies.some(name =>
                domainCookies.some(c => c.name.startsWith(name) || c.name === name)
            );
            if (hasAuth) {
                console.log(`[Cookie Restore] ${provider} already has valid auth cookies, skipping restore`);
                return true;
            }
        }

        // Restore cookies with refreshed expiration (1 year)
        const oneYearFromNow = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
        let restored = 0;

        for (const cookie of backup.cookies) {
            try {
                const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                const url = `http${cookie.secure !== false ? 's' : ''}://${domain}${cookie.path || '/'}`;

                await ses.cookies.set({
                    url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly === true,
                    sameSite: cookie.sameSite || 'no_restriction',
                    // Refresh expiration on restore — 1 year
                    expirationDate: Math.max(cookie.expirationDate || 0, oneYearFromNow)
                });
                restored++;
            } catch (e) {
                // Skip individual failures silently
            }
        }

        // Flush to disk
        await ses.cookies.flushStore();

        // Refresh backup timestamp so it doesn't expire for active users
        if (restored > 0) {
            backup.timestamp = Date.now();
            fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
        }

        console.log(`[Cookie Restore] Restored ${restored}/${backup.cookies.length} cookies for ${provider}`);
        return restored > 0;
    } catch (e) {
        console.error(`[Cookie Restore] Error restoring ${provider}:`, e.message);
        return false;
    }
}


function createWindow() {
    const settings = loadSettings();
    const isHeadless = settings.headlessMode || process.argv.includes('--headless');
    const startMinimized = settings.startMinimized || process.argv.includes('--minimized');

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 850,
        minWidth: 900,
        minHeight: 700,
        show: !isHeadless && !startMinimized, // Don't show if headless or minimized
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs')
        },
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0f0f1a',
            symbolColor: '#ffffff',
            height: 38
        },
        backgroundColor: '#0f0f23',
        icon: path.join(__dirname, '../assets/proxima-icon.png')
    });
    mainWindow.setMaxListeners(50); // Electron BrowserView add/remove ops add internal 'closed' listeners

    // Initialize browser manager
    browserManager = new BrowserManager(mainWindow);

    mainWindow.loadFile(path.join(__dirname, 'index-v2.html'));

    // Show window when ready (if not headless)
    mainWindow.once('ready-to-show', async () => {
        if (!isHeadless && !startMinimized) {
            mainWindow.show();
        }
        console.log(`[Agent Hub] Running in ${isHeadless ? 'HEADLESS' : 'VISIBLE'} mode`);
        console.log('[Agent Hub] MCP server can connect on port', settings.ipcPort || 19222);

        // Auto-initialize ALL enabled providers on startup
        const enabledProviders = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        console.log('[Agent Hub] Auto-loading enabled providers:', enabledProviders);

        // Wait a bit for the UI to be ready
        await sleep(1000);

        // Get the browser area bounds
        const bounds = { x: 0, y: 170, width: 1200, height: 680 };
        const offScreenBounds = { x: -10000, y: 0, width: 1200, height: 680 };

        // Initialize all enabled providers (create views, add to window, navigate)
        for (let i = 0; i < enabledProviders.length; i++) {
            const provider = enabledProviders[i];
            try {
                console.log(`[Agent Hub] Initializing ${provider}...`);

                // Restore backed up cookies before loading
                const providerConfig = browserManager.providers[provider];
                if (providerConfig) {
                    const ses = session.fromPartition(providerConfig.partition, { cache: true });
                    const restored = await restoreCookies(provider, ses);
                    if (restored) {
                        console.log(`[${provider}] Cookies restored from backup`);
                    }
                }

                const view = browserManager.createView(provider);

                if (view) {
                    // Add view to window (REQUIRED for it to render!)
                    mainWindow.addBrowserView(view);

                    // Set bounds (first one visible, others off-screen)
                    if (i === 0) {
                        view.setBounds(bounds);
                    } else {
                        view.setBounds(offScreenBounds);
                    }


                }

                await sleep(1500); // Give time for page to start loading

                // Setup auto-inject for API scripts (all providers)
                const wc = browserManager.getWebContents(provider);
                if (wc) {
                    providerAPI.setupAutoInject(provider, wc);
                }
            } catch (err) {
                console.error(`[Agent Hub] Error initializing ${provider}:`, err.message);
            }
        }

        // Set the first provider as active
        if (enabledProviders.length > 0) {
            browserManager.activeProvider = enabledProviders[0];
            console.log(`[Agent Hub] ${enabledProviders[0]} set as default (already visible)`);

            // Notify renderer which provider to highlight
            mainWindow.webContents.send('set-active-provider', enabledProviders[0]);
        }

        console.log('[Agent Hub] All providers initialized and ready!');

        // Periodically backup cookies every 10 minutes
        cookieBackupInterval = setInterval(async () => {
            if (!browserManager || browserManager.isDestroyed) return;
            for (const provider of browserManager.getInitializedProviders()) {
                try {
                    const config = browserManager.providers[provider];
                    if (config) {
                        const ses = session.fromPartition(config.partition, { cache: true });
                        const cookies = await ses.cookies.get({});
                        if (cookies.length > 5) {
                            await backupCookies(provider, ses);
                        }
                    }
                } catch (e) { }
            }
        }, 10 * 60 * 1000); // Every 10 minutes
    });

    mainWindow.on('closed', () => {
        if (cookieBackupInterval) {
            clearInterval(cookieBackupInterval);
            cookieBackupInterval = null;
        }
        if (browserManager) {
            browserManager.destroy();
        }
        mainWindow = null;
    });

    // Save enabled providers on startup
    saveEnabledProviders(loadSettings());

    // Start IPC server for MCP communication
    startIPCServer();

    // Start REST API server (only if enabled in settings)
    try {
        const currentSettings = loadSettings();
        initRestAPI({
            handleMCPRequest,
            getEnabledProviders: () => {
                const s = loadSettings();
                return Object.entries(s.providers)
                    .filter(([_, c]) => c.enabled).map(([n]) => n);
            }
        });
        // Only start if enabled (default: false — user must enable it)
        if (currentSettings.restApiEnabled) {
            startRestAPI();
        } else {
            console.log('[REST API] Disabled in settings. Enable via UI toggle.');
        }
    } catch (e) {
        console.error('[REST API] Failed to start:', e.message);
    }
}

// IPC Server for MCP Communication

function startIPCServer() {
    const DEFAULT_IPC_PORT = 19222;

    ipcServer = net.createServer((socket) => {


        let buffer = '';

        socket.on('data', async (data) => {
            buffer += data.toString();


            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    try {

                        const request = JSON.parse(line);
                        const response = await handleMCPRequest(request);

                        response.requestId = request.requestId;
                        const responseStr = JSON.stringify(response) + '\n';

                        socket.write(responseStr);
                    } catch (e) {
                        console.error('[IPC] Error:', e.message);
                        const request = (() => { try { return JSON.parse(line); } catch { return {}; } })();
                        socket.write(JSON.stringify({ error: e.message, requestId: request.requestId }) + '\n');
                    }
                }
            }
        });

        socket.on('error', (err) => {
            console.error('[IPC] Socket error:', err);
        });
    });


    ipcServer.listen(DEFAULT_IPC_PORT, '127.0.0.1', () => {
        console.log(`[IPC] Server listening on port ${DEFAULT_IPC_PORT}`);

        const s = loadSettings();
        if (s.ipcPort !== DEFAULT_IPC_PORT) {
            s.ipcPort = DEFAULT_IPC_PORT;
            saveSettings(s);
        }
    });

    ipcServer.on('error', (err) => {
        console.error('[IPC] Server error:', err);

        if (err.code === 'EADDRINUSE') {
            console.log(`[IPC] Port ${DEFAULT_IPC_PORT} in use, trying ${DEFAULT_IPC_PORT + 1}...`);
            setTimeout(() => {
                ipcServer.close();
                ipcServer.listen(DEFAULT_IPC_PORT + 1, '127.0.0.1', () => {
                    console.log(`[IPC] Server listening on fallback port ${DEFAULT_IPC_PORT + 1}`);
                });
            }, 1000);
        }
    });
}

async function handleMCPRequest(request) {
    const { action, provider, data } = request;

    try {
        switch (action) {
            case 'ping':
                return { success: true, message: 'pong' };

            case 'getStatus':
                return {
                    success: true,
                    providers: browserManager.getInitializedProviders(),
                    activeProvider: browserManager.activeProvider
                };

            case 'initProvider':
                browserManager.createView(provider);
                return { success: true, provider };

            case 'isLoggedIn':
                const loggedIn = await browserManager.isLoggedIn(provider);
                return { success: true, provider, loggedIn };

            case 'sendMessage':
            case 'send-message':
                // Check if file should be uploaded
                if (data.filePath && fileReferenceEnabled) {
                    try {

                        const uploadResult = await uploadFileToProvider(provider, data.filePath);
                        await sleep(1000); // Wait for file to attach
                        const result = await sendMessageToProvider(provider, data.message, data.forceDOM || false);
                        return { success: true, provider, result, fileUploaded: uploadResult };
                    } catch (fileErr) {
                        console.error('[MCP] File upload failed:', fileErr.message);
                        // Still send message even if file upload fails
                        const result = await sendMessageToProvider(provider, data.message, data.forceDOM || false);
                        return { success: true, provider, result, fileError: fileErr.message };
                    }
                } else {
                    const result = await sendMessageToProvider(provider, data.message, data.forceDOM || false);
                    return { success: true, provider, result };
                }

            case 'uploadFile':
                // Upload file only (without sending message)
                if (!fileReferenceEnabled) {
                    return { success: false, error: 'File reference is disabled. Enable it in Agent Hub settings.' };
                }
                try {
                    const uploadResult = await uploadFileToProvider(provider, data.filePath);

                    return { success: true, provider, ...uploadResult };
                } catch (uploadErr) {
                    return { success: false, error: uploadErr.message };
                }

            case 'sendMessageWithFile':
                // Explicitly send message with file
                if (!fileReferenceEnabled) {
                    return { success: false, error: 'File reference is disabled. Enable it in Agent Hub settings.' };
                }
                try {
                    let fileResult = null;
                    if (data.filePath && fileReferenceEnabled) {

                        fileResult = await uploadFileToProvider(provider, data.filePath);



                        // Wait longer and verify file is attached

                        await sleep(3000);

                        // Retry check for file attachment (up to 3 times)
                        let retries = 0;
                        while (!fileResult.fileAttached && retries < 3) {

                            await sleep(2000);

                            // Re-check for attachment indicators
                            const attached = await checkFileAttachment(provider);
                            if (attached) {
                                fileResult.fileAttached = true;

                                break;
                            }
                            retries++;
                        }

                        if (!fileResult.fileAttached) {

                        }

                        // Wait for send button to be ready (file upload complete)

                        await waitForSendButtonReady(provider);
                    }


                    const msgResult = await sendMessageToProvider(provider, data.message);
                    // Use engine response if available, only DOM-poll when engine didn't return content
                    let finalResponse = '';
                    if (msgResult && msgResult.response && msgResult.response.length > 0) {
                        finalResponse = msgResult.response;
                    } else {
                        const responseData = await getResponseWithTypingStatus(provider);
                        finalResponse = responseData.response;
                    }
                    return {
                        success: true,
                        provider,
                        fileUploaded: fileResult,
                        messageSent: msgResult,
                        response: finalResponse
                    };
                } catch (err) {
                    return { success: false, error: err.message };
                }

            case 'getResponse':
                const response = await getProviderResponse(provider, data.selector);
                return { success: true, provider, response };

            case 'getTypingStatus':
                // Check if AI is currently typing/generating
                const typingStatus = await isAITyping(provider);
                return { success: true, provider, ...typingStatus };

            case 'getResponseWithTyping':
            case 'get-response-with-typing':
                // Smart response capture - waits for typing to start and stop
                const smartResponse = await getResponseWithTypingStatus(provider);
                return {
                    success: true,
                    provider,
                    typingStarted: smartResponse.typingStarted,
                    typingStopped: smartResponse.typingStopped,
                    response: smartResponse.response
                };

            case 'waitForSendButton':
            case 'wait-for-send-button':
                // Wait for send button to be visible and enabled
                const buttonReady = await waitForSendButtonReady(provider);
                return { success: true, provider, ready: buttonReady };

            case 'readClipboard':
            case 'read-clipboard':
                return { success: true, text: clipboard.readText() };

            case 'readProviderClipboard':
            case 'read-provider-clipboard':
            case 'get-provider-clipboard': {
                const providerWebContents = browserManager.getWebContents(provider);
                if (!providerWebContents || providerWebContents.isDestroyed()) {
                    return { success: false, error: 'Provider view not available' };
                }
                const text = await providerWebContents.executeJavaScript(`
                    (async () => {
                        try {
                            return await navigator.clipboard.readText();
                        } catch (e) {
                            return 'CLIPBOARD_ERR:' + e.message;
                        }
                    })()
                `).catch(e => 'CLIPBOARD_ERR:' + e.message);
                return { success: true, provider, text, systemClipboard: clipboard.readText() };
            }

            case 'executeScript':
            case 'execute-script':
                const scriptResult = await browserManager.executeScript(provider, data.script);
                return { success: true, provider, result: scriptResult };

            case 'navigate':
                await browserManager.navigate(provider, data.url);
                return { success: true, provider };

            case 'newConversation':
                await startNewConversation(provider);
                return { success: true, provider };

            case 'debugDOM':
                // Debug: Inspect DOM structure to find correct selectors
                const debugInfo = await browserManager.executeScript(provider, `
                    (function() {
                        const info = {
                            url: window.location.href,
                            host: window.location.host,
                            articles: document.querySelectorAll('article').length,
                            proseElements: document.querySelectorAll('.prose').length,
                            markdownElements: document.querySelectorAll('.markdown').length,
                            divs: document.querySelectorAll('div').length
                        };
                        
                        // Get sample of article contents
                        const articles = document.querySelectorAll('article');
                        info.articleSamples = [];
                        for (let i = 0; i < Math.min(3, articles.length); i++) {
                            const art = articles[i];
                            info.articleSamples.push({
                                classes: art.className,
                                dataAttrs: art.dataset,
                                hasProseChild: !!art.querySelector('.prose'),
                                hasMarkdownChild: !!art.querySelector('.markdown'),
                                textPreview: art.innerText.substring(0, 100)
                            });
                        }
                        
                        // Get sample of prose elements
                        const proseEls = document.querySelectorAll('.prose');
                        info.proseSamples = [];
                        for (let i = 0; i < Math.min(3, proseEls.length); i++) {
                            info.proseSamples.push({
                                tag: proseEls[i].tagName,
                                classes: proseEls[i].className,
                                textPreview: proseEls[i].innerText.substring(0, 150)
                            });
                        }
                        
                        return info;
                    })()
                `);

                return { success: true, provider, debugInfo };

            // Window visibility controls (for headless mode)
            case 'showWindow':
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
                return { success: true, visible: true };

            case 'hideWindow':
                if (mainWindow) {
                    mainWindow.hide();
                }
                return { success: true, visible: false };

            case 'toggleWindow':
                if (mainWindow) {
                    if (mainWindow.isVisible()) {
                        mainWindow.hide();
                    } else {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
                return { success: true, visible: mainWindow?.isVisible() };

            case 'isWindowVisible':
                return { success: true, visible: mainWindow?.isVisible() || false };

            case 'getSettings':
                return { success: true, settings: loadSettings() };

            case 'setHeadlessMode':
                const settings = loadSettings();
                settings.headlessMode = data.enabled;
                saveSettings(settings);
                if (data.enabled && mainWindow) {
                    mainWindow.hide();
                } else if (!data.enabled && mainWindow) {
                    mainWindow.show();
                }
                return { success: true, headlessMode: data.enabled };

            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Provider-Specific Interaction Functions

async function sendMessageToProvider(provider, message, forceDOM = false) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    const preferDOMForProvider = false;

    // API-first approach — direct fetch + SSE, skip when forceDOM=true or when provider needs UI state control
    if (!forceDOM && !preferDOMForProvider) {
        try {
            console.log(`[${provider}] Trying API-first approach...`);
            const apiResponse = await providerAPI.sendViaAPI(provider, webContents, message);
            if (apiResponse && apiResponse.length > 0) {
                const looksLikeGeminiConversationId = provider === 'gemini' && /^c_[a-f0-9]+$/i.test((apiResponse || '').trim());
                if (looksLikeGeminiConversationId) {
                    console.log(`[${provider}] API returned conversation id (${apiResponse}) — falling back to DOM send`);
                    delete _apiResponseCache[provider];
                } else {
                    console.log(`[${provider}] \u2714 API response captured (${apiResponse.length} chars)`);
                    _apiResponseCache[provider] = apiResponse;
                    return { response: apiResponse };
                }
            }
            console.log(`[${provider}] API returned empty \u2014 falling back to DOM`);
            delete _apiResponseCache[provider];
        } catch (apiErr) {
            console.log(`[${provider}] API failed: ${apiErr.message} — falling back to DOM`);
            // Clear stale cache so getResponseWithTyping doesn't return old data
            delete _apiResponseCache[provider];
        }
    } else if (preferDOMForProvider && !forceDOM) {
        console.log(`[${provider}] Skipping API-first so preferred UI model selection can be enforced before send`);
    } else {
        console.log(`[${provider}] forceDOM=true — skipping API, typing into open conversation`);
    }

    // DOM fallback: types into currently open conversation

    switch (provider) {
        case 'perplexity':
            return await sendToPerplexity(webContents, message);
        case 'chatgpt':
            return await sendToChatGPT(webContents, message);
        case 'claude':
            return await sendToClaude(webContents, message);
        case 'gemini':
            return await sendToGemini(webContents, message);
        case 'kimi':
        case 'minimax':
        case 'mimo':
        case 'qwen':
        case 'zai':
        case 'deepseek':
            return await sendToModernProvider(webContents, provider, message);
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

async function sendToPerplexity(webContents, message) {
    console.log('[Perplexity] Sending message...');

    // Only navigate to home if NOT on Perplexity at all - STAY in same conversation
    const currentUrl = await webContents.executeJavaScript('window.location.href');
    if (!currentUrl.includes('perplexity.ai')) {
        await webContents.loadURL('https://www.perplexity.ai/');
        await sleep(2000);
    }

    // IMPORTANT: Capture the OLD response fingerprint BEFORE sending new message
    const oldResponseData = await webContents.executeJavaScript(`
        (function() {
            const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                .filter(block => {
                    const text = block.textContent.trim();
                    return text.length > 3 && 
                           !text.toLowerCase().includes('perplexity pro') &&
                           !text.includes('Ask anything') &&
                           !text.includes('Ask a follow-up') &&
                           !text.includes('Attach');
                });
            
            if (proseBlocks.length > 0) {
                const lastBlock = proseBlocks[proseBlocks.length - 1];
                return {
                    count: proseBlocks.length,
                    fingerprint: lastBlock.textContent.substring(0, 200).trim()
                };
            }
            return { count: 0, fingerprint: '' };
        })()
    `).catch(() => ({ count: 0, fingerprint: '' }));

    responseState.perplexity.fingerprint = oldResponseData.fingerprint;
    responseState.perplexity.blockCount = oldResponseData.count;
    console.log('[Perplexity] Old response data:', { count: oldResponseData.count, fingerprint: oldResponseData.fingerprint.substring(0, 50) + '...' });

    // Step 1: Focus the input area
    for (let focusAttempt = 0; focusAttempt < 3; focusAttempt++) {
        await webContents.executeJavaScript(`
            (function() {
                const followUp = document.querySelector('textarea[placeholder*="follow"]') ||
                                document.querySelector('textarea[placeholder*="Ask"]');
                if (followUp) {
                    followUp.click();
                    followUp.focus();
                    return 'followUp';
                }
                const inputArea = document.querySelector('[contenteditable="true"]') ||
                                 document.querySelector('textarea');
                if (inputArea) {
                    inputArea.click();
                    inputArea.focus();
                    return 'input';
                }
                return 'none';
            })()
        `);
        await sleep(300);
    }

    await sleep(500);

    // Step 2: Insert message using clipboard paste (ALWAYS - works with or without file)
    const oldClipboard = clipboard.readText();
    clipboard.writeText(message);

    // Paste with Ctrl+V
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });

    await sleep(500); // Wait for paste to complete

    // Restore clipboard
    clipboard.writeText(oldClipboard);
    console.log('[Perplexity] Message pasted via clipboard');

    // Step 3: Verify message was typed before sending
    const messageInInput = await webContents.executeJavaScript(`
        (function() {
            const input = document.activeElement;
            if (!input) return '';
            return (input.value || input.textContent || '').trim();
        })()
    `).catch(() => '');

    if (!messageInInput.includes(message.substring(0, 20))) {
        console.log('[Perplexity] WARNING: Message not found in input, retrying paste...');
        clipboard.writeText(message);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
        await sleep(500);
        clipboard.writeText(oldClipboard);
    }

    await sleep(300);

    // Step 4: Submit with Enter key
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });

    console.log('[Perplexity] Enter key sent');
    await sleep(500);

    return { sent: true, oldFingerprint: oldResponseData.fingerprint };
}

const CHATGPT_DEFAULT_MODEL_TESTID = 'model-switcher-gpt-5-5-thinking';
const CHATGPT_DEFAULT_MODEL_LABEL = 'Thinking';

async function ensureChatGPTPreferredModel(webContents) {
    const desiredTestId = CHATGPT_DEFAULT_MODEL_TESTID;
    const desiredLabel = CHATGPT_DEFAULT_MODEL_LABEL;

    const result = await webContents.executeJavaScript(`
        (async function() {
            const desiredTestId = ${JSON.stringify(CHATGPT_DEFAULT_MODEL_TESTID)};
            const desiredLabel = ${JSON.stringify(CHATGPT_DEFAULT_MODEL_LABEL)};
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            const getText = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
            const getModelButton = () => document.querySelector('[data-testid="model-switcher-dropdown-button"]') || document.querySelector('button[aria-label="Model selector"]');
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const listOptions = () => Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((el) => ({
                testid: el.getAttribute('data-testid') || '',
                text: getText(el),
                checked: el.getAttribute('aria-checked') === 'true',
                visible: isVisible(el)
            }));
            const isMenuOpen = () => Array.from(document.querySelectorAll('[role="menuitemradio"]')).some(isVisible);
            const closeMenu = async () => {
                if (!isMenuOpen()) return;
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
                await sleep(180);
                if (isMenuOpen()) {
                    const btn = getModelButton();
                    if (btn) btn.click();
                    await sleep(180);
                }
            };
            const findDesired = () => document.querySelector('[data-testid="' + desiredTestId + '"][role="menuitemradio"]');
            const hasThinkingPill = () => {
                return Array.from(document.querySelectorAll('button, div, span'))
                    .some(el => {
                        const text = getText(el);
                        const cls = String(el.className || '');
                        return text === desiredLabel && (cls.includes('__composer-pill') || cls.includes('composer-pill'));
                    });
            };

            let button = getModelButton();
            if (!button) {
                return { ok: false, error: 'Model selector button not found', url: location.href };
            }

            let desired = findDesired();
            if (!desired) {
                button.click();
                await sleep(350);
                desired = findDesired();
            }

            if (!desired) {
                return {
                    ok: false,
                    error: 'Preferred ChatGPT model not found in model menu',
                    url: location.href,
                    options: listOptions(),
                    body: (document.body && document.body.innerText ? document.body.innerText.slice(0, 1200) : '')
                };
            }

            if (desired.getAttribute('aria-checked') === 'true') {
                await closeMenu();
                return {
                    ok: true,
                    changed: false,
                    verified: true,
                    model: desiredTestId,
                    label: desiredLabel,
                    options: listOptions(),
                    hasThinkingPill: hasThinkingPill()
                };
            }

            desired.click();
            await sleep(700);

            button = getModelButton();
            if (button && !findDesired()) {
                button.click();
                await sleep(350);
            }

            const desiredAfter = findDesired();
            const verified = !!desiredAfter && desiredAfter.getAttribute('aria-checked') === 'true';
            await closeMenu();

            return {
                ok: verified || hasThinkingPill(),
                changed: true,
                verified,
                model: desiredTestId,
                label: desiredLabel,
                options: listOptions(),
                hasThinkingPill: hasThinkingPill()
            };
        })()
    `);

    if (!result || !result.ok) {
        throw new Error(result && result.error ? result.error : 'Failed to enforce preferred ChatGPT model');
    }

    console.log(`[ChatGPT] Preferred model ready: ${desiredLabel} (${desiredTestId}) changed=${!!result.changed} verified=${!!result.verified} pill=${!!result.hasThinkingPill}`);
    return result;
}

async function sendToChatGPT(webContents, message) {
    await ensureChatGPTPreferredModel(webContents);

    // IMPORTANT: Capture current response fingerprint BEFORE sending new message
    // This helps us detect when the NEW response appears
    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            // Get all assistant messages
            const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (assistantMsgs.length > 0) {
                const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                const text = (lastMsg.innerText || lastMsg.textContent || '').trim();
                // Return first 200 chars as fingerprint
                return text.substring(0, 200);
            }
            // Fallback to article > .prose
            const articles = document.querySelectorAll('article');
            if (articles.length > 0) {
                const lastArticle = articles[articles.length - 1];
                const text = (lastArticle.innerText || lastArticle.textContent || '').trim();
                return text.substring(0, 200);
            }
            return '';
        })()
    `).catch(() => '');

    // Store fingerprint globally for response capture
    responseState.chatgpt.fingerprint = oldResponseFingerprint;
    console.log('[ChatGPT] Captured old response fingerprint:', oldResponseFingerprint.substring(0, 50) + '...');

    // Focus input field
    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('#prompt-textarea') || 
                          document.querySelector('textarea[data-id="root"]') ||
                          document.querySelector('textarea') ||
                          document.querySelector('[contenteditable="true"]');
            if (input) {
                input.focus();
                if (input.value !== undefined) input.value = '';
                return true;
            }
            return false;
        })()
    `);

    await typeIntoPage(webContents, message);
    await sleep(300);

    // Ensure focus is on input before pressing Enter
    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('#prompt-textarea') || 
                          document.querySelector('textarea') ||
                          document.querySelector('[contenteditable="true"]');
            if (input) input.focus();
        })()
    `);

    await sleep(100);

    // Try button click first (more reliable for ChatGPT's new UI)
    const clicked = await webContents.executeJavaScript(`
        (function() {
            const btn = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Send"]');
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        })()
    `);

    // If button click failed, try Enter key
    if (!clicked) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return { sent: true, model: CHATGPT_DEFAULT_MODEL_TESTID };
}

async function sendToClaude(webContents, message) {
    // IMPORTANT: Capture current response fingerprint BEFORE sending new message
    // This helps us detect when the NEW response appears
    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            // Get all prose/response blocks
            const responses = document.querySelectorAll('.prose, [class*="prose"], [class*="message-content"]');
            if (responses.length > 0) {
                const lastResponse = responses[responses.length - 1];
                const text = (lastResponse.innerText || lastResponse.textContent || '').trim();
                // Return first 200 chars as fingerprint
                return text.substring(0, 200);
            }
            return '';
        })()
    `).catch(() => '');

    // Store fingerprint globally for response capture
    responseState.claude.fingerprint = oldResponseFingerprint;
    console.log('[Claude] Captured old response fingerprint:', oldResponseFingerprint.substring(0, 50) + '...');

    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('[contenteditable="true"]') ||
                          document.querySelector('div[data-placeholder*="Reply"]');
            if (input) {
                input.focus();
                input.innerHTML = '';
                return true;
            }
            return false;
        })()
    `);

    await typeIntoPage(webContents, message);
    await sleep(200);

    // Simple & reliable: Press Enter key
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    return { sent: true };
}

async function installProviderNetworkResponseCapture(webContents, provider) {
    if (!['qwen', 'deepseek', 'zai'].includes(provider)) return;

    await webContents.executeJavaScript(String.raw`
        (() => {
            const provider = ${JSON.stringify(provider)};
            const storeRoot = window.__proximaResponseCapture = window.__proximaResponseCapture || {};
            storeRoot[provider] = {
                response: '',
                done: false,
                source: '',
                updatedAt: Date.now()
            };

            const safeTrim = value => typeof value === 'string' ? value.trim() : '';
            const cleanSseText = value => String(value || '').replace(/\r/g, '');
            const sseBlocks = value => cleanSseText(value).split('\n\n').filter(Boolean);
            const sseDataLine = block => String(block || '').split('\n').find(part => safeTrim(part).startsWith('data:')) || '';
            const ssePayload = block => {
                const line = sseDataLine(block);
                return line ? line.replace(/^data:\s*/, '').trim() : '';
            };

            function store(providerName, url, response) {
                const trimmed = safeTrim(response);
                if (!trimmed) return;
                storeRoot[providerName] = {
                    response: trimmed,
                    done: true,
                    source: String(url || ''),
                    updatedAt: Date.now()
                };
            }

            function extractQwenFromChatDetail(text) {
                try {
                    const obj = JSON.parse(text);
                    const data = obj && obj.data ? obj.data : {};
                    const history = data.chat && data.chat.history && data.chat.history.messages ? data.chat.history.messages : {};
                    const messages = Array.isArray(data.messages) ? data.messages : Object.values(history || {});
                    for (let i = messages.length - 1; i >= 0; i--) {
                        const msg = messages[i] || {};
                        if (msg.role !== 'assistant') continue;
                        const contentList = Array.isArray(msg.content_list) ? msg.content_list : [];
                        const answer = contentList
                            .filter(item => item && item.phase === 'answer' && typeof item.content === 'string')
                            .map(item => item.content)
                            .join('')
                            .trim();
                        if (answer) return answer;
                        if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
                    }
                } catch (e) {}
                return '';
            }

            function extractQwenFromStream(text) {
                try {
                    let answer = '';
                    for (const block of sseBlocks(text)) {
                        const raw = ssePayload(block);
                        if (!raw || raw === '[DONE]') continue;
                        try {
                            const obj = JSON.parse(raw);
                            const choices = Array.isArray(obj && obj.choices) ? obj.choices : [];
                            const delta = choices[0] && choices[0].delta ? choices[0].delta : null;
                            if (delta && delta.phase === 'answer' && typeof delta.content === 'string') {
                                answer += delta.content;
                            }
                        } catch (e) {}
                    }
                    return answer.trim();
                } catch (e) {}
                return '';
            }

            function extractDeepSeekFromStream(text) {
                try {
                    let answer = '';
                    let currentType = '';
                    for (const block of sseBlocks(text)) {
                        const raw = ssePayload(block);
                        if (!raw || raw === '[DONE]') continue;
                        let obj = null;
                        try { obj = JSON.parse(raw); } catch (e) { continue; }

                        const topFragments = obj && obj.v && obj.v.response && Array.isArray(obj.v.response.fragments)
                            ? obj.v.response.fragments
                            : null;
                        if (topFragments) {
                            for (const frag of topFragments) {
                                if (frag && frag.type === 'RESPONSE') {
                                    answer += frag.content || '';
                                    currentType = 'RESPONSE';
                                } else if (frag && frag.type) {
                                    currentType = frag.type;
                                }
                            }
                            continue;
                        }

                        if (obj && obj.p === 'response/fragments' && Array.isArray(obj.v)) {
                            for (const frag of obj.v) {
                                if (frag && frag.type === 'RESPONSE') {
                                    answer += frag.content || '';
                                    currentType = 'RESPONSE';
                                } else if (frag && frag.type) {
                                    currentType = frag.type;
                                }
                            }
                            continue;
                        }

                        if (obj && obj.p === 'response/fragments/-1/content' && currentType === 'RESPONSE' && typeof obj.v === 'string') {
                            answer += obj.v;
                            continue;
                        }

                        if (obj && !obj.p && currentType === 'RESPONSE' && typeof obj.v === 'string') {
                            answer += obj.v;
                        }
                    }
                    return answer.trim();
                } catch (e) {}
                return '';
            }

            function extractZaiFromStream(text) {
                try {
                    let answer = '';
                    for (const block of sseBlocks(text)) {
                        const raw = ssePayload(block);
                        if (!raw || raw === '[DONE]') continue;
                        let obj = null;
                        try { obj = JSON.parse(raw); } catch (e) { continue; }
                        const data = obj && obj.data ? obj.data : null;
                        if (data && data.phase === 'answer' && typeof data.delta_content === 'string') {
                            answer += data.delta_content;
                        }
                    }
                    return answer.trim();
                } catch (e) {}
                return '';
            }

            function processPayload(url, text) {
                const normalizedUrl = String(url || '');
                if (provider === 'qwen' && normalizedUrl.includes('/api/v2/chat/completions')) {
                    const answer = extractQwenFromStream(text);
                    if (answer) store('qwen', normalizedUrl, answer);
                }
                if (provider === 'qwen' && normalizedUrl.includes('/api/v2/chats/')) {
                    const answer = extractQwenFromChatDetail(text);
                    if (answer) store('qwen', normalizedUrl, answer);
                }
                if (provider === 'deepseek' && normalizedUrl.includes('/api/v0/chat/completion')) {
                    const answer = extractDeepSeekFromStream(text);
                    if (answer) store('deepseek', normalizedUrl, answer);
                }
                if (provider === 'zai' && normalizedUrl.includes('/api/v2/chat/completions')) {
                    const answer = extractZaiFromStream(text);
                    if (answer) store('zai', normalizedUrl, answer);
                }
            }

            if (storeRoot.__hooked) return true;
            storeRoot.__hooked = true;

            const shouldCapture = url => {
                const normalizedUrl = String(url || '');
                return normalizedUrl.includes('/api/v2/chat/completions')
                    || normalizedUrl.includes('/api/v2/chats/')
                    || normalizedUrl.includes('/api/v0/chat/completion');
            };

            const originalFetch = window.fetch.bind(window);
            window.fetch = async function(...args) {
                const res = await originalFetch(...args);
                try {
                    const target = args[0];
                    const url = String(target && target.url ? target.url : target || '');
                    if (shouldCapture(url)) {
                        const clone = res.clone();
                        const text = await clone.text();
                        processPayload(url, text);
                    }
                } catch (e) {}
                return res;
            };

            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this.__proximaUrl = url;
                return originalOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('load', function() {
                    try {
                        const url = String(this.__proximaUrl || '');
                        if (shouldCapture(url)) {
                            processPayload(url, String(this.responseText || ''));
                        }
                    } catch (e) {}
                });
                return originalSend.apply(this, args);
            };

            return true;
        })()
    `);
}

async function waitForProviderNetworkResponse(webContents, provider, timeoutMs = 15000) {
    if (!['qwen', 'deepseek', 'zai'].includes(provider)) return '';

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const captured = await webContents.executeJavaScript(`
            (function() {
                const state = window.__proximaResponseCapture && window.__proximaResponseCapture[${JSON.stringify(provider)}];
                if (!state) return { response: '', done: false, source: '' };
                return {
                    response: typeof state.response === 'string' ? state.response : '',
                    done: !!state.done,
                    source: state.source || ''
                };
            })()
        `).catch(() => ({ response: '', done: false, source: '' }));

        if (captured && captured.response && captured.response.trim()) {
            console.log(`[${provider}] Network capture succeeded from ${captured.source || 'unknown source'} (${captured.response.length} chars)`);
            return captured.response.trim();
        }

        await sleep(500);
    }

    return '';
}

async function sendToGemini(webContents, message) {
    console.log('[Gemini] Sending message...');

    // IMPORTANT: Capture current response fingerprint BEFORE sending new message
    // This helps us detect when the NEW response appears
    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            // Try multiple selectors for Gemini responses
            const selectors = [
                'message-content',
                '.message-content',
                '[class*="response-content"]',
                '.model-response',
                '[class*="model-response"]',
                '[class*="markdown"]'
            ];
            
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    const lastEl = elements[elements.length - 1];
                    const text = (lastEl.innerText || lastEl.textContent || '').trim();
                    if (text.length > 10) {
                        return text.substring(0, 200);
                    }
                }
            }
            return '';
        })()
    `).catch(() => '');

    // Store fingerprint globally for response capture
    responseState.gemini.fingerprint = oldResponseFingerprint;
    console.log('[Gemini] Captured old response fingerprint:', oldResponseFingerprint.substring(0, 50) + '...');

    // Wait a bit for page to be fully ready
    await sleep(500);


    // Step 1: Find and focus the input
    const inputFound = await webContents.executeJavaScript(`
        (function() {
            // Try multiple input selectors for Gemini
            const selectors = [
                'rich-textarea .ql-editor',
                '.ql-editor',
                'rich-textarea [contenteditable="true"]', 
                '[contenteditable="true"][aria-label*="message"]',
                '[contenteditable="true"]',
                'textarea[aria-label*="message"]',
                'textarea',
                'input[type="text"]'
            ];
            
            for (const selector of selectors) {
                const input = document.querySelector(selector);
                if (input) {
                    input.focus();
                    input.click();
                    console.log('[Gemini] Found input:', selector);
                    return { found: true, selector: selector };
                }
            }
            return { found: false };
        })()
    `);

    console.log('[Gemini] Input search result:', inputFound);

    if (!inputFound.found) {
        console.log('[Gemini] No input found!');
        return { sent: false, error: 'No input field found' };
    }

    await sleep(300);

    // Step 2: Type the message using DOM-safe input, then click Gemini's send button
    const typeResult = await webContents.executeJavaScript(`
        (function() {
            const text = ${JSON.stringify(message)};

            function appendToEditable(el, value) {
                el.focus();
                const p = document.createElement('p');
                p.textContent = value;
                el.appendChild(p);
                el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    data: value,
                    inputType: 'insertText'
                }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, method: 'contenteditable', value: (el.innerText || '').trim() };
            }

            function setNativeValue(el, value) {
                const proto = el.tagName === 'TEXTAREA'
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && typeof desc.set === 'function') desc.set.call(el, value);
                else el.value = value;
                el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    data: value,
                    inputType: 'insertText'
                }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, method: 'native-input', value: el.value || '' };
            }

            const editable = document.querySelector('rich-textarea .ql-editor, .ql-editor, [contenteditable="true"][aria-label*="Gemini"], [contenteditable="true"]');
            if (editable) return appendToEditable(editable, text);

            const input = document.querySelector('textarea[aria-label*="Gemini"], textarea, input[type="text"]');
            if (input) return setNativeValue(input, text);

            return { success: false };
        })()
    `);

    console.log('[Gemini] Type result:', typeResult);
    await sleep(400);

    const sendResult = await webContents.executeJavaScript(`
        (function() {
            const visible = el => el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const btn = Array.from(document.querySelectorAll('button,[role="button"]')).find(el => {
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const text = (el.innerText || el.textContent || '').toLowerCase();
                const cls = (el.className || '').toString().toLowerCase();
                return visible(el) && !el.disabled && (
                    aria.includes('kirim pesan') || aria.includes('send message') ||
                    text.includes('kirim') || cls.includes('send-button')
                );
            });
            if (btn) {
                btn.click();
                return { sent: true, method: 'button-click' };
            }
            const input = document.querySelector('rich-textarea .ql-editor, .ql-editor, [contenteditable="true"], textarea');
            if (input) {
                input.focus();
                input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
                return { sent: true, method: 'enter-dispatch' };
            }
            return { sent: false };
        })()
    `).catch(() => ({ sent: false }));

    if (!sendResult.sent) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return { sent: true };
}

async function sendToModernProvider(webContents, provider, message) {
    console.log(`[${provider}] Sending message...`);

    const providerUrl = browserManager?.providers?.[provider]?.url;
    const currentUrl = await webContents.executeJavaScript('window.location.href').catch(() => '');
    if (providerUrl && currentUrl && !currentUrl.includes(new URL(providerUrl).hostname)) {
        await webContents.loadURL(providerUrl);
        await sleep(2000);
    }

    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            const selectors = [
                '[data-message-author-role="assistant"]',
                '[data-testid*="assistant"]',
                '[data-testid*="answer"]',
                '[class*="assistant"][class*="message"]',
                '[class*="response"]',
                'article',
                'main article',
                '.markdown',
                '[class*="markdown"]',
                '.prose',
                '[class*="prose"]'
            ];
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                for (let i = elements.length - 1; i >= 0; i--) {
                    const text = (elements[i].innerText || elements[i].textContent || '').trim();
                    if (text.length > 20) {
                        return text.substring(0, 200);
                    }
                }
            }
            return '';
        })()
    `).catch(() => '');

    responseState[provider].fingerprint = oldResponseFingerprint;
    console.log(`[${provider}] Captured old response fingerprint: ${oldResponseFingerprint.substring(0, 50)}...`);

    await sleep(500);

    if (provider === 'qwen' || provider === 'deepseek' || provider === 'zai') {
        await installProviderNetworkResponseCapture(webContents, provider);
    }

    if (provider === 'qwen') {
        const runQwenSendAttempt = async () => webContents.executeJavaScript(`
            (async function() {
                const text = ${JSON.stringify(message)};
                const visible = el => !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
                const input = document.querySelector('textarea.message-input-textarea, textarea[placeholder*="help"], textarea');
                if (!visible(input)) return { sent: false, error: 'No Qwen input field found' };

                input.focus();
                const proto = window.HTMLTextAreaElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && typeof desc.set === 'function') desc.set.call(input, text);
                else input.value = text;
                input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));
                input.dispatchEvent(new Event('change', { bubbles: true }));

                await new Promise(resolve => setTimeout(resolve, 800));

                const btn = document.querySelector('button.send-button');
                let method = 'none';
                if (visible(btn) && !btn.disabled) {
                    btn.focus();
                    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    btn.click();
                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                    method = 'button-pointer-click';
                } else {
                    input.focus();
                    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    method = 'keyboard-dispatch';
                }

                await new Promise(resolve => setTimeout(resolve, 4000));
                const body = document.body?.innerText || '';
                return {
                    sent: true,
                    method,
                    href: location.href,
                    value: input.value || '',
                    includes: body.includes(${JSON.stringify(message.substring(0, Math.min(16, message.length)))}),
                    thinkingCompleted: /thinking completed/i.test(body),
                    body: body.slice(0, 1200)
                };
            })()
        `).catch(e => ({ sent: false, error: e.message }));

        let qwenSendAttempt = await runQwenSendAttempt();
        if (!qwenSendAttempt.sent) {
            return qwenSendAttempt;
        }

        let qwenNetworkResponse = await waitForProviderNetworkResponse(webContents, 'qwen', 18000);
        if (qwenNetworkResponse) {
            return { sent: true, response: qwenNetworkResponse };
        }

        let likelySent = (qwenSendAttempt.href && qwenSendAttempt.href.includes('/c/')) || qwenSendAttempt.includes || qwenSendAttempt.thinkingCompleted;
        if (!likelySent) {
            console.log('[qwen] First submit attempt showed no page change, retrying once...');
            qwenSendAttempt = await runQwenSendAttempt();
            if (!qwenSendAttempt.sent) {
                return qwenSendAttempt;
            }
            qwenNetworkResponse = await waitForProviderNetworkResponse(webContents, 'qwen', 18000);
            if (qwenNetworkResponse) {
                return { sent: true, response: qwenNetworkResponse };
            }
            likelySent = (qwenSendAttempt.href && qwenSendAttempt.href.includes('/c/')) || qwenSendAttempt.includes || qwenSendAttempt.thinkingCompleted;
        }

        if (!likelySent) {
            return { sent: false, error: 'Qwen native input succeeded but submit did not change page state' };
        }

        return { sent: true };
    }

    if (provider === 'deepseek') {
        const deepseekResult = await webContents.executeJavaScript(`
            (async function() {
                const text = ${JSON.stringify(message)};
                const input = document.querySelector('textarea[placeholder*="DeepSeek"], textarea');
                if (!input || input.offsetParent === null) return { sent: false, error: 'No DeepSeek input field found' };

                input.focus();
                input.click();
                const proto = window.HTMLTextAreaElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && typeof desc.set === 'function') desc.set.call(input, text);
                else input.value = text;
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    data: text,
                    inputType: 'insertText'
                }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ', code: 'Space' }));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ', code: 'Space' }));

                await new Promise(resolve => setTimeout(resolve, 500));

                const value = input.value || '';
                if (!value || !value.includes(text.substring(0, Math.min(16, text.length)))) {
                    return { sent: false, error: 'Message not present after native input', value };
                }

                const buttons = Array.from(document.querySelectorAll('[role="button"]')).filter(el => {
                    const cls = (el.className || '').toString();
                    const ariaDisabled = el.getAttribute('aria-disabled');
                    return (el.offsetParent !== null || el.getClientRects().length > 0) &&
                           cls.includes('ds-icon-button') &&
                           !cls.includes('ds-toggle-button');
                });

                const sendBtn = buttons.find(el => (el.className || '').toString().includes('_52c986b') && el.getAttribute('aria-disabled') !== 'true')
                    || buttons.filter(el => el.getAttribute('aria-disabled') !== 'true').pop();

                if (sendBtn) {
                    sendBtn.click();
                    return { sent: true, method: 'deepseek-send-button', inputValue: input.value || '' };
                }

                input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
                input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Enter', code: 'Enter' }));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
                return { sent: true, method: 'deepseek-enter-fallback', inputValue: input.value || '' };
            })()
        `).catch(e => ({ sent: false, error: e.message }));

        if (!deepseekResult.sent) {
            return deepseekResult;
        }

        const deepseekNetworkResponse = await waitForProviderNetworkResponse(webContents, 'deepseek', 18000);
        if (deepseekNetworkResponse) {
            return { sent: true, response: deepseekNetworkResponse };
        }

        return { sent: true };
    }

    if (provider === 'minimax') {
        const marker = message.substring(0, Math.min(24, message.length));
        const minimaxReady = await webContents.executeJavaScript(`
            (function() {
                const editor = document.querySelector('.tiptap-editor, .ProseMirror, [contenteditable="true"]');
                if (!editor || editor.offsetParent === null) return { found: false };
                editor.focus();
                editor.click();
                return { found: true, text: (editor.innerText || '').trim(), href: location.href };
            })()
        `).catch(() => ({ found: false }));

        if (!minimaxReady.found) {
            return { sent: false, error: 'No MiniMax editor found' };
        }

        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        await sleep(150);

        if (typeof webContents.insertText === 'function') {
            await webContents.insertText(message);
        } else {
            await typeIntoPage(webContents, message);
        }

        await sleep(500);

        const minimaxTyped = await webContents.executeJavaScript(`
            (function() {
                const editor = document.querySelector('.tiptap-editor, .ProseMirror, [contenteditable="true"]');
                const body = document.body?.innerText || '';
                return {
                    value: editor ? ((editor.innerText || editor.textContent || '').trim()) : '',
                    href: location.href,
                    bodyCount: body.split(${JSON.stringify(marker)}).length - 1,
                    body: body.slice(0, 1000)
                };
            })()
        `).catch(() => ({ value: '' }));

        if (!minimaxTyped.value || !minimaxTyped.value.includes(marker)) {
            return { sent: false, error: 'MiniMax trusted typing did not populate the editor' };
        }

        const minimaxSubmit = await webContents.executeJavaScript(`
            (async function() {
                const marker = ${JSON.stringify(marker)};
                const editor = document.querySelector('.tiptap-editor, .ProseMirror, [contenteditable="true"]');
                const root = editor?.closest('.relative.text-pretty') || document;
                if (!editor) return { sent: false, error: 'No MiniMax editor found during submit' };

                const beforeHref = location.href;
                const beforeBody = document.body?.innerText || '';
                const countMarker = (text) => (text && marker ? text.split(marker).length - 1 : 0);
                const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
                const candidates = Array.from(root.querySelectorAll('button, [role="button"], div')).filter(el => {
                    if (!visible(el)) return false;
                    const cls = (el.className || '').toString();
                    if (!/bg-bg_interaction_primary_(default|inactive)|text-text_label_primary_default/.test(cls)) return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width >= 24 && rect.height >= 24;
                });

                const pick = candidates.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (br.x + br.y) - (ar.x + ar.y);
                })[0] || null;

                const clickEl = (el) => {
                    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
                    for (const type of events) {
                        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                    }
                    if (typeof el.click === 'function') el.click();
                };

                let method = 'button-click';
                if (pick) {
                    clickEl(pick);
                } else {
                    method = 'enter-fallback';
                    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    editor.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
                }

                await new Promise(resolve => setTimeout(resolve, 2500));

                const afterBody = document.body?.innerText || '';
                const afterValue = (editor.innerText || editor.textContent || '').trim();
                const afterHref = location.href;
                const advanced = afterHref !== beforeHref || afterValue !== marker || countMarker(afterBody) > countMarker(beforeBody);

                return {
                    sent: advanced,
                    method,
                    beforeHref,
                    afterHref,
                    beforeCount: countMarker(beforeBody),
                    afterCount: countMarker(afterBody),
                    remainingEditorText: afterValue,
                    candidateClass: pick ? (pick.className || '').toString() : ''
                };
            })()
        `).catch(e => ({ sent: false, error: e.message }));

        if (!minimaxSubmit.sent) {
            return { sent: false, error: minimaxSubmit.error || 'MiniMax submit did not change page state', details: minimaxSubmit };
        }

        return { sent: true, method: minimaxSubmit.method };
    }

    if (provider === 'zai') {
        const zaiReady = await webContents.executeJavaScript(`
            (function() {
                const input = document.querySelector('textarea[placeholder*="Send a Message"], textarea');
                if (!input || input.offsetParent === null) return { found: false };
                input.focus();
                input.click();
                return { found: true };
            })()
        `).catch(() => ({ found: false }));

        if (!zaiReady.found) {
            return { sent: false, error: 'No Z.ai input field found' };
        }

        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        await sleep(150);

        if (typeof webContents.insertText === 'function') {
            await webContents.insertText(message);
        } else {
            for (const ch of message) {
                await webContents.sendInputEvent({ type: 'char', keyCode: ch });
                if (ch === '\n') {
                    await sleep(20);
                }
            }
        }

        await sleep(500);

        const zaiTyped = await webContents.executeJavaScript(`
            (function() {
                const input = document.querySelector('textarea[placeholder*="Send a Message"], textarea');
                const btn = document.querySelector('button.sendMessageButton, #send-message-button, button[type="submit"]');
                return {
                    value: input ? (input.value || '') : '',
                    href: location.href,
                    buttonVisible: !!(btn && (btn.offsetParent !== null || btn.getClientRects().length > 0)),
                    buttonDisabled: !!(btn && btn.disabled)
                };
            })()
        `).catch(() => ({ value: '' }));

        if (!zaiTyped.value || !zaiTyped.value.includes(message.substring(0, Math.min(16, message.length)))) {
            return { sent: false, error: 'Z.ai trusted typing did not populate the composer' };
        }

        const zaiSubmit = await webContents.executeJavaScript(`
            (function() {
                const input = document.querySelector('textarea[placeholder*="Send a Message"], textarea');
                const form = input ? input.closest('form') : null;
                const btn = document.querySelector('button.sendMessageButton, #send-message-button, button[type="submit"]');
                if (btn && !btn.disabled && (btn.offsetParent !== null || btn.getClientRects().length > 0)) {
                    btn.click();
                }
                if (form) {
                    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    if (typeof form.requestSubmit === 'function') form.requestSubmit(btn || undefined);
                }
                return { submitted: true };
            })()
        `).catch(e => ({ submitted: false, error: e.message }));

        if (!zaiSubmit.submitted) {
            return { sent: false, error: zaiSubmit.error || 'Failed to submit Z.ai form' };
        }

        const zaiNetworkResponse = await waitForProviderNetworkResponse(webContents, 'zai', 20000);
        if (zaiNetworkResponse) {
            return { sent: true, response: zaiNetworkResponse };
        }

        await sleep(2500);
        const zaiSentState = await webContents.executeJavaScript(`
            (function() {
                const input = document.querySelector('textarea[placeholder*="Send a Message"], textarea');
                const body = document.body?.innerText || '';
                return {
                    href: location.href,
                    value: input ? (input.value || '') : '',
                    includes: body.includes(${JSON.stringify(message.substring(0, Math.min(16, message.length)))}),
                    noResponseError: /No response,? Please try again later\./i.test(body),
                    body: body.slice(0, 1200)
                };
            })()
        `).catch(() => ({ href: '', value: '' }));

        const likelySent = (zaiSentState.href && zaiSentState.href.includes('/c/')) || zaiSentState.includes || zaiSentState.value === '';
        if (!likelySent) {
            return { sent: false, error: 'Z.ai submit did not change page state' };
        }

        if (zaiSentState.noResponseError) {
            return { sent: false, error: 'Z.ai returned: No response, Please try again later.' };
        }

        return { sent: true };
    }

    let inputFound = { found: false };
    for (let attempt = 0; attempt < 8; attempt++) {
        inputFound = await webContents.executeJavaScript(`
            (function() {
                const selectors = window.location.host.includes('deepseek')
                    ? ['textarea[placeholder*="DeepSeek"]', 'textarea']
                    : [
                        'textarea',
                        '[contenteditable="true"]',
                        '.ql-editor',
                        'rich-textarea .ql-editor',
                        'rich-textarea [contenteditable="true"]',
                        'input[type="text"]'
                    ];
                for (const selector of selectors) {
                    const input = document.querySelector(selector);
                    if (input && input.offsetParent !== null) {
                        input.focus();
                        input.click();
                        return { found: true, selector };
                    }
                }
                return { found: false };
            })()
        `).catch(() => ({ found: false }));

        if (inputFound.found) break;
        await sleep(750);
    }

    if (!inputFound.found) {
        return { sent: false, error: 'No input field found' };
    }

    await sleep(250);

    const typeResult = await webContents.executeJavaScript(`
        (function() {
            const text = ${JSON.stringify(message)};

            function setNativeValue(el, value) {
                const proto = el.tagName === 'TEXTAREA'
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && typeof desc.set === 'function') {
                    desc.set.call(el, value);
                } else {
                    el.value = value;
                }
            }

            function fireTextEvents(el, value) {
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                    setNativeValue(el, value);
                    el.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        cancelable: true,
                        data: value,
                        inputType: 'insertText'
                    }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ', code: 'Space' }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ', code: 'Space' }));
                    return { success: true, method: 'native-input', value: el.value || '' };
                }

                if (el.contentEditable === 'true' || el.isContentEditable) {
                    el.innerHTML = '';
                    const p = document.createElement('p');
                    p.textContent = value;
                    el.appendChild(p);
                    el.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        cancelable: true,
                        data: value,
                        inputType: 'insertText'
                    }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, method: 'contenteditable', value: el.innerText || '' };
                }

                return { success: false };
            }

            const preferred = window.location.host.includes('deepseek')
                ? document.querySelector('textarea[placeholder*="DeepSeek"], textarea')
                : null;
            if (preferred) {
                preferred.focus();
                return fireTextEvents(preferred, text);
            }

            const active = document.activeElement;
            if (active) {
                const result = fireTextEvents(active, text);
                if (result.success) return result;
            }

            const fallback = document.querySelector('textarea, [contenteditable="true"], .ql-editor, input[type="text"]');
            if (fallback) {
                fallback.focus();
                return fireTextEvents(fallback, text);
            }

            return { success: false };
        })()
    `);

    if (!typeResult.success) {
        return { sent: false, error: 'Failed to type message' };
    }

    await sleep(250);

    const clicked = await webContents.executeJavaScript(`
        (function() {
            const visible = btn => btn && (btn.offsetParent !== null || btn.getClientRects().length > 0);

            if (window.location.host.includes('xiaomimimo')) {
                const mimoBtn = document.querySelector('button[data-track-id="home_send_btn"], button[data-track-id*="send_btn"]');
                if (mimoBtn && visible(mimoBtn) && !mimoBtn.disabled) {
                    mimoBtn.click();
                    return { clicked: true, method: 'mimo-send-button' };
                }
            }

            if (window.location.host.includes('qwen.ai')) {
                const qwenBtn = document.querySelector('button.send-button');
                if (qwenBtn && visible(qwenBtn) && !qwenBtn.disabled) {
                    qwenBtn.click();
                    return { clicked: true, method: 'qwen-send-button' };
                }
            }

            if (window.location.host.includes('z.ai')) {
                const zaiBtn = document.querySelector('button.sendMessageButton');
                if (zaiBtn && visible(zaiBtn) && !zaiBtn.disabled) {
                    zaiBtn.click();
                    return { clicked: true, method: 'zai-send-button' };
                }
                const genericZai = Array.from(document.querySelectorAll('button')).find(btn => visible(btn) && !btn.disabled && /bg-black rounded-full|send/i.test((btn.className || '').toString() + ' ' + (btn.ariaLabel || '')));
                if (genericZai) {
                    genericZai.click();
                    return { clicked: true, method: 'zai-generic-button' };
                }
            }

            if (window.location.host.includes('deepseek')) {
                const ta = document.querySelector('textarea[placeholder*="DeepSeek"], textarea');
                if (ta) {
                    const composer = ta.closest('div');
                    const deepseekBtn = Array.from((composer?.parentElement || document).querySelectorAll('[role="button"]')).filter(el => {
                        const cls = (el.className || '').toString();
                        const ariaDisabled = el.getAttribute('aria-disabled');
                        return (el.offsetParent !== null || el.getClientRects().length > 0) &&
                               cls.includes('ds-icon-button') &&
                               !cls.includes('ds-toggle-button') &&
                               ariaDisabled !== 'true';
                    }).pop();
                    if (deepseekBtn) {
                        deepseekBtn.click();
                        return { clicked: true, method: 'deepseek-send-button' };
                    }
                    ta.focus();
                    ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    ta.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    const form = ta.closest('form');
                    if (form) {
                        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                    }
                    return { clicked: true, method: 'deepseek-enter-dispatch' };
                }
            }

            const buttons = Array.from(document.querySelectorAll('button')).filter(btn => visible(btn) && !btn.disabled);
            const sendButton = buttons.find(btn => {
                const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.innerText || '') + ' ' + (btn.getAttribute('data-track-id') || '')).toLowerCase();
                return label.includes('send') || label.includes('submit') || label.includes('ask') || label.includes('enter');
            });
            if (sendButton) {
                sendButton.click();
                return { clicked: true, method: 'generic-button' };
            }
            return { clicked: false };
        })()
    `).catch(() => ({ clicked: false }));

    if (!clicked.clicked) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        if (provider === 'deepseek') {
            await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
            await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
        }
    }

    return { sent: true };
}

// Wait for send button to be visible and enabled (after file upload)
async function waitForSendButtonReady(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) return false;

    // Gemini already handles file upload wait in uploadFileToProvider, skip here
    if (provider === 'gemini') {
        console.log(`[waitForSendButton] Gemini: Skipping (handled in file upload)`);
        return true;
    }

    console.log(`[waitForSendButton] Waiting for ${provider} send button...`);

    const maxWait = 10000; // 10 seconds max (reduced from 30)
    const checkInterval = 200; // faster checks
    let waited = 0;

    while (waited < maxWait) {
        const isReady = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                let sendBtn = null;
                
                if (host.includes('chatgpt') || host.includes('openai')) {
                    sendBtn = document.querySelector('[data-testid="send-button"]') ||
                              document.querySelector('button[aria-label*="Send"]');
                } else if (host.includes('claude')) {
                    sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                              document.querySelector('button:has(svg)');
                } else if (host.includes('gemini')) {
                    sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                              document.querySelector('button.send-button');
                } else if (host.includes('perplexity')) {
                    sendBtn = document.querySelector('button[aria-label*="Submit"]') ||
                              document.querySelector('button[type="submit"]');
                } else if (host.includes('qwen.ai')) {
                    sendBtn = document.querySelector('button.send-button') ||
                              document.querySelector('button[type="submit"]');
                } else if (host.includes('z.ai')) {
                    sendBtn = document.querySelector('button.sendMessageButton') ||
                              document.querySelector('button[type="submit"]');
                } else if (host.includes('kimi') || host.includes('minimax') || host.includes('xiaomimimo') || host.includes('qwen') || host.includes('z.ai') || host.includes('deepseek')) {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    sendBtn = buttons.find(btn => {
                        const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.innerText || '')).toLowerCase();
                        return label.includes('send') || label.includes('submit') || label.includes('ask');
                    }) || document.querySelector('button[type="submit"]');
                }
                
                if (sendBtn) {
                    const isDisabled = sendBtn.disabled || sendBtn.hasAttribute('disabled');
                    const isVisible = sendBtn.offsetParent !== null || sendBtn.offsetWidth > 0;
                    return !isDisabled && isVisible;
                }
                
                // No button found - might be ready for Enter key
                return true;
            })()
        `).catch(() => true);

        if (isReady) {
            console.log(`[waitForSendButton] ${provider}: Send button ready!`);
            return true;
        }

        await sleep(checkInterval);
        waited += checkInterval;
    }

    console.log(`[waitForSendButton] ${provider}: Timeout waiting for send button`);
    return false;
}

async function typeIntoPage(webContents, text) {
    // SIMPLE & RELIABLE: Directly set value via JavaScript
    // No clipboard permissions needed, works instantly

    await webContents.executeJavaScript(`
        (function() {
            const text = ${JSON.stringify(text)};
            const active = document.activeElement;
            
            if (active) {
                if (active.contentEditable === 'true') {
                    // ContentEditable (Claude, Gemini)
                    active.innerText = text;
                    active.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
                    // Textarea/Input (ChatGPT, Perplexity)
                    active.value = text;
                    active.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            
            // Also try by selector as backup
            const textarea = document.querySelector('#prompt-textarea') || 
                           document.querySelector('textarea[placeholder*="Ask"]') ||
                           document.querySelector('textarea');
            if (textarea && !textarea.value) {
                textarea.value = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            const contentEditable = document.querySelector('[contenteditable="true"]');
            if (contentEditable && !contentEditable.innerText.trim()) {
                contentEditable.innerText = text;
                contentEditable.dispatchEvent(new Event('input', { bubbles: true }));
            }
        })()
    `);

    // Small delay for UI to update
    await sleep(100);
}

async function getResponseWithTypingStatus(provider) {
    console.log(`[getResponseWithTyping] Starting for ${provider}...`);

    // CHECK API CACHE FIRST — if API already captured the response, skip DOM scraping entirely
    if (_apiResponseCache[provider]) {
        const cached = _apiResponseCache[provider];
        const looksLikeGeminiConversationId = provider === 'gemini' && /^c_[a-f0-9]+$/i.test((cached || '').trim());
        if (looksLikeGeminiConversationId) {
            console.log(`[getResponseWithTyping] Ignoring invalid Gemini API cache value: ${cached}`);
            delete _apiResponseCache[provider];
        } else {
            delete _apiResponseCache[provider]; // Clear after use
            console.log(`[getResponseWithTyping] \u2714 Using API-cached response for ${provider} (${cached.length} chars) — DOM scraping SKIPPED`);
            return {
                typingStarted: true,
                typingStopped: true,
                response: cached
            };
        }
    }

    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    if (provider === 'qwen' || provider === 'deepseek' || provider === 'zai') {
        const networkCaptured = await webContents.executeJavaScript(`
            (function() {
                const root = window.__proximaResponseCapture || {};
                const state = root[${JSON.stringify(provider)}];
                const response = state && typeof state.response === 'string' ? state.response.trim() : '';
                if (!response) return '';
                root[${JSON.stringify(provider)}] = {
                    response: '',
                    done: false,
                    source: '',
                    updatedAt: Date.now()
                };
                return response;
            })()
        `).catch(() => '');
        if (networkCaptured) {
            console.log(`[getResponseWithTyping] ✔ Using network-captured response for ${provider} (${networkCaptured.length} chars)`);
            return {
                typingStarted: true,
                typingStopped: true,
                response: networkCaptured
            };
        }
    }

    // Capture OLD fingerprint BEFORE getting response (for detecting new vs old responses)
    try {
        if (provider === 'perplexity') {
            const oldData = await webContents.executeJavaScript(`
                (function() {
                    const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                        .filter(block => {
                            const text = block.textContent.trim();
                            return text.length > 3 && 
                                   !text.toLowerCase().includes('perplexity pro') &&
                                   !text.includes('Ask anything') &&
                                   !text.includes('Ask a follow-up') &&
                                   !text.includes('Attach');
                        });
                    if (proseBlocks.length > 0) {
                        const lastBlock = proseBlocks[proseBlocks.length - 1];
                        return {
                            count: proseBlocks.length,
                            fingerprint: lastBlock.textContent.substring(0, 200).trim()
                        };
                    }
                    return { count: 0, fingerprint: '' };
                })()
            `).catch(() => ({ count: 0, fingerprint: '' }));
            responseState.perplexity.fingerprint = oldData.fingerprint;
            responseState.perplexity.blockCount = oldData.count;
            console.log(`[Perplexity] Old response data: { count: ${oldData.count}, fingerprint: '${oldData.fingerprint.substring(0, 50)}...' }`);
        } else if (provider === 'claude') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const selectors = [
                        '[data-is-streaming]', '.font-claude-message',
                        '[class*="claude"][class*="message"]',
                        '[class*="response"][class*="content"]',
                        '[class*="assistant"][class*="message"]'
                    ];
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        if (els.length > 0) {
                            return els[els.length - 1].textContent.substring(0, 200).trim();
                        }
                    }
                    const proseBlocks = document.querySelectorAll('.prose, [class*="prose"]');
                    if (proseBlocks.length > 0) {
                        return proseBlocks[proseBlocks.length - 1].textContent.substring(0, 200).trim();
                    }
                    return '';
                })()
            `).catch(() => '');
            responseState.claude.fingerprint = oldFp;
            console.log(`[Claude] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        } else if (provider === 'chatgpt') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
                    if (msgs.length > 0) {
                        return msgs[msgs.length - 1].textContent.substring(0, 200).trim();
                    }
                    return '';
                })()
            `).catch(() => '');
            responseState.chatgpt.fingerprint = oldFp;
            console.log(`[ChatGPT] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        } else if (provider === 'gemini') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const msgs = document.querySelectorAll('message-content, .message-content, [class*="response-content"]');
                    if (msgs.length > 0) {
                        return msgs[msgs.length - 1].textContent.substring(0, 200).trim();
                    }
                    return '';
                })()
            `).catch(() => '');
            responseState.gemini.fingerprint = oldFp;
            console.log(`[Gemini] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        } else if (provider === 'qwen') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    // For Qwen: capture the LAST meaningful message BEFORE thinking started
                    // Never capture "Thinking completed" as fingerprint
                    const msgs = document.querySelectorAll('.qwen-chat-message');
                    for (let i = msgs.length - 1; i >= 0; i--) {
                        const text = (msgs[i].textContent || '').trim();
                        if (text && text.length > 5 && !text.includes('Thinking completed')) {
                            return text.substring(0, 200);
                        }
                    }
                    // Fallback: capture anything that's not thinking
                    const body = (document.body?.textContent || '').trim();
                    return body.substring(0, 200);
                })()
            `).catch(() => '');
            responseState.qwen.fingerprint = oldFp;
            console.log(`[Qwen] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        } else if (provider === 'kimi' || provider === 'minimax' || provider === 'mimo' || provider === 'zai' || provider === 'deepseek') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const selectors = [
                        '[data-message-author-role="assistant"]',
                        '[data-testid*="assistant"]',
                        '[data-testid*="answer"]',
                        '[class*="assistant"][class*="message"]',
                        '[class*="response"]',
                        'article',
                        '.markdown',
                        '[class*="markdown"]',
                        '.prose',
                        '[class*="prose"]'
                    ];
                    for (const selector of selectors) {
                        const els = document.querySelectorAll(selector);
                        for (let i = els.length - 1; i >= 0; i--) {
                            const text = (els[i].innerText || els[i].textContent || '').trim();
                            if (text.length > 20) return text.substring(0, 200);
                        }
                    }
                    return '';
                })()
            `).catch(() => '');
            responseState[provider].fingerprint = oldFp;
            console.log(`[${provider}] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        }
    } catch (e) {
        console.error(`[getResponseWithTyping] Error capturing old fingerprint for ${provider}:`, e.message);
    }

    // Now get the actual response
    let response = await getProviderResponse(provider);

    if (provider === 'minimax') {
        const looksIncomplete = !response ||
            response === 'No response captured' ||
            /^Received\./i.test(response);

        if (looksIncomplete) {
            for (let attempt = 0; attempt < 3; attempt++) {
                await sleep(8000);
                const retry = await getSimpleProviderResponse(provider, '');
                if (retry && retry !== 'No response captured' && !/^Received\./i.test(retry)) {
                    response = retry;
                    break;
                }
            }
        }
    }

    // Clean Perplexity-specific noise (query heading echo, trailing UI elements)
    if (provider === 'perplexity' && response) {
        response = cleanPerplexityResponse(response);
    }

    return {
        typingStarted: response && response.length > 0,
        typingStopped: true,
        response
    };
}

function useSimpleDomCapture(provider) {
    return ['claude', 'gemini', 'kimi', 'minimax', 'mimo', 'qwen', 'zai', 'deepseek'].includes(provider);
}

function getSimpleCaptureSelectors(provider) {
    if (provider === 'claude') {
        return [
            '[data-testid="chat-message-turn"]',
            '[data-testid="assistant-turn"]',
            '[data-testid="ai-message"]',
            'div[data-turn-role="assistant"]',
            'div[data-role="assistant"]',
            'div[data-message-role="assistant"]',
            '.font-claude-message',
            '[class*="assistant"][class*="message"]',
            '.prose',
            '[class*="prose"]'
        ];
    }

    if (provider === 'gemini') {
        return [
            'message-content',
            '.message-content',
            '.model-response-text',
            '[class*="response-content"]',
            'model-response',
            '[class*="markdown"]'
        ];
    }

    if (provider === 'qwen') {
        return [
            '.response-message-content',
            '.phase-answer',
            '.qwen-markdown',
            '[class*="markdown"]',
            '.markdown',
            '[class*="response"]'
        ];
    }

    if (provider === 'minimax') {
        return [
            '.message.received .matrix-markdown',
            '.message.received .message-content',
            '.matrix-markdown',
            '.message.received'
        ];
    }

    return [
        '[data-message-author-role="assistant"]',
        '[data-testid*="assistant"]',
        '[data-testid*="answer"]',
        '[class*="assistant"][class*="message"]',
        '[class*="response"]',
        'article',
        '.markdown',
        '[class*="markdown"]',
        '.prose',
        '[class*="prose"]'
    ];
}

async function getSimpleProviderResponse(provider, oldFingerprint = '') {
    const webContents = browserManager.getWebContents(provider);
    const selectors = getSimpleCaptureSelectors(provider);
    const selectorJson = JSON.stringify(selectors);
    let lastText = '';
    let stableCount = 0;
    const stableThreshold = provider === 'claude' ? 4 : 3;

    async function getMiMoBodyFallback() {
        try {
            const body = await webContents.executeJavaScript(`
                (function() {
                    return (document.body && (document.body.innerText || document.body.textContent) || '').trim();
                })()
            `);
            const cleaned = (body || '')
                .replace(/\r/g, '')
                .replace(/Model demo platform\.[^\n]*/gi, '')
                .replace(/Citation sources\s*\(\d+\)/gi, '')
                .trim();
            const thoughtMatch = cleaned.match(/Thought for[^\n]*\n+([\s\S]{1,1000})$/i);
            if (thoughtMatch && thoughtMatch[1]) {
                return thoughtMatch[1].trim();
            }
            return '';
        } catch (e) {
            return '';
        }
    }

    for (let i = 0; i < 50; i++) {
        const text = await webContents.executeJavaScript(`
            (function() {
                const selectors = ${selectorJson};
                const isMiniMax = ${JSON.stringify(provider === 'minimax')};
                const badText = [
                    'thinking completed',
                    'stopped this response',
                    'model demo platform',
                    'citation sources',
                    'free trial',
                    'history'
                ];

                function isVisible(el) {
                    if (!el) return false;
                    if (el.offsetParent !== null) return true;
                    const style = window.getComputedStyle(el);
                    return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                }

                function normalize(text) {
                    let out = (text || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/Thinking completed\\s*/gi, '')
                        .replace(/Thought for[^\\n]*/gi, '')
                        .replace(/Stopped this response,?\\s*you can re-?edit[^\\n]*/gi, '')
                        .replace(/Model demo platform\.[^\\n]*/gi, '')
                        .replace(/Citation sources\\s*\\(\\d+\\)/gi, '')
                        .replace(/\\n{3,}/g, '\\n\\n')
                        .trim();
                    if (isMiniMax) {
                        out = out
                            .replace(/^Received\.[\s\S]{0,200}request[\s\S]*$/i, '')
                            .replace(/^Thinking Process\\s*\\n[^\\n]*\\n+/i, '')
                            .trim();
                    }
                    return out;
                }

                const candidates = [];
                for (const selector of selectors) {
                    const nodes = document.querySelectorAll(selector);
                    for (const node of nodes) {
                        if (!isVisible(node)) continue;
                        const text = normalize(node.innerText || node.textContent || '');
                        if (!text || text.length < 2) continue;
                        const lower = text.toLowerCase();
                        if (badText.some(x => lower === x || lower.startsWith(x + '\\n'))) continue;
                        if (isMiniMax && /^received\.[\s\S]{0,200}request[\s\S]*$/i.test(text)) continue;
                        if (/^(thinking|thought for|loading|generating|analyzing|searching)\\b/i.test(text) && text.length < 120) continue;
                        candidates.push(text);
                    }
                }

                for (let i = candidates.length - 1; i >= 0; i--) {
                    if (candidates[i] && candidates[i].length > 0) return candidates[i];
                }

                return '';
            })()
        `);

        const cleaned = (text || '').trim();
        if (cleaned) {
            const currentFingerprint = cleaned.substring(0, 200).trim();
            if (oldFingerprint) {
                const sameAsOld = currentFingerprint === oldFingerprint ||
                    oldFingerprint.startsWith(currentFingerprint.substring(0, Math.min(100, currentFingerprint.length))) ||
                    currentFingerprint.startsWith(oldFingerprint.substring(0, Math.min(100, oldFingerprint.length)));
                if (sameAsOld) {
                    await sleep(500);
                    continue;
                }
            }

            if (cleaned === lastText) {
                stableCount++;
                if (stableCount >= stableThreshold) {
                    if (responseState[provider]) {
                        responseState[provider].fingerprint = '';
                    }
                    console.log(`[getSimpleProviderResponse] ${provider}: captured ${cleaned.length} chars`);
                    return cleaned;
                }
            } else {
                lastText = cleaned;
                stableCount = 0;
            }
        }

        await sleep(500);
    }

    if ((!lastText || lastText === 'No response captured') && provider === 'mimo') {
        const mimoFallback = await getMiMoBodyFallback();
        if (mimoFallback) {
            console.log(`[getSimpleProviderResponse] mimo: body fallback captured ${mimoFallback.length} chars`);
            return mimoFallback;
        }
    }

    return lastText || 'No response captured';
}

async function getProviderResponse(provider, customSelector = null) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    console.log(`[getProviderResponse] ${provider}: Using DOM fallback path...`);

    // Get old fingerprint for detecting new responses
    let oldFingerprint = '';
    let oldBlockCount = 0;
    if (provider === 'perplexity') {
        oldFingerprint = responseState.perplexity.fingerprint || '';
        oldBlockCount = responseState.perplexity.blockCount || 0;
    } else if (provider === 'claude') {
        oldFingerprint = responseState.claude.fingerprint || '';
    } else if (provider === 'chatgpt') {
        oldFingerprint = responseState.chatgpt.fingerprint || '';
    } else if (provider === 'gemini') {
        oldFingerprint = responseState.gemini.fingerprint || '';
    } else if (provider === 'kimi' || provider === 'minimax' || provider === 'mimo' || provider === 'qwen' || provider === 'zai' || provider === 'deepseek') {
        oldFingerprint = responseState[provider].fingerprint || '';
    }

        // Smart typing wait — check if AI is currently typing, wait only if needed
        try {
            // Perplexity needs extra initial wait — it takes 2-4s to even START generating
            if (provider === 'perplexity') {
                await sleep(3000);
            }
            // Gemini thinking models take time before response starts
            if (provider === 'gemini') {
                await sleep(2000);
            }

            let typingDetected = false;
            const typingNow = await isAITyping(provider);
            if (typingNow.isTyping) {
                typingDetected = true;
            } else if (provider === 'perplexity' || provider === 'gemini' || provider === 'kimi' || provider === 'minimax' || provider === 'mimo' || provider === 'qwen' || provider === 'zai' || provider === 'deepseek') {
                // May not have started typing yet — retry a few times
                for (let retry = 0; retry < 6; retry++) {
                    await sleep(500);
                    const recheck = await isAITyping(provider);
                    if (recheck.isTyping) {
                        typingDetected = true;
                        break;
                    }
                }
            }

            if (typingDetected) {
                console.log(`[getProviderResponse] ${provider}: AI still typing, waiting...`);
                const maxTypingWait = (provider === 'claude') ? 600 : 120;
                let lastResponseSnap = '';
                let stableResponseCount = 0;
                for (let i = 0; i < maxTypingWait; i++) {
                    const ts = await isAITyping(provider);
                    if (!ts.isTyping) break;
                    
                    // Perplexity false positive fix: check if response text is stable
                    // If response hasn't changed for 5 checks (2.5s) while "typing", it's done
                    if (provider === 'perplexity' && i > 10) {
                        try {
                            const snap = await webContents.executeJavaScript(`
                                (function() {
                                    const blocks = document.querySelectorAll('[class*="prose"]:not(.prose-sm)');
                                    if (blocks.length > 0) return blocks[blocks.length-1].textContent.length.toString();
                                    return '0';
                                })()
                            `);
                            if (snap === lastResponseSnap && snap !== '0') {
                                stableResponseCount++;
                                if (stableResponseCount >= 5) {
                                    console.log(`[getProviderResponse] ${provider}: Response stable for 2.5s, breaking typing wait`);
                                    break;
                                }
                            } else {
                                stableResponseCount = 0;
                                lastResponseSnap = snap;
                            }
                        } catch(e) {}
                    }
                    
                    if (i % 20 === 0 && i > 0) {
                        console.log(`[getProviderResponse] ${provider}: Still typing (${i * 0.5}s)...`);
                    }
                    await sleep(500);
                }
            } else if (provider === 'perplexity') {
                // Even if no typing detected, Perplexity may have finished very fast
                await sleep(3000);
            }
        } catch (e) { }

        // Small delay for DOM to settle (Perplexity needs more time for math/LaTeX rendering)
        await sleep((provider === 'claude' || provider === 'perplexity') ? 1500 : 500);

    if (useSimpleDomCapture(provider)) {
        return await getSimpleProviderResponse(provider, oldFingerprint);
    }

    // STEP 4: DOM polling for response text
    let lastText = '';
        let stableCount = 0;
        // Perplexity math/LaTeX renders in stages — need more stability checks
        const STABLE_THRESHOLD = provider === 'perplexity' ? 5 : 3;
        const MAX_POLLS = (provider === 'claude' || provider === 'perplexity') ? 60 : 40;
        let foundNewResponse = false;


        // Poll for stable response
        for (let i = 0; i < MAX_POLLS; i++) {
            const text = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                
                // DOM to Markdown Converter
                const NL = String.fromCharCode(10);  // Actual newline character
                
                function domToMarkdown(element) {
                    if (!element) return '';
                    
                    let markdown = '';
                    const children = element.childNodes;
                    
                    for (let i = 0; i < children.length; i++) {
                        const node = children[i];
                        
                        // Text node
                        if (node.nodeType === 3) {
                            markdown += node.textContent;
                            continue;
                        }
                        
                        // Element node
                        if (node.nodeType === 1) {
                            const tag = node.tagName.toLowerCase();
                            
                            // Skip hidden elements
                            if (node.style && node.style.display === 'none') continue;
                            if (node.classList && node.classList.contains('sr-only')) continue;
                            
                            // Code blocks (pre > code)
                            if (tag === 'pre') {
                                const codeEl = node.querySelector('code');
                                // Use innerText to preserve visual line breaks (especially for ChatGPT)
                                // textContent doesn't preserve newlines when lines are in separate elements
                                const codeText = codeEl ? codeEl.innerText : node.innerText;
                                // Try to detect language from class
                                let lang = '';
                                const langClass = node.className.match(/language-(\\w+)/) || 
                                                 (codeEl && codeEl.className.match(/language-(\\w+)/));
                                if (langClass) lang = langClass[1];
                                // Also check for common language indicators
                                const langSpan = node.querySelector('[class*="lang"], [class*="language"]');
                                if (!lang && langSpan) {
                                    lang = langSpan.textContent.trim().toLowerCase();
                                }
                                // Check parent for language hint
                                const parentLang = node.closest('[class*="language-"]');
                                if (!lang && parentLang) {
                                    const match = parentLang.className.match(/language-(\\w+)/);
                                    if (match) lang = match[1];
                                }
                                // Use actual newlines
                                markdown += NL + NL + '\`\`\`' + lang + NL + codeText.trim() + NL + '\`\`\`' + NL + NL;
                                continue;
                            }
                            
                            // Inline code
                            if (tag === 'code' && !node.closest('pre')) {
                                markdown += '\`' + node.textContent + '\`';
                                continue;
                            }
                            
                            // Headers
                            if (tag === 'h1') {
                                markdown += NL + NL + '# ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            if (tag === 'h2') {
                                markdown += NL + NL + '## ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            if (tag === 'h3') {
                                markdown += NL + NL + '### ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            if (tag === 'h4') {
                                markdown += NL + NL + '#### ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            
                            // Paragraphs
                            if (tag === 'p') {
                                markdown += NL + NL + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            
                            // Bold
                            if (tag === 'strong' || tag === 'b') {
                                markdown += '**' + domToMarkdown(node) + '**';
                                continue;
                            }
                            
                            // Italic
                            if (tag === 'em' || tag === 'i') {
                                markdown += '*' + domToMarkdown(node) + '*';
                                continue;
                            }
                            
                            // Links
                            if (tag === 'a') {
                                const href = node.getAttribute('href');
                                const text = domToMarkdown(node);
                                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                                    markdown += '[' + text + '](' + href + ')';
                                } else {
                                    markdown += text;
                                }
                                continue;
                            }
                            
                            // Lists
                            if (tag === 'ul' || tag === 'ol') {
                                markdown += NL;
                                const items = node.querySelectorAll(':scope > li');
                                items.forEach((li, idx) => {
                                    const prefix = tag === 'ol' ? (idx + 1) + '. ' : '- ';
                                    markdown += prefix + domToMarkdown(li).trim() + NL;
                                });
                                markdown += NL;
                                continue;
                            }
                            
                            // Skip list items if already processed by parent
                            if (tag === 'li') {
                                markdown += domToMarkdown(node);
                                continue;
                            }
                            
                            // Line breaks
                            if (tag === 'br') {
                                markdown += NL;
                                continue;
                            }
                            
                            // Horizontal rule
                            if (tag === 'hr') {
                                markdown += NL + NL + '---' + NL + NL;
                                continue;
                            }
                            
                            // Blockquote
                            if (tag === 'blockquote') {
                                const lines = domToMarkdown(node).split(NL);
                                markdown += NL + lines.map(l => '> ' + l).join(NL) + NL;
                                continue;
                            }
                            
                            // Tables (basic support)
                            if (tag === 'table') {
                                const rows = node.querySelectorAll('tr');
                                rows.forEach((row, rowIdx) => {
                                    const cells = row.querySelectorAll('th, td');
                                    const cellTexts = Array.from(cells).map(c => c.textContent.trim());
                                    markdown += '| ' + cellTexts.join(' | ') + ' |' + NL;
                                    if (rowIdx === 0 && row.querySelector('th')) {
                                        markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |' + NL;
                                    }
                                });
                                markdown += NL;
                                continue;
                            }
                            
                            // Div and other containers - recurse
                            if (tag === 'div' || tag === 'span' || tag === 'section' || tag === 'article') {
                                markdown += domToMarkdown(node);
                                continue;
                            }
                            
                            // Default: just get text content for unknown elements
                            markdown += domToMarkdown(node);
                        }
                    }
                    
                    return markdown;
                }
                
                // Clean up markdown (remove excessive newlines)
                function cleanMarkdown(md) {
                    // Use RegExp with the actual NL character
                    const excessiveNL = new RegExp(NL + '{4,}', 'g');
                    return md
                        .replace(excessiveNL, NL + NL + NL)  // Max 3 newlines
                        .replace(/^\\s+/, '')                // Trim start
                        .replace(/\\s+$/, '')                // Trim end
                        .trim();
                }
                
                // ChatGPT specific - use [data-message-author-role="assistant"]
                if (host.includes('chatgpt') || host.includes('openai')) {
                    const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
                    if (assistantMsgs.length > 0) {
                        const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastMsg));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    // Fallback to article > .prose
                    const articles = document.querySelectorAll('article');
                    for (let j = articles.length - 1; j >= 0; j--) {
                        const article = articles[j];
                        const content = article.querySelector('.prose, .markdown, [class*="markdown"]');
                        if (content) {
                            const markdown = cleanMarkdown(domToMarkdown(content));
                            if (markdown && markdown.length > 0 && !markdown.includes('__oai_')) return markdown;
                        }
                    }
                }
                
                // Perplexity specific - Capture the FULL last/newest answer
                if (host.includes('perplexity')) {
                    // Get all prose blocks
                    const allProseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                        .filter(block => {
                            const text = block.textContent.trim();
                            return text.length > 3 && 
                                   !text.toLowerCase().includes('perplexity pro') &&
                                   !text.includes('Ask anything') &&
                                   !text.includes('Ask a follow-up') &&
                                   !text.includes('Attach');
                        });
                    
                    if (allProseBlocks.length > 0) {
                        // Get the LAST prose block
                        const lastBlock = allProseBlocks[allProseBlocks.length - 1];
                        
                        // Go UP to find the largest container that is still just ONE answer
                        let answerContainer = lastBlock;
                        let bestContainer = lastBlock;
                        let bestLength = lastBlock.textContent.length;
                        let parent = lastBlock.parentElement;
                        
                        for (let i = 0; i < 10 && parent; i++) {
                            // Stop conditions — only stop at true page boundaries
                            if (parent.tagName === 'MAIN' || parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
                            if (parent.querySelector('textarea, input[type="text"]')) break;
                            
                            const parentLength = parent.textContent.length;
                            
                            // Use this parent if it has more content but isn't too big
                            if (parentLength > bestLength && parentLength < 50000) {
                                bestContainer = parent;
                                bestLength = parentLength;
                            }
                            
                            parent = parent.parentElement;
                        }
                        
                        // Convert to markdown
                        const markdown = cleanMarkdown(domToMarkdown(bestContainer));
                        if (markdown && markdown.length > 5) {
                            return markdown;
                        }
                    }
                    
                    return '';
                }
                
                // Claude specific - handles normal text AND artifact/code responses
                // Claude has TWO panels: left=chat text, right=artifact code panel
                if (host.includes('claude')) {
                    let chatResponse = '';
                    let artifactCode = '';
                    
                    // === PART A: Capture chat text (left panel) ===
                    
                    // A0: Try to find individual turn/message containers first
                    // Claude 2026 uses individual turn containers for each message
                    const turnSelectors = [
                        '[data-testid="chat-message-turn"]',
                        '[data-testid="assistant-turn"]',
                        '[data-testid="ai-message"]',
                        'div[data-turn-role="assistant"]',
                        'div[data-role="assistant"]',
                        'div[data-message-role="assistant"]'
                    ];
                    
                    for (const sel of turnSelectors) {
                        const turns = document.querySelectorAll(sel);
                        if (turns.length > 0) {
                            const lastTurn = turns[turns.length - 1];
                            const md = cleanMarkdown(domToMarkdown(lastTurn));
                            if (md && md.length > chatResponse.length) {
                                chatResponse = md;
                            }
                        }
                    }
                    
                    // A1: Try modern Claude UI selectors for chat messages
                    if (chatResponse.length < 50) {
                        const chatSelectors = [
                            '[data-is-streaming]',
                            '.font-claude-message',
                            '[class*="claude"][class*="message"]',
                            '[class*="response"][class*="content"]',
                            '[class*="assistant"][class*="message"]'
                        ];
                        
                        for (const sel of chatSelectors) {
                            const elements = document.querySelectorAll(sel);
                            if (elements.length > 0) {
                                const lastEl = elements[elements.length - 1];
                                const md = cleanMarkdown(domToMarkdown(lastEl));
                                if (md && md.length > chatResponse.length) {
                                    chatResponse = md;
                                }
                            }
                        }
                    }
                    
                    // A2: Try prose blocks for chat
                    if (chatResponse.length < 50) {
                        const proseBlocks = document.querySelectorAll('.prose, [class*="prose"]');
                        if (proseBlocks.length > 0) {
                            const lastBlock = proseBlocks[proseBlocks.length - 1];
                            const md = cleanMarkdown(domToMarkdown(lastBlock));
                            if (md && md.length > chatResponse.length) {
                                chatResponse = md;
                            }
                        }
                    }

                    // A3: Fallback for chat - find message-like containers
                    // IMPORTANT: Never grab the full conversation container
                    if (chatResponse.length < 50) {
                        const allDivs = document.querySelectorAll('div[class]');
                        let candidates = [];
                        for (const div of allDivs) {
                            const text = div.innerText || '';
                            if (text.length < 100) continue;
                            
                            // Skip sidebar/navigation content
                            const sidebarKeywords = ['New chat', 'Chats', 'Projects', 'Recents', 'All chats', 'Free plan', 'Artifacts', 'Hide', 'Code'];
                            let sidebarScore = 0;
                            for (const kw of sidebarKeywords) {
                                if (text.includes(kw)) sidebarScore++;
                            }
                            if (sidebarScore >= 3) continue;
                            
                            if (div.closest('nav, header, footer, aside, [class*="sidebar"], [class*="nav"], [class*="menu"], [class*="drawer"], [class*="panel"][class*="left"]')) continue;
                            const className = div.className || '';
                            if (className.includes('sidebar') || className.includes('nav') || className.includes('menu') || className.includes('drawer') || className.includes('conversation-list')) continue;
                            if (div.querySelector('textarea, input[type="text"]')) continue;
                            if (text.includes('Claude can make mistakes') && text.length < 200) continue;
                            
                            candidates.push({ el: div, text: text, len: text.length });
                        }
                        
                        // Sort by length, pick a reasonable-sized candidate (not the mega-container)
                        candidates.sort((a, b) => a.len - b.len);
                        // Pick the SMALLEST candidate that is > 100 chars - more likely to be a single message
                        for (const c of candidates) {
                            if (c.len > 100 && c.len < 5000) {
                                chatResponse = cleanMarkdown(c.text);
                                break;
                            }
                        }
                        // If nothing small found, use last candidate but clean it
                        if (chatResponse.length < 50 && candidates.length > 0) {
                            chatResponse = candidates[candidates.length - 1].text;
                            chatResponse = cleanMarkdown(chatResponse);
                        }
                    }
                    
                    // A4: POST-PROCESSING - Detect and clean full conversation captures
                    // If response includes timestamps like "4:43 AM" or "10:30 PM", 
                    // it means we grabbed the full conversation. Extract only the last response.
                    if (chatResponse.length > 0) {
                        const tsPattern = new RegExp('\\d{1,2}:\\d{2}\\s*(AM|PM)', 'gi');
                        const hasTimestamps = tsPattern.test(chatResponse);
                        
                        if (hasTimestamps) {
                            // Split by timestamp pattern to get individual messages
                            const splitPattern = new RegExp('\\d{1,2}:\\d{2}\\s*(AM|PM)', 'gi');
                            const parts = chatResponse.split(splitPattern);
                            
                            // Filter out short parts (user messages are typically short)
                            // and take the LAST substantial part (the latest AI response)
                            let lastResponse = '';
                            for (let i = parts.length - 1; i >= 0; i--) {
                                const part = (parts[i] || '').trim();
                                // Skip empty, very short (user msgs), and AM/PM artifacts
                                if (!part || part.length < 20) continue;
                                if (part === 'AM' || part === 'PM') continue;
                                lastResponse = part;
                                break;
                            }
                            
                            if (lastResponse.length > 20) {
                                chatResponse = cleanMarkdown(lastResponse);
                            }
                        }
                    }
                    
                    // === PART B: Capture artifact code (right side panel) ===
                    // Claude opens artifacts in a side panel with code/preview
                    
                    // B1: Look for the artifact viewer panel
                    // Artifact panel selectors - it's a separate panel from the chat
                    const artifactSelectors = [
                        '[data-testid="artifact-view"]',
                        '[class*="artifact-renderer"]', 
                        '[class*="artifact-content"]',
                        '[class*="artifact"][class*="panel"]',
                        '[class*="artifact"][class*="viewer"]',
                        '[class*="code-editor"]',
                        '[class*="artifact"]'
                    ];
                    
                    let artifactPanel = null;
                    let artifactTitle = '';
                    
                    for (const sel of artifactSelectors) {
                        const panels = document.querySelectorAll(sel);
                        if (panels.length > 0) {
                            // Use the last/most recent artifact panel
                            artifactPanel = panels[panels.length - 1];
                            // Try to get artifact title
                            const titleEl = artifactPanel.querySelector('[class*="title"], [class*="name"], [class*="header"] span, h1, h2, h3');
                            if (titleEl) artifactTitle = titleEl.textContent.trim();
                            break;
                        }
                    }
                    
                    // B2: Extract code from artifact panel
                    if (artifactPanel) {
                        // Look for code elements in the artifact panel
                        const codeElements = artifactPanel.querySelectorAll('pre code, pre, code, [class*="code-block"], [class*="CodeMirror"], [class*="monaco"]');
                        for (const codeEl of codeElements) {
                            const codeText = codeEl.innerText || codeEl.textContent || '';
                            if (codeText.trim().length > artifactCode.length) {
                                artifactCode = codeText.trim();
                            }
                        }
                        
                        // If no code elements found, try innerText of the whole panel
                        if (artifactCode.length < 10) {
                            const panelText = artifactPanel.innerText || '';
                            if (panelText.length > 50) {
                                artifactCode = panelText;
                            }
                        }
                    }
                    
                    // B3: If no artifact panel found, search ENTIRE page for big code blocks
                    // that aren't in the chat area
                    if (artifactCode.length < 10) {
                        const allPres = document.querySelectorAll('pre, code');
                        let biggestCode = '';
                        for (const pre of allPres) {
                            const text = pre.innerText || '';
                            // Only grab substantial code blocks (likely artifacts)
                            if (text.length > 100 && text.length > biggestCode.length) {
                                biggestCode = text;
                            }
                        }
                        if (biggestCode.length > 100) {
                            artifactCode = biggestCode;
                        }
                    }
                    
                    // B4: Also try to find ALL artifact cards/buttons in the chat
                    // and extract their titles (even if code is in side panel)
                    const artifactButtons = document.querySelectorAll('button[class*="artifact"], [class*="artifact-block"], [data-component-name*="Artifact"]');
                    let artifactTitles = [];
                    artifactButtons.forEach(btn => {
                        const title = btn.textContent.trim();
                        if (title && title.length > 2 && title.length < 200) {
                            artifactTitles.push(title);
                        }
                    });
                    
                    // === PART C: Combine chat text + artifact code ===
                    let fullResponse = chatResponse;
                    
                    if (artifactCode && artifactCode.length > 10) {
                        // Detect language from title
                        let lang = '';
                        const titleLower = (artifactTitle || '').toLowerCase();
                        if (titleLower.includes('.jsx') || titleLower.includes('.tsx') || titleLower.includes('react')) lang = 'jsx';
                        else if (titleLower.includes('.js')) lang = 'javascript';
                        else if (titleLower.includes('.ts')) lang = 'typescript';
                        else if (titleLower.includes('.py')) lang = 'python';
                        else if (titleLower.includes('.html')) lang = 'html';
                        else if (titleLower.includes('.css')) lang = 'css';
                        else if (titleLower.includes('.json')) lang = 'json';
                        else if (titleLower.includes('.md')) lang = 'markdown';
                        
                        // Add artifact code to response
                        if (artifactTitle) {
                            fullResponse += NL + NL + '**Artifact: ' + artifactTitle + '**' + NL;
                        }
                        fullResponse += NL + '\`\`\`' + lang + NL + artifactCode + NL + '\`\`\`' + NL;
                    }
                    
                    // Add artifact title list if we found buttons but no code
                    if (artifactTitles.length > 0 && artifactCode.length < 10) {
                        fullResponse += NL + NL + '**Artifacts created:**' + NL;
                        artifactTitles.forEach(t => {
                            fullResponse += '- ' + t + NL;
                        });
                    }
                    
                    if (fullResponse && fullResponse.length > 0) return cleanMarkdown(fullResponse);
                }
                
                // Gemini specific - updated selectors
                if (host.includes('gemini') || host.includes('google')) {
                    // 1. Try message-content elements (Gemini's main container)
                    const msgContent = document.querySelectorAll('message-content, .message-content, [class*="response-content"]');
                    if (msgContent.length > 0) {
                        const lastMsg = msgContent[msgContent.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastMsg));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    
                    // 2. Try model response containers
                    const modelResponses = document.querySelectorAll('.model-response, [class*="model-response"], [class*="response-container"]');
                    if (modelResponses.length > 0) {
                        const lastResponse = modelResponses[modelResponses.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastResponse));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    
                    // 3. Try markdown containers
                    const markdownContainers = document.querySelectorAll('[class*="markdown"], .markdown-content');
                    if (markdownContainers.length > 0) {
                        const lastMd = markdownContainers[markdownContainers.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastMd));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    
                    // 4. Try response-container-content (newer Gemini)
                    const responseContent = document.querySelectorAll('[class*="response"][class*="content"]');
                    if (responseContent.length > 0) {
                        const lastResp = responseContent[responseContent.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastResp));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                }

                // Qwen specific - capture the markdown content div directly
                if (host.includes('qwen')) {
                    // Qwen renders response inside .qwen-markdown div
                    // The div is empty until content is streamed in
                    // Use response-message-content textContent as primary source
                    const respContent = document.querySelector('.response-message-content');
                    if (respContent) {
                        const rawText = (respContent.textContent || '').trim();
                        // Skip "Thinking completed" placeholder and very short content
                        if (rawText.length > 25 && !rawText.includes('Thinking completed')) {
                            return rawText;
                        }
                    }
                    // Fallback: check the phase-answer div's direct text (no recursion)
                    const phaseDiv = document.querySelector('.phase-answer');
                    if (phaseDiv) {
                        const childTexts = [];
                        for (let i = 0; i < phaseDiv.children.length; i++) {
                            const childText = phaseDiv.children[i].textContent || '';
                            if (childText.trim().length > 25 && !childText.includes('Thinking completed')) {
                                childTexts.push(childText.trim());
                            }
                        }
                        if (childTexts.length > 0) {
                            return childTexts.join('\n').substring(0, 2000);
                        }
                    }
                    // Fallback: try qwen-markdown (last resort)
                    const qwenMarkdown = document.querySelector('.qwen-markdown');
                    if (qwenMarkdown) {
                        const markdown = cleanMarkdown(domToMarkdown(qwenMarkdown));
                        if (markdown && markdown.length > 25 && !markdown.includes('Thinking completed')) {
                            return markdown;
                        }
                    }
                }

                // Kimi / MiniMax / MiMo - generic modern chat extraction
                if (host.includes('kimi') || host.includes('minimax') || host.includes('xiaomimimo') || host.includes('qwen') || host.includes('z.ai') || host.includes('deepseek')) {
                    const selectors = [
                        '[data-message-author-role="assistant"]',
                        '[data-testid*="assistant"]',
                        '[data-testid*="answer"]',
                        '[class*="assistant"][class*="message"]',
                        '[class*="response"]',
                        'article',
                        '.markdown',
                        '[class*="markdown"]',
                        '.prose',
                        '[class*="prose"]'
                    ];

                    for (const selector of selectors) {
                        const elements = document.querySelectorAll(selector);
                        for (let i = elements.length - 1; i >= 0; i--) {
                            const el = elements[i];
                            const markdown = cleanMarkdown(domToMarkdown(el));
                            if (markdown && markdown.length > 20) return markdown;
                        }
                    }
                }
                
                return '';
            })()
        `);


            if (text && text.length > 0) {
                // For Perplexity: Check if this is actually a NEW response (not the old one)
                if (provider === 'perplexity' && !foundNewResponse) {
                    // Get current block count and fingerprint
                    const currentData = await webContents.executeJavaScript(`
                    (function() {
                        const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                            .filter(block => {
                                const text = block.textContent.trim();
                                return text.length > 3 && 
                                       !text.toLowerCase().includes('perplexity pro') &&
                                       !text.includes('Ask anything') &&
                                       !text.includes('Ask a follow-up') &&
                                       !text.includes('Attach');
                            });
                        if (proseBlocks.length > 0) {
                            const lastBlock = proseBlocks[proseBlocks.length - 1];
                            return {
                                count: proseBlocks.length,
                                fingerprint: lastBlock.textContent.substring(0, 200).trim()
                            };
                        }
                        return { count: 0, fingerprint: '' };
                    })()
                `).catch(() => ({ count: 0, fingerprint: '' }));

                    const currentBlockCount = currentData.count;
                    const currentFingerprint = currentData.fingerprint;

                    // NEW response detected if block count increased OR fingerprint changed
                    const blockCountIncreased = oldBlockCount > 0 && currentBlockCount > oldBlockCount;
                    const fingerprintChanged = oldFingerprint &&
                        currentFingerprint !== oldFingerprint &&
                        !oldFingerprint.startsWith(currentFingerprint.substring(0, 100)) &&
                        !currentFingerprint.startsWith(oldFingerprint.substring(0, 100));

                    if (blockCountIncreased || fingerprintChanged) {

                        foundNewResponse = true;
                    } else if (oldFingerprint || oldBlockCount > 0) {

                        await sleep(500);
                        continue;
                    } else {
                        // No old fingerprint/count means this is first response
                        foundNewResponse = true;
                    }
                }

                // Qwen-specific response detection
                // IMPORTANT: Keep polling until real content appears
                // The problem: initial capture returns "Thinking completed"
                // We must NOT break on thinking-complete; continue waiting
                if (provider === 'qwen') {
                    const qwenStatus = await webContents.executeJavaScript(`
                        (function() {
                            const rc = document.querySelector('.response-message-content');
                            if (!rc) return { hasAnswer: false, text: '' };
                            const text = (rc.textContent || '').trim();
                            // Real answer: content is > 25 chars and NOT just "Thinking completed"
                            return { hasAnswer: text.length > 25 && !text.includes('Thinking completed'), text: text };
                        })()
                    `).catch(() => ({ hasAnswer: false, text: '' }));

                    if (qwenStatus.hasAnswer) {
                        // Answer is ready - directly capture from response-message-content
                        const answerText = await webContents.executeJavaScript(`
                            (function() {
                                const rc = document.querySelector('.response-message-content');
                                if (!rc) return '';
                                const allText = (rc.textContent || '').trim();
                                return allText.replace(/Thinking completed\s*/gi, '').trim();
                            })()
                        `).catch(() => '');
                        return answerText || 'No response captured';
                    } else {
                        // Still thinking or no content yet - keep polling
                        // Do NOT break, continue the loop
                        await sleep(1000);
                        continue;
                    }
                }

                // For non-Perplexity providers: make sure this is a NEW response
                if (provider !== 'perplexity' && provider !== 'qwen' && oldFingerprint && !foundNewResponse) {
                    const currentFingerprint = text.substring(0, 200).trim();
                    if (currentFingerprint === oldFingerprint ||
                        oldFingerprint.startsWith(currentFingerprint.substring(0, 100)) ||
                        currentFingerprint.startsWith(oldFingerprint.substring(0, 100))) {

                        await sleep(500);
                        continue;
                    } else {

                        foundNewResponse = true;
                    }
                }

                if (text === lastText) {
                    stableCount++;
                    if (stableCount >= STABLE_THRESHOLD) {
                        console.log('[getProviderResponse] ✓ Captured (' + text.length + ' chars)');
                        // Clear the old fingerprint after successful capture
                        if (provider === 'perplexity') {
                            responseState.perplexity.fingerprint = '';
                            responseState.perplexity.blockCount = 0;
                        }
                        if (responseState[provider]) {
                            responseState[provider].fingerprint = '';
                        }
                        return text;
                    }
                } else {
                    stableCount = 0;
                    lastText = text;
                }
            }

            await sleep(500);
        }

        return lastText || 'No response captured';
}

// Clean Perplexity response — strip query heading echo and trailing UI noise
function cleanPerplexityResponse(text) {
    if (!text || text.length === 0) return text;
    
    // First: strip inline trailing noise (DOM often concatenates without newlines)
    // Pattern: "15 sourcesFollow-ups..." or "10 sourcesDeep research..."
    text = text.replace(/\d+\s*sources?(?:Follow-up|Deep research|Related|Who |What |How |Why |When |Where |Which |Can |Is |Are |Do |Does |Should ).*/si, '').trim();
    
    // Strip inline citation markers like "wikipedia+2", "geeksforgeeks+1", "docs.docker+2"
    text = text.replace(/[a-z0-9._-]+\+\d+/gi, '').trim();
    
    const lines = text.split('\n');
    
    // Strip leading lines that are query echoes:
    // 1. Lines starting with # (markdown heading)
    // 2. Lines ending with ? (question echo without #)
    // 3. Empty lines
    while (lines.length > 0) {
        const trimmed = lines[0].trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            lines.shift();
        } else if (trimmed.endsWith('?') && trimmed.length < 200) {
            // Looks like a question echo — strip it
            lines.shift();
        } else {
            break;
        }
    }
    
    // Strip trailing UI noise (line-separated patterns)
    while (lines.length > 0) {
        const lastLine = lines[lines.length - 1].trim().toLowerCase();
        if (lastLine === '' || 
            /^\d+\s*sources?$/i.test(lastLine) ||
            lastLine.startsWith('follow-up') ||
            lastLine.startsWith('follow up') ||
            lastLine.startsWith('deep research') ||
            lastLine.startsWith('related')) {
            lines.pop();
        } else {
            break;
        }
    }
    
    return lines.join('\n').trim();
}
async function startNewConversation(provider) {
    // Reset API-level conversation state (clears stored conversation IDs in inject scripts)
    const webContents = browserManager.getWebContents(provider);
    if (webContents) {
        try {
            await providerAPI.resetConversation(provider, () => webContents);
        } catch (e) {
            console.error(`[startNewConversation] API reset failed for ${provider}:`, e.message);
        }
    }

    // Navigate to provider home/chat page to start fresh UI
    const config = browserManager.providers[provider];
    if (config) {
        await browserManager.navigate(provider, config.url);
        if (provider === 'mimo') {
            await sleep(4000);
        }
    }
}

// Typing Detection for All Providers

async function isAITyping(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        return { isTyping: false, error: 'Provider not initialized' };
    }

    try {
        const result = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                
                // ChatGPT typing detection
                if (host.includes('chatgpt') || host.includes('openai')) {
                    // Check for streaming indicator, stop button, or thinking indicator
                    const stopButton = document.querySelector('button[aria-label*="Stop"]');
                    const streamingDots = document.querySelector('[class*="streaming"]');
                    const thinkingIndicator = document.querySelector('[class*="typing"], [class*="thinking"]');
                    const resultStreaming = document.querySelector('[data-message-author-role="assistant"] [class*="result-streaming"]');
                    
                    if (stopButton || streamingDots || thinkingIndicator || resultStreaming) {
                        return { isTyping: true, provider: 'chatgpt' };
                    }
                }
                
                // Claude typing detection - must detect ALL generation states
                // including artifact creation which can take 2-5 minutes
                if (host.includes('claude')) {
                    // Check for stop button (appears during ALL generation)
                    const stopButton = document.querySelector('button[aria-label="Stop generating"], button[aria-label="Stop Response"], button[aria-label="Stop"]');
                    
                    // Check for streaming indicator attribute
                    const streamingIndicator = document.querySelector('[data-is-streaming="true"]');
                    
                    // Check for the orange loading spinner (claude's thinking indicator)
                    const loadingSpinner = document.querySelector('.animate-spin, [class*="loading-spinner"], [class*="animate-pulse"]');
                    
                    // Check for artifact creation in progress - the dotted orange circle
                    const artifactProgress = document.querySelector('[class*="artifact"][class*="loading"], [class*="artifact"][class*="progress"], [class*="generating"]');
                    
                    // Check for "thinking" or "writing" status text
                    const statusText = document.querySelector('[class*="status"], [class*="thinking"]');
                    const isThinking = statusText && (statusText.textContent.includes('thinking') || statusText.textContent.includes('writing') || statusText.textContent.includes('Generating'));
                    
                    if (stopButton && stopButton.offsetParent !== null) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (streamingIndicator) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (loadingSpinner && loadingSpinner.offsetParent !== null) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (artifactProgress) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (isThinking) {
                        return { isTyping: true, provider: 'claude' };
                    }
                }
                
                // Perplexity typing detection
                if (host.includes('perplexity')) {
                    // 1. Stop button (most reliable — only appears during generation)
                    const stopButton = document.querySelector('button[aria-label="Stop"]');
                    if (stopButton && stopButton.offsetParent !== null) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                    
                    // 2. "Searching" text/indicator
                    const searchingIndicator = document.querySelector('[data-testid*="searching"]');
                    if (searchingIndicator && searchingIndicator.offsetParent !== null) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                    
                    // 3. Active spinners ONLY inside the answer area (not sidebar/nav/ads)
                    const answerArea = document.querySelector('[class*="prose"], [class*="answer"], main');
                    if (answerArea) {
                        const spinners = answerArea.querySelectorAll('.animate-spin, [class*="animate-pulse"]');
                        for (const sp of spinners) {
                            if (sp.offsetParent !== null) {
                                return { isTyping: true, provider: 'perplexity' };
                            }
                        }
                    }
                    
                    // 4. Streaming/thinking dots (tight selectors only)
                    const thinkingDots = document.querySelector('[class*="thinking"], [class*="generating"], [class*="streaming"]');
                    if (thinkingDots && thinkingDots.offsetParent !== null && !thinkingDots.closest('nav, header, [class*="sidebar"]')) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                    
                    // 5. Step counter — only match active "Searching/Reading/Analyzing" text
                    //    (NOT [class*="source"] which matches the permanent Sources section)
                    const stepIndicators = document.querySelectorAll('[class*="step"]');
                    for (const si of stepIndicators) {
                        const text = si.textContent || '';
                        if ((text.includes('Searching') || text.includes('Reading') || text.includes('Analyzing') || text.includes('Thinking')) && si.offsetParent !== null) {
                            return { isTyping: true, provider: 'perplexity' };
                        }
                    }
                    
                    // 6. SVG animation inside answer area only
                    if (answerArea) {
                        const animatedSvg = answerArea.querySelector('svg[class*="animate"], circle[class*="animate"], svg.animate-spin');
                        if (animatedSvg && animatedSvg.offsetParent !== null) {
                            return { isTyping: true, provider: 'perplexity' };
                        }
                    }
                }
                
                // Gemini typing detection — check response completion via action buttons
                if (host.includes('gemini') || host.includes('google')) {
                    // APPROACH: Gemini shows action buttons (👍👎🔄📋) ONLY when response is DONE
                    // If we find a response area WITHOUT these buttons → still generating
                    
                    // 1. Check for stop button (visible during generation)
                    const allButtons = document.querySelectorAll('button');
                    for (const btn of allButtons) {
                        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if ((label.includes('stop') || label.includes('cancel')) && btn.offsetParent !== null) {
                            return { isTyping: true, provider: 'gemini' };
                        }
                    }
                    
                    // 2. Check for mat-spinner
                    const matSpinner = document.querySelector('mat-spinner');
                    if (matSpinner && matSpinner.offsetParent !== null) {
                        return { isTyping: true, provider: 'gemini' };
                    }
                    
                    // 3. Check for "Answer now" text (only present during thinking phase)
                    for (const btn of allButtons) {
                        const text = btn.textContent.trim();
                        if (text === 'Answer now' && btn.offsetParent !== null) {
                            return { isTyping: true, provider: 'gemini' };
                        }
                    }
                    
                    // 4. Check for active thinking/streaming indicators  
                    const thinkLabels = document.querySelectorAll('[class*="thinking"], [class*="Thinking"]');
                    for (const el of thinkLabels) {
                        if (el.offsetParent !== null && el.textContent.includes('hinking')) {
                            return { isTyping: true, provider: 'gemini' };
                        }
                    }
                    
                    // 5. Response completion check: find last response container
                    //    If it exists but has NO action buttons (👍👎) → still generating
                    const responseContainers = document.querySelectorAll(
                        'model-response, .model-response-text, [class*="response-container"], message-content, .message-content'
                    );
                    if (responseContainers.length > 0) {
                        const lastResp = responseContainers[responseContainers.length - 1];
                        // Action buttons have thumbs up/down icons — check for them
                        const actionBtns = lastResp.parentElement ?
                            lastResp.parentElement.querySelectorAll('button[aria-label*="ood"], button[aria-label*="ad"], button[aria-label*="opy"], button[aria-label*="hare"], button[aria-label*="odify"], button[aria-label*="etry"]') :
                            lastResp.querySelectorAll('button');
                        // If we have the response container but < 2 action buttons → still generating
                        if (actionBtns.length < 2) {
                            // Double-check: make sure this isn't an old completed response
                            // by checking if the text is very short (thinking placeholder)
                            const text = lastResp.textContent.trim();
                            if (text.length < 100 || text.includes('Answer now') || text.includes('Refining') || text.includes('Analyzing')) {
                                return { isTyping: true, provider: 'gemini' };
                            }
                        }
                    }
                }

                // Kimi / MiniMax / MiMo typing detection
                if (host.includes('kimi') || host.includes('minimax') || host.includes('xiaomimimo') || host.includes('qwen') || host.includes('z.ai') || host.includes('deepseek')) {
                    const stopButton = document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"]');
                    if (stopButton && stopButton.offsetParent !== null) {
                        return { isTyping: true, provider: host };
                    }

                    const busyIndicators = document.querySelectorAll('[class*="typing"], [class*="thinking"], [class*="generating"], [class*="streaming"], .animate-spin, [class*="loading"]');
                    for (const el of busyIndicators) {
                        if (el.offsetParent !== null && !el.closest('nav, header, aside')) {
                            return { isTyping: true, provider: host };
                        }
                    }

                    const responseCandidates = document.querySelectorAll('[data-testid*="answer"], [class*="response"], article, .markdown, [class*="markdown"], .prose, [class*="prose"]');
                    if (responseCandidates.length > 0) {
                        const lastResp = responseCandidates[responseCandidates.length - 1];
                        const text = (lastResp.innerText || lastResp.textContent || '').trim();
                        if (text.length < 80 && /thinking|analyzing|loading|generating/i.test(text)) {
                            return { isTyping: true, provider: host };
                        }
                    }
                }
                
                return { isTyping: false };
            })()
        `);

        return result;
    } catch (e) {
        return { isTyping: false, error: e.message };
    }
}

// NOTE: getResponseWithTypingStatus is defined above (near line 1193)
// with full fingerprint capture logic. Do NOT redefine it here.


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// IPC Handlers for UI

ipcMain.handle('get-settings', () => {
    return loadSettings();
});

ipcMain.handle('save-settings', (event, settings) => {
    saveSettings(settings);
    return { success: true };
});

ipcMain.handle('save-enabled-providers', () => {
    const settings = loadSettings();
    saveEnabledProviders(settings);
    return { success: true };
});

ipcMain.handle('init-provider', async (event, provider) => {
    try {
        // Restore backed up cookies before creating the view
        const config = browserManager.providers[provider];
        if (config) {
            const ses = session.fromPartition(config.partition, { cache: true });
            const restored = await restoreCookies(provider, ses);
            if (restored) {
                console.log(`[${provider}] Cookies restored from backup`);
            }
        }

        browserManager.createView(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('show-provider', async (event, provider) => {
    try {
        const bounds = await mainWindow.webContents.executeJavaScript(`
            (function() {
                const container = document.getElementById('browser-container');
                if (container) {
                    const rect = container.getBoundingClientRect();
                    return {
                        x: Math.round(rect.left),
                        y: Math.round(rect.top),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    };
                }
                return { x: 0, y: 100, width: 1200, height: 700 };
            })()
        `);

        browserManager.showProvider(provider, bounds);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('hide-browser', () => {
    browserManager.hideCurrentView();
    return { success: true };
});

ipcMain.handle('check-login-status', async (event, provider) => {
    try {
        const loggedIn = await browserManager.isLoggedIn(provider);
        return { success: true, provider, loggedIn };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('reload-provider', async (event, provider) => {
    try {
        await browserManager.reload(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('go-back', async (event, provider) => {
    try {
        const ok = await browserManager.goBack(provider);
        return { success: ok, provider, error: ok ? null : 'No back history available' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('go-forward', async (event, provider) => {
    try {
        const ok = await browserManager.goForward(provider);
        return { success: ok, provider, error: ok ? null : 'No forward history available' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-mcp-config', () => {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
    const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'src', 'mcp-server-v3.js');

    const isDev = !app.isPackaged;
    const serverPath = isDev
        ? path.join(__dirname, '..', 'src', 'mcp-server-v3.js')
        : unpackedPath;

    return {
        mcpServers: {
            'proxima': {
                command: 'node',
                args: [serverPath.replace(/\\/g, '/')]
            }
        }
    };
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
    clipboard.writeText(text);
    return { success: true };
});

ipcMain.handle('read-clipboard', () => {
    return clipboard.readText();
});

// Read clipboard from a specific provider's BrowserView renderer
// This works because the BrowserView renderer IS the focused document for its webContents
ipcMain.handle('read-provider-clipboard', async (event, provider) => {
    try {
        const webContents = browserManager.getWebContents(provider);
        if (!webContents || webContents.isDestroyed()) {
            return { success: false, error: 'Provider view not available' };
        }
        // Execute clipboard read in the provider's renderer context
        // This SHOULD work because this webContents is the focused document
        const text = await webContents.executeJavaScript(`
            (async () => {
                try {
                    return await navigator.clipboard.readText();
                } catch (e) {
                    return 'CLIPBOARD_ERR:' + e.message;
                }
            })()
        `);
        return { success: true, text };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
    return { success: true };
});

ipcMain.handle('get-ipc-port', () => {
    const settings = loadSettings();
    return settings.ipcPort || 19222;
});

// Open provider in system browser (for login when embedded browser is blocked)
ipcMain.handle('open-in-system-browser', (event, provider) => {
    const urls = {
        perplexity: 'https://www.perplexity.ai/',
        chatgpt: 'https://chat.openai.com/',
        claude: 'https://claude.ai/',
        gemini: 'https://gemini.google.com/',
        qwen: 'https://chat.qwen.ai/',
        zai: 'https://z.ai/',
        deepseek: 'https://chat.deepseek.com/'
    };
    if (urls[provider]) {
        shell.openExternal(urls[provider]);
        return { success: true, provider };
    }
    return { success: false, error: 'Unknown provider' };
});

// Cookie-based Authentication for Gemini etc.

ipcMain.handle('set-cookies', async (event, provider, cookiesJson) => {
    try {
        const config = browserManager.providers[provider];
        if (!config) {
            return { success: false, error: 'Unknown provider' };
        }

        // Parse cookies from JSON (exported from cookie extensions)
        let cookies;
        try {
            cookies = JSON.parse(cookiesJson);
        } catch (e) {
            return { success: false, error: 'Invalid JSON format. Please paste valid cookie JSON.' };
        }

        if (!Array.isArray(cookies)) {
            return { success: false, error: 'Cookies should be an array. Try exporting from EditThisCookie or Cookie-Editor extension.' };
        }

        // Get the session for this provider
        const ses = session.fromPartition(config.partition, { cache: true });

        // Clear existing cookies for this domain first
        const existingCookies = await ses.cookies.get({});
        for (const cookie of existingCookies) {
            try {
                const url = `http${cookie.secure ? 's' : ''}://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}${cookie.path || '/'}`;
                await ses.cookies.remove(url, cookie.name);
            } catch (e) {
                // Ignore individual cookie removal errors
            }
        }

        // Calculate default expiration: 1 year from now (in seconds since epoch)
        // Short expiry (like 2 days) causes random logouts — use long expiry
        const oneYearFromNow = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);

        // Set the new cookies
        let setCount = 0;
        let errorCount = 0;
        for (const cookie of cookies) {
            try {
                // Build the URL for setting the cookie
                const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                const url = `http${cookie.secure !== false ? 's' : ''}://${domain}${cookie.path || '/'}`;

                // Prepare cookie object for Electron
                const cookieDetails = {
                    url: url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly === true,
                    sameSite: cookie.sameSite || 'no_restriction'
                };

                // IMPORTANT: Always set an expirationDate!
                // Without it, cookies become "session cookies" and get deleted on app close
                if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000) {
                    cookieDetails.expirationDate = cookie.expirationDate;
                } else {
                    // Default: expire in 1 year (was 2 days — too short!)
                    cookieDetails.expirationDate = oneYearFromNow;
                }

                await ses.cookies.set(cookieDetails);
                setCount++;
            } catch (e) {
                console.error(`[Cookie] Failed to set cookie ${cookie.name}:`, e.message);
                errorCount++;
            }
        }

        console.log(`[Cookie] Set ${setCount} cookies for ${provider}, ${errorCount} failed`);

        // Backup cookies to file for restoration on next app start
        await backupCookies(provider, ses);

        // Flush cookies to disk immediately
        await ses.cookies.flushStore();

        // Reload the provider view to apply cookies
        const view = browserManager.views.get(provider);
        if (view && !view.webContents.isDestroyed()) {
            await view.webContents.loadURL(config.url);
        }

        return {
            success: true,
            message: `Successfully set ${setCount} cookies. ${errorCount > 0 ? `(${errorCount} failed)` : ''} Reloading...`,
            setCount,
            errorCount
        };
    } catch (e) {
        console.error('[Cookie] Error:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-cookies', async (event, provider) => {
    try {
        const config = browserManager.providers[provider];
        if (!config) {
            return { success: false, error: 'Unknown provider' };
        }

        const ses = session.fromPartition(config.partition, { cache: true });
        const cookies = await ses.cookies.get({});

        // Filter cookies for the provider's domain
        const providerDomains = {
            perplexity: 'perplexity.ai',
            chatgpt: 'openai.com',
            claude: 'claude.ai',
            gemini: 'google.com',
            kimi: 'kimi.com',
            minimax: 'minimax.io',
            mimo: 'xiaomimimo.com',
            qwen: 'qwen.ai',
            zai: 'z.ai',
            deepseek: 'deepseek.com'
        };

        const domain = providerDomains[provider];
        const filteredCookies = cookies.filter(c => c.domain.includes(domain));

        return {
            success: true,
            cookies: filteredCookies,
            count: filteredCookies.length
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// File Reference Feature

let fileReferenceEnabled = true;

ipcMain.handle('set-file-reference-enabled', (event, enabled) => {
    fileReferenceEnabled = enabled;
    console.log('[FileReference] File reference:', enabled ? 'ENABLED' : 'DISABLED');
    return { success: true, enabled };
});

ipcMain.handle('get-file-reference-enabled', () => {
    return { success: true, enabled: fileReferenceEnabled };
});

// REST API Server Toggle

ipcMain.handle('set-rest-api-enabled', (event, enabled) => {
    const settings = loadSettings();
    settings.restApiEnabled = enabled;
    saveSettings(settings);

    if (enabled) {
        if (!isRestAPIRunning()) {
            startRestAPI();
        }
        console.log('[REST API] ⚡ REST API ENABLED — http://localhost:3210');
    } else {
        stopRestAPI();
        console.log('[REST API] ⏹ REST API DISABLED');
    }
    return { success: true, enabled, running: isRestAPIRunning() };
});

ipcMain.handle('get-rest-api-enabled', () => {
    const settings = loadSettings();
    return { success: true, enabled: !!settings.restApiEnabled, running: isRestAPIRunning() };
});

ipcMain.handle('install-cli', async () => {
    try {
        const { exec } = require('child_process');

        // CLI path: works in both dev (npm start) and installed (.exe) mode
        const asarPath = path.join(app.getAppPath() + '.unpacked', 'cli', 'proxima-cli.cjs');
        const devPath = path.join(app.getAppPath(), 'cli', 'proxima-cli.cjs');
        const cliSource = fs.existsSync(asarPath) ? asarPath : devPath;

        // Bin directory in user's AppData
        const binDir = path.join(app.getPath('userData'), 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        // Create proxima.cmd wrapper
        fs.writeFileSync(path.join(binDir, 'proxima.cmd'), `@echo off\r\nnode "${cliSource}" %*`);

        // Add to user PATH via PowerShell
        const escaped = binDir.replace(/\\/g, '\\\\');
        const ps = `$p=[Environment]::GetEnvironmentVariable('Path','User');if($p -notlike '*${escaped}*'){[Environment]::SetEnvironmentVariable('Path',$p+';${escaped}','User')}`;
        await new Promise((resolve) => {
            exec(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true }, () => resolve());
        });

        return { success: true, path: binDir };
    } catch (err) {
        console.error('[CLI Install]', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('is-cli-installed', () => {
    const binDir = path.join(app.getPath('userData'), 'bin');
    const cmdPath = path.join(binDir, 'proxima.cmd');
    return fs.existsSync(cmdPath);
});

ipcMain.handle('uninstall-cli', async () => {
    try {
        const { exec } = require('child_process');
        const binDir = path.join(app.getPath('userData'), 'bin');
        const cmdPath = path.join(binDir, 'proxima.cmd');

        // Delete proxima.cmd
        if (fs.existsSync(cmdPath)) fs.unlinkSync(cmdPath);

        // Remove from user PATH via PowerShell
        const escaped = binDir.replace(/\\/g, '\\\\');
        const ps = `$p=[Environment]::GetEnvironmentVariable('Path','User');$p=($p -split ';'|Where-Object{$_ -ne '${escaped}'})-join';';[Environment]::SetEnvironmentVariable('Path',$p,'User')`;
        await new Promise((resolve) => {
            exec(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true }, () => resolve());
        });

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// Check if file is attached in chat
async function checkFileAttachment(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) return false;

    return await webContents.executeJavaScript(`
        (function() {
            const indicators = [
                '[data-testid*="attachment"]',
                '[data-testid*="file"]',
                '[aria-label*="attachment"]',
                '[aria-label*="file"]',
                '[aria-label*="Remove"]',
                '.attachment',
                '.file-chip',
                'button[aria-label*="Remove"]',
                '[data-filename]',
                '.uploaded-file',
                '[data-testid="file-thumbnail"]',
                '[data-testid="composer-attachment"]',
                '.file-preview-container'
            ];
            
            for (const sel of indicators) {
                if (document.querySelector(sel)) {
                    console.log('[FileCheck] Found:', sel);
                    return true;
                }
            }
            return false;
        })()
    `);
}

// Upload file to AI provider chat using file input manipulation
async function uploadFileToProvider(provider, filePath) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }



    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // Check file size limit (25MB max to avoid memory issues with base64)
    const fileStats = fs.statSync(filePath);
    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
    if (fileStats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${(fileStats.size / 1024 / 1024).toFixed(1)}MB. Maximum is 25MB.`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString('base64');
    const fileMimeType = getMimeType(filePath);

    console.log(`[FileReference] Uploading ${fileName} via file input method...`);

    // Method 1: Find and click attach button, then set file input
    const uploadResult = await webContents.executeJavaScript(`
        (async function() {
            const fileName = ${JSON.stringify(fileName)};
            const fileBase64 = ${JSON.stringify(fileBase64)};
            const fileMimeType = ${JSON.stringify(fileMimeType)};
            

            
            // Convert base64 to File
            function base64ToFile(base64, filename, mimeType) {
                const byteCharacters = atob(base64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: mimeType });
                return new File([blob], filename, { type: mimeType });
            }
            
            const file = base64ToFile(fileBase64, fileName, fileMimeType);

            
            // Create DataTransfer with file
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            
            const host = window.location.host;
            let fileInput = null;
            let attachButton = null;
            
            // Find file input or attach button based on provider
            if (host.includes('claude')) {
                // Claude: Look for attach button first
                attachButton = document.querySelector('button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Add"]');
                if (attachButton) {

                    attachButton.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                fileInput = document.querySelector('input[type="file"]');
            } else if (host.includes('chatgpt')) {
                attachButton = document.querySelector('button[aria-label*="Attach"], button[data-testid*="attach"]');
                if (attachButton) {

                    attachButton.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                fileInput = document.querySelector('input[type="file"]');
            } else if (host.includes('gemini')) {
                // Gemini: Use clipboard paste (Ctrl+V) since no hidden file input exists

                
                // Focus the input area first
                const inputArea = document.querySelector('rich-textarea, .ql-editor, [contenteditable="true"], textarea');
                if (inputArea) {
                    inputArea.focus();
                    inputArea.click();

                    
                    // Create clipboard data with file
                    const clipboardData = new DataTransfer();
                    clipboardData.items.add(file);
                    
                    // Create and dispatch paste event
                    const pasteEvent = new ClipboardEvent('paste', {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: clipboardData
                    });
                    
                    inputArea.dispatchEvent(pasteEvent);

                    
                    // Wait 2 seconds for file to be ready (simple and reliable)
                    await new Promise(r => setTimeout(r, 2000));
                    
                    // Re-focus input
                    inputArea.focus();
                    inputArea.click();
                    
                    return {
                        success: true,
                        fileName,
                        mimeType: fileMimeType,
                        fileAttached: true,
                        method: 'clipboard-paste'
                    };
                } else {

                    return { success: false, error: 'Input area not found', fileAttached: false };
                }
            } else if (host.includes('perplexity')) {
                // Perplexity: Click attach button first, then find file input
                attachButton = document.querySelector('button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Upload"], button[aria-label*="Add file"], [data-testid*="attach"]');
                if (attachButton) {

                    attachButton.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                fileInput = document.querySelector('input[type="file"]');
            }
            
            // If no file input found, search all inputs
            if (!fileInput) {

                const allInputs = document.querySelectorAll('input[type="file"]');

                fileInput = allInputs[0];
            }
            
            if (!fileInput) {

                return { success: false, error: 'No file input found', fileAttached: false };
            }
            

            
            // Set files on input
            fileInput.files = dataTransfer.files;
            
            // Dispatch events
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            

            
            // Wait for upload
            await new Promise(r => setTimeout(r, 2000));
            
            // Check if attached
            const indicators = [
                '[data-testid*="attachment"]',
                '[data-testid*="file"]',
                '[aria-label*="Remove"]',
                '.attachment',
                '.file-chip',
                '[data-filename]',
                '.uploaded-file',
                '[data-testid="file-thumbnail"]',
                '[data-testid="composer-attachment"]'
            ];
            
            let fileAttached = false;
            for (const sel of indicators) {
                if (document.querySelector(sel)) {

                    fileAttached = true;
                    break;
                }
            }
            
            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                fileAttached,
                method: 'file-input'
            };
        })()
    `);


    return uploadResult;
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.txt': 'text/plain',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.jsx': 'text/javascript',
        '.tsx': 'text/typescript',
        '.py': 'text/x-python',
        '.html': 'text/html',
        '.css': 'text/css',
        '.json': 'application/json',
        '.md': 'text/markdown',
        '.xml': 'text/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.csv': 'text/csv',
        '.zip': 'application/zip'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// App Lifecycle

app.whenReady().then(createWindow);

// Backup all cookies before quitting
app.on('before-quit', async (event) => {
    if (browserManager && !browserManager.isDestroyed) {
        for (const provider of browserManager.getInitializedProviders()) {
            try {
                const config = browserManager.providers[provider];
                if (config) {
                    const ses = session.fromPartition(config.partition, { cache: true });
                    await ses.cookies.flushStore();
                    await backupCookies(provider, ses);
                }
            } catch (e) {
                console.error(`[Quit] Cookie backup failed for ${provider}:`, e.message);
            }
        }
        console.log('[Quit] All cookies backed up');
    }
});

app.on('window-all-closed', () => {
    if (ipcServer) {
        ipcServer.close();
    }
    stopRestAPI();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// Handle certificate errors for some AI sites
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    // Allow certificate for known AI provider domains
    const trustedDomains = ['perplexity.ai', 'openai.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'gemini.google.com', 'accounts.google.com'];
    const urlObj = new URL(url);
    if (trustedDomains.some(domain => urlObj.hostname.includes(domain))) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});
