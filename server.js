
const express = require("express");
const path = require("path");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const session = require("express-session");

const app = express();

const PORT = process.env.PORT || 3000;

const SITE_URL = (
  process.env.SITE_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing!");
}

app.set("trust proxy", 1);

app.use(express.json());

/* ==============================
   EXPRESS SESSION
============================== */

app.use(
  session({
    name: "skinum-session",
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

/* ==============================
   PASSPORT
============================== */

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

/* ==============================
   STEAM OPENID
============================== */

passport.use(
  new SteamStrategy(
    {
      returnURL: `${SITE_URL}/auth/steam/return`,
      realm: `${SITE_URL}/`,
      profile: false
    },

    (identifier, profile, done) => {
      try {
        const match = identifier.match(/\d+$/);

        if (!match) {
          return done(new Error("SteamID64 not found"));
        }

        return done(null, {
          steamId: match[0]
        });

      } catch (error) {
        return done(error);
      }
    }
  )
);

/* ==============================
   STEAM LOGIN
============================== */

app.get("/auth/steam", (req, res, next) => {
  console.log("STEAM LOGIN START");
  console.log("SITE_URL:", SITE_URL);
  console.log(
    "returnURL:",
    `${SITE_URL}/auth/steam/return`
  );

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

/* ==============================
   CURRENT USER
============================== */

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
      steamId: req.user.steamId
    }
  });
});

/* ==============================
   LOGOUT
============================== */

app.get("/auth/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) {
      return next(error);
    }

    req.session.destroy((error) => {
      if (error) {
        return next(error);
      }

      res.clearCookie("skinum-session");
      res.redirect("/");
    });
  });
});

/* ==============================
   SERVER STATUS
============================== */

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    app: "SKiNUM",
    version: "7.2",
    status: "online",
    steamLogin: true
  });
});

/* ==============================
   FRONTEND
============================== */

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* ==============================
   ERROR HANDLER
============================== */

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  res.status(500).send("Internal Server Error");
});

/* ==============================
   START SERVER
============================== */

app.listen(PORT, () => {
  console.log(`SKiNUM server running on port ${PORT}`);
  console.log(`SITE_URL: ${SITE_URL}`);
});
