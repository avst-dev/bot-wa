require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Groq } = require('groq-sdk');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- KONFIGURASI & MIDDLEWARE ---
const SESSION_ROOT = path.join(__dirname, 'sesi_login');
const STATE_FILE = path.join(__dirname, 'bot_state.json'); // File untuk simpan status on/off
if (!fs.existsSync(SESSION_ROOT)) fs.mkdirSync(SESSION_ROOT, { recursive: true });

const sanitizeId = (id) => id.replace(/[^a-zA-Z0-9_\-]/g, '');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'avst_secret_key',
    resave: false,
    saveUninitialized: true
}));
app.use(express.static(path.join(__dirname, 'public')));

const apiKeys = process.env.GROQ_API_KEYS ? process.env.GROQ_API_KEYS.split(',') : [];
let currentKeyIndex = 0;
const bots = {};
const botStatus = {}; 
const chatMemory = {};

// --- FUNGSI PERSISTENCE ---
function saveBotStates() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botStatus, null, 2));
}

function loadBotStates() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            Object.assign(botStatus, data);
        } catch (e) {
            console.error("Gagal memuat status bot");
        }
    }
}

loadBotStates();

function getGroqInstance() {
    if (apiKeys.length === 0) return null;
    const groq = new Groq({ apiKey: apiKeys[currentKeyIndex].trim() });
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return groq;
}

function getTuning() {
    try {
        return fs.readFileSync(path.join(__dirname, 'tunning.txt'), 'utf-8');
    } catch (e) {
        return "Kamu adalah AI asisten.";
    }
}

// --- CORE BOT LOGIC ---
async function startBot(botId) {
    const sessionDir = path.join(SESSION_ROOT, botId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['BOT Manager', 'Chrome', '1.0.0']
    });

    bots[botId] = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const qrDataURL = await QRCode.toDataURL(qr);
            io.emit('qr_update', { botId, qr: qrDataURL });
        }
        if (connection === 'open') {
            // Jika belum ada di status, default set ke true
            if (botStatus[botId] === undefined) {
                botStatus[botId] = true;
                saveBotStates();
            }
            io.emit('bot_connected', { botId });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot(botId);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const remoteJid = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text;

        // CEK STATUS ON/OFF: Logika utama agar saklar berfungsi
        if (!text || botStatus[botId] === false) return;

        try {
            const groq = getGroqInstance();
            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: getTuning() }, { role: "user", content: text }],
                model: "llama-3.1-8b-instant",
            });

            const reply = completion.choices[0].message.content;
            await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
        } catch (e) {
            console.error("AI Error");
        }
    });
}

// --- AUTO LOAD SESSION ---
if (fs.existsSync(SESSION_ROOT)) {
    fs.readdirSync(SESSION_ROOT).forEach(botId => {
        if (fs.lstatSync(path.join(SESSION_ROOT, botId)).isDirectory()) {
            startBot(botId);
        }
    });
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/dashboard', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.post('/login', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        return res.redirect('/dashboard');
    }
    res.send('<script>alert("Salah!"); window.location="/";</script>');
});

// --- API ENDPOINTS ---
app.get('/api/active-bots', (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({error: "Unauthorized"});
    res.json(Object.keys(bots).map(id => ({ botId: id, status: botStatus[id] !== false })));
});

app.post('/api/create-bot', (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({error: "Unauthorized"});
    if (req.body.botId) startBot(sanitizeId(req.body.botId));
    res.json({ status: 'ok' });
});

app.post('/api/toggle-bot', (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({error: "Unauthorized"});
    const { botId, status } = req.body;
    botStatus[botId] = status;
    saveBotStates(); // Simpan status permanen
    res.json({ success: true });
});

app.delete('/api/delete-bot/:botId', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({error: "Unauthorized"});
    const botId = sanitizeId(req.params.botId);
    try {
        if (bots[botId]) {
            await bots[botId].logout().catch(() => {});
            bots[botId].end();
            delete bots[botId];
        }
        delete botStatus[botId];
        saveBotStates();
        const sessionPath = path.join(SESSION_ROOT, botId);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.listen(process.env.PORT || 3000, () => console.log('BOT Manager Online'));
