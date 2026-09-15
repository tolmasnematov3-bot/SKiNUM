const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// JSON qabul qilish
app.use(express.json());

// Frontend
app.use(express.static(path.join(__dirname, "public")));

// API tekshirish
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    app: "SKiNUM",
    version: "7.1",
    status: "online"
  });
});

// Bosh sahifa
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Server
app.listen(PORT, () => {
  console.log(`SKiNUM server running on port ${PORT}`);
});
