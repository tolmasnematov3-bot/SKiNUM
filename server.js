
const express = require("express");
const path = require("path");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const session = require("express-session");
const { Pool } = require("pg");
const PgSession = require("connect-pg-simple")(session);

const app = express();

const PORT = process.env.PORT || 3000;

const SITE_URL = (
  process.env.SITE_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing!");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing!");
}

// POSTGRESQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  max: 5,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

pool.on("error", (error) => {
  console.error("POSTGRES ERROR:", error);
});

// POSTGRES SESSION STORE
const sessionStore = new PgSession({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60
});

app.set("trust proxy", 1);
app.use(express.json());

// EXPRESS SESSION
app.use(
  session({
    name: "skinum-session",
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    }
  })
);

// PASSPORT
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.steamId);
});

passport.deserializeUser(async (steamId, done) => {
  try {
    const result = await pool.query(
      `SELECT steam_id, created_at
       FROM users
       WHERE steam_id = $1`,
      [steamId]
    );

    if (result.rows.length === 0) {
      return done(null, false);
    }

    done(null, {
      steamId: result.rows[0].steam_id,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    done(error);
  }
});

// STEAM OPENID
passport.use(
  new SteamStrategy(
    {
      returnURL: `${SITE_URL}/auth/steam/return`,
      realm: `${SITE_URL}/`,
      profile: false
    },
    async (identifier, profile, done) => {
      try {
        const match = identifier.match(/\d+$/);

        if (!match) {
          return done(new Error("SteamID64 not found"));
        }

        const steamId = match[0];

        const result = await pool.query(
          `INSERT INTO users (steam_id)
           VALUES ($1)
           ON CONFLICT (steam_id)
           DO UPDATE SET last_login = CURRENT_TIMESTAMP
           RETURNING steam_id, created_at`,
          [steamId]
        );

        return done(null, {
          steamId: result.rows[0].steam_id,
          createdAt: result.rows[0].created_at
        });
      } catch (error) {
        console.error("STEAM DATABASE ERROR:", error);
        return done(error);
      }
    }
  )
);

// STEAM LOGIN
app.get("/auth/steam", (req, res, next) => {
  passport.authenticate("steam")(req, res, next);
});

app.get(
  "/auth/steam/return",
  passport.authenticate("steam", {
    failureRedirect: "/?steam_login=failed"
  }),
  (req, res) => {
    console.log("STEAM LOGIN SUCCESS:", req.user.steamId);
    res.redirect("/?steam_login=success");
  }
);

// CURRENT USER
app.get("/api/me", (req, res) => {
  if (!req.user) {
    return res.json({
      loggedIn: false,
      user: null
    });
  }

  res.json({
    loggedIn: true,
    user: {
      steamId: req.user.steamId,
      createdAt: req.user.createdAt
    }
  });
});

// DATABASE STATUS
app.get("/api/database", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      database: "connected",
      sessions: "postgresql"
    });
  } catch (error) {
    console.error("DATABASE CHECK ERROR:", error);

    res.status(503).json({
      success: false,
      database: "disconnected"
    });
  }
});

// LOGOUT
app.get("/auth/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);

    req.session.destroy((error) => {
      if (error) return next(error);

      res.clearCookie("skinum-session");
      res.redirect("/");
    });
  });
});

// SERVER STATUS
app.get("/api/status", async (req, res) => {
  let database = "disconnected";

  try {
    await pool.query("SELECT 1");
    database = "connected";
  } catch (error) {
    console.error("STATUS DATABASE ERROR:", error);
  }

  res.json({
    success: true,
    app: "SKiNUM",
    version: "7.4",
    status: "online",
    steamLogin: true,
    database,
    sessionStore: "postgresql"
  });
});

// FRONTEND
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);
  res.status(500).send("Internal Server Error");
});

// START SERVER
async function startServer() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        steam_id VARCHAR(30) PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query("SELECT 1");

    console.log("POSTGRES CONNECTED");
    console.log("USERS TABLE READY");
    console.log("SESSION STORE: POSTGRESQL");

    app.listen(PORT, () => {
      console.log(`SKiNUM server running on port ${PORT}`);
      console.log(`SITE_URL: ${SITE_URL}`);
    });
  } catch (error) {
    console.error("STARTUP ERROR:", error);
    process.exit(1);
  }
}

startServer();
