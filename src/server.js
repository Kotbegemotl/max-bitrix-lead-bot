import express from "express";
import dotenv from "dotenv";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// body parsers (один раз)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());

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

// Admin-panel
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

const ADMIN_PATH = process.env.ADMIN_PATH || "/admin";

function requireLogin(req, res, next) {
  if (req.session?.admin === true) return next();
  return res.redirect(`${ADMIN_PATH}/login`);
}

app.get(`${ADMIN_PATH}/login`, (req, res) => {
  res.render("login", { error: null, adminPath: ADMIN_PATH });
});

app.post(`${ADMIN_PATH}/login`, (req, res) => {
  console.log('Request body:', req.body);
  const { username, password } = req.body || {};
  console.log(`Username: ${username}, Password: ${password}`);
  const ok =
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS;

  if (!ok) {
    return res.status(401).render("login", {
      error: "Неверный логин или пароль",
      adminPath: ADMIN_PATH,
    });
  }

  req.session.admin = true;
  res.redirect(ADMIN_PATH);
});

app.get(`${ADMIN_PATH}/logout`, (req, res) => {
  req.session.destroy(() => res.redirect(`${ADMIN_PATH}/login`));
});

app.get(ADMIN_PATH, requireLogin, (req, res) => {
  const stages = [
    {
      id: "stageX",
      messages: [
        { text: "Пример 1", images: ["1.jpg"] },
        { text: "Пример 2", images: [] },
      ],
    },
  ];
  res.render("admin", { stages });
});

// --- Bitrix settings
const PORT = Number(process.env.PORT || 3000);
const BITRIX_APP_TOKEN = process.env.BITRIX_APP_TOKEN || "";
const X_HOOK_SECRET = process.env.BITRIX_WEBHOOK_SECRET || "";

app.get("/", (req, res) => res.status(200).send("Server is running"));

app.get("/bitrix/webhook", (req, res) => {
  res.status(200).send("OK (use POST here)");
});

// !!! запуск сервера
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server started on http://127.0.0.1:${PORT}`);
});

