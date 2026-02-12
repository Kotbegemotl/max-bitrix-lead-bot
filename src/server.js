import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.BITRIX_WEBHOOK_SECRET || "mysecret123";

// чтобы сервер понимал JSON
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server is running");
});

// webhook от Bitrix
app.post("/bitrix/webhook", (req, res) => {
  const incomingSecret = req.headers["x-hook-secret"];

  if (incomingSecret !== SECRET) {
    console.log("Неверный секрет");
    return res.status(401).json({ error: "Invalid secret" });
  }

  console.log("Получен webhook от Bitrix:");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
