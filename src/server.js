import express from "express";
import dotenv from "dotenv";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import crypto from "crypto";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Paths / Storage
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const MSG_UPLOADS_DIR = path.join(UPLOADS_DIR, "messages");
const DB_PATH = path.join(DATA_DIR, "messages.json");

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const RECIPIENTS_PATH = path.join(DATA_DIR, "recipients.json");
const STATE_PATH = path.join(DATA_DIR, "dispatch_state.json");

function loadRecipients() {
  try {
    if (!fs.existsSync(RECIPIENTS_PATH)) return [];
    const arr = JSON.parse(fs.readFileSync(RECIPIENTS_PATH, "utf-8") || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveRecipients(recipients) {
  fs.writeFileSync(RECIPIENTS_PATH, JSON.stringify(recipients, null, 2), "utf-8");
}

function upsertRecipient(chatId) {
  const id = Number(chatId);
  if (!id) return;
  const recipients = loadRecipients();
  if (!recipients.includes(id)) {
    recipients.push(id);
    saveRecipients(recipients);
  }
}

function loadDispatchState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { index: 0 };
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8") || "{}");
    return { index: Number(s.index) || 0 };
  } catch {
    return { index: 0 };
  }
}

function saveDispatchState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function intervalToMs({ intervalValue, intervalUnit }) {
  const v = Math.max(1, Number(intervalValue) || 1);
  const day = 24 * 60 * 60 * 1000;
  if (intervalUnit === "days") return v * day;
  return v * 7 * day; // weeks
}

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return { intervalValue: 1, intervalUnit: "weeks" }; // по умолчанию 1 неделя
    }
    const obj = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8") || "{}");
    return {
      intervalValue: Number(obj.intervalValue) || 1,
      intervalUnit: obj.intervalUnit === "days" ? "days" : "weeks",
    };
  } catch (e) {
    console.error("Failed to load settings.json:", e);
    return { intervalValue: 1, intervalUnit: "weeks" };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MSG_UPLOADS_DIR, { recursive: true });

// ===== Helpers: normalize old formats -> images: [filename]
function normalizeMessage(msg) {
  const out = { ...msg };

  // Собираем все варианты, где могли храниться картинки
  const raw =
    (Array.isArray(out.images) && out.images) ||
    (Array.isArray(out.files) && out.files) ||
    [];

  const images = raw
    .map((x) => {
      if (typeof x === "string") {
        // "abc.jpg" или "/uploads/messages/abc.jpg"
        return path.basename(x);
      }
      if (x && typeof x === "object") {
        if (x.filename) return path.basename(x.filename);
        if (x.url) return path.basename(x.url);
        if (x.path) return path.basename(x.path);
      }
      return null;
    })
    .filter(Boolean);

  out.images = images;

  // Можно оставить out.files для совместимости, но лучше не использовать дальше.
  // delete out.files;

  // Гарантируем даты
  if (!out.createdAt) out.createdAt = Date.now();
  if (!out.updatedAt) out.updatedAt = out.createdAt;

  return out;
}

function loadMessages() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const arr = JSON.parse(fs.readFileSync(DB_PATH, "utf-8") || "[]");
    return (Array.isArray(arr) ? arr : []).map(normalizeMessage);
  } catch (e) {
    console.error("Failed to load messages.json:", e);
    return [];
  }
}

function saveMessages(messages) {
  fs.writeFileSync(DB_PATH, JSON.stringify(messages, null, 2), "utf-8");
}

// ===== Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());

// ===== Sessions
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // secure: true, // включим когда будет https
    },
  })
);

// ===== View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

// Раздача загруженных файлов
app.use("/uploads", express.static(UPLOADS_DIR));

// ===== Admin path
const ADMIN_PATH = process.env.ADMIN_PATH || "/admin";

function requireLogin(req, res, next) {
  if (req.session?.admin === true) return next();
  return res.redirect(`${ADMIN_PATH}/login`);
}

// ===== Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MSG_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeExt = ext.slice(0, 20);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB на файл
});

// ===== Auth
app.get(`${ADMIN_PATH}/login`, (req, res) => {
  res.render("login", { error: null, adminPath: ADMIN_PATH });
});

app.post(`${ADMIN_PATH}/login`, (req, res) => {
  const { username, password } = req.body || {};

  const envUser = (process.env.ADMIN_USER || "").trim();
  const envPass = (process.env.ADMIN_PASS || "").trim();
  const ok =
    (username || "").trim() === envUser &&
    (password || "").trim() === envPass;

  if (!ok) {
    return res.status(401).render("login", {
      error: "Неверный логин или пароль",
      adminPath: ADMIN_PATH,
    });
  }

  req.session.admin = true;
  return res.redirect(ADMIN_PATH);
});

app.get(`${ADMIN_PATH}/logout`, (req, res) => {
  req.session.destroy(() => res.redirect(`${ADMIN_PATH}/login`));
});

// ===== Admin main
app.get(ADMIN_PATH, requireLogin, (req, res) => {
  const messages = loadMessages().sort((a, b) => b.createdAt - a.createdAt);
  res.render("admin", { messages, editing: null });
});

app.post(`${ADMIN_PATH}/settings`, requireLogin, (req, res) => {
  const intervalValue = Math.max(1, Math.min(365, Number(req.body?.intervalValue || 1)));
  const intervalUnit = req.body?.intervalUnit === "days" ? "days" : "weeks";

  saveSettings({ intervalValue, intervalUnit });
  return res.redirect(ADMIN_PATH);
});

// ===== Create message (ВАЖНО: сохраняем images как filenames)
app.post(
  `${ADMIN_PATH}/messages`,
  requireLogin,
  upload.array("files", 100),
  (req, res) => {
    const text = (req.body?.text || "").trim();
    const filenames = (req.files || []).map((f) => f.filename);

    const messages = loadMessages();
    const id = crypto.randomBytes(8).toString("hex");

    messages.push({
      id,
      text,
      images: filenames, // <-- единый формат
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    saveMessages(messages);
    return res.redirect(ADMIN_PATH);
  }
);

// ===== Edit page
app.get(`${ADMIN_PATH}/messages/:id/edit`, requireLogin, (req, res) => {
  const { id } = req.params;

  const messages = loadMessages();
  const msg = messages.find((m) => m.id === id);

  if (!msg) return res.status(404).send("Message not found");
  return res.render("edit", { msg, adminPath: ADMIN_PATH });
});

// ===== Update (replace/delete per image + add extra)
app.post(
  `${ADMIN_PATH}/messages/:id`,
  requireLogin,
  upload.any(),
  (req, res) => {
    const { id } = req.params;
    const { text } = req.body || {};

    const messages = loadMessages();
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) return res.status(404).send("Message not found");

    const msg = messages[idx];
    msg.images = Array.isArray(msg.images) ? msg.images : [];

    if (typeof text === "string") msg.text = text;

    // файлы по fieldname (replace_0, replace_1...)
    const filesByField = {};
    for (const f of req.files || []) {
      filesByField[f.fieldname] = f;
    }

    const oldImages = [...msg.images];
    const newImages = [...oldImages];

    for (let i = 0; i < oldImages.length; i++) {
      const removeKey = `remove_${i}`;
      const replaceKey = `replace_${i}`;

      const checked =
        req.body?.[removeKey] === "on" || req.body?.[removeKey] === "1";

      if (!checked) continue;

      // удалить старый файл
      const oldFile = oldImages[i];
      try {
        fs.unlinkSync(path.join(MSG_UPLOADS_DIR, oldFile));
      } catch {}

      // заменить или удалить
      if (filesByField[replaceKey]) {
        newImages[i] = filesByField[replaceKey].filename;
      } else {
        newImages[i] = null;
      }
    }

    msg.images = newImages.filter(Boolean);

    // дополнительные файлы (name="files" multiple)
    const extra = (req.files || [])
      .filter((f) => f.fieldname === "files")
      .map((f) => f.filename);

    if (extra.length) msg.images = [...msg.images, ...extra];

    msg.updatedAt = Date.now();
    saveMessages(messages);

    return res.redirect(ADMIN_PATH);
  }
);

// ===== Delete message
app.post(`${ADMIN_PATH}/messages/:id/delete`, requireLogin, (req, res) => {
  const { id } = req.params;

  const messages = loadMessages();
  const msg = messages.find((m) => m.id === id);
  if (!msg) return res.status(404).send("Message not found");

  const imgs = msg.images || [];
  for (const file of imgs) {
    try {
      fs.unlinkSync(path.join(MSG_UPLOADS_DIR, file));
    } catch {}
  }

  const next = messages.filter((m) => m.id !== id);
  saveMessages(next);

  return res.redirect(ADMIN_PATH);
});

// --- Bitrix settings (пока не используем, но оставим)
const PORT = Number(process.env.PORT || 3000);
const BITRIX_APP_TOKEN = process.env.BITRIX_APP_TOKEN || "";
const X_HOOK_SECRET = process.env.BITRIX_WEBHOOK_SECRET || "";

app.get("/", (req, res) => res.status(200).send("Server is running"));
app.get("/bitrix/webhook", (req, res) => res.status(200).send("OK (use POST here)"));
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});

// ===== MAX WEBHOOK =====
app.post("/max/webhook", async (req, res) => {
  try {
    console.log("MAX update:", JSON.stringify(req.body, null, 2));
    const update = req.body;

    const chatId = update?.message?.recipient?.chat_id;
    const senderUserId = update?.message?.sender?.user_id;
    const text = update?.message?.body?.text || update?.message?.text || "";

    console.log("MAX chat:", chatId, "senderUserId:", senderUserId, "text:", text);

    if (chatId) upsertRecipient(chatId);

    // тестовый автоответ можно оставить или убрать
    if (chatId) {
      await sendMaxMessageToChat(chatId, "Привет! Я получил ваше сообщение 👍");
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("MAX webhook error:", e);
    return res.sendStatus(500);
  }
})

// ===== сборка сообщений в MAX =====
function buildPublicImageUrl(filename) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  // если базу не задали — попробуем текущий домен
  const safeBase = base || "https://bot.company-rs.ru";
  return `${safeBase}/uploads/messages/${encodeURIComponent(filename)}`;
}

function buildOutboundText(msg) {
  const lines = [];
  const text = (msg?.text || "").trim();
  if (text) lines.push(text);

  const imgs = Array.isArray(msg?.images) ? msg.images : [];
  if (imgs.length) {
    lines.push("");
    lines.push("📎 Файлы/изображения:");
    for (const f of imgs) lines.push(buildPublicImageUrl(f));
  }

  return lines.join("\n");
}

// ===== отправка сообщения в MAX =====
async function sendMaxMessageToChat(chatId, text) {
  const token = (process.env.MAX_BOT_TOKEN || "").trim();
  if (!token) throw new Error("MAX_BOT_TOKEN is empty");

  const url = `https://platform-api.max.ru/messages?chat_id=${encodeURIComponent(
    String(chatId)
  )}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,   // ← без Bearer (подтверждено)
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const body = await resp.text();
  console.log("MAX send:", resp.status, body);

  if (!resp.ok) throw new Error(`MAX send failed: ${resp.status} ${body}`);
}

// ===== цикл рассылки сообщений в MAX =====
async function dispatchNextMessageTick() {
  try {
    const settings = loadSettings();
    const periodMs = intervalToMs(settings);

    const messages = loadMessages().sort((a, b) => a.createdAt - b.createdAt);
    if (!messages.length) return;

    const recipients = loadRecipients();
    if (!recipients.length) return;

    const state = loadDispatchState();
    const idx = state.index % messages.length;
    const msg = messages[idx];

    const outText = buildOutboundText(msg);

    console.log(
      `[DISPATCH] send message #${idx + 1}/${messages.length} to ${recipients.length} chats, interval=${settings.intervalValue} ${settings.intervalUnit}`
    );

    // отправляем всем (последовательно, чтобы не словить лимиты)
    for (const chatId of recipients) {
      try {
        await sendMaxMessageToChat(chatId, outText);
      } catch (e) {
        console.error("[DISPATCH] failed chatId=", chatId, e?.message || e);
      }
    }

    // сдвигаем указатель
    saveDispatchState({ index: idx + 1 });

    // планируем следующий запуск
    setTimeout(dispatchNextMessageTick, periodMs);
  } catch (e) {
    console.error("[DISPATCH] tick error:", e);
    // если упало — попробуем снова через минуту
    setTimeout(dispatchNextMessageTick, 60 * 1000);
  }
}

// запуск цикла после старта
setTimeout(dispatchNextMessageTick, 10 * 1000); // через 10 сек после запуска