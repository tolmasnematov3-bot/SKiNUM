
const express = require("express");
const path = require("path");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const session = require("express-session");
const { Pool } = require("pg");
const PgSession = require("connect-pg-simple")(session);
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_URL = (
  process.env.SITE_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://skinum.onrender.com"
    : `http://localhost:${PORT}`)
).replace(/\/$/, "");

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing!");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing!");
}

// ==========================================
// DATABASE
// ==========================================

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

// ==========================================
// SESSION
// ==========================================

const sessionStore = new PgSession({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

app.use(
  session({
    name: "skinum-session",
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: "auto",
      sameSite: "lax"
    }
  })
);

// ==========================================
// PASSPORT
// ==========================================

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

    if (!result.rows.length) {
      return done(null, false);
    }

    done(null, {
      steamId: result.rows[0].steam_id,
      createdAt: result.rows[0].created_at
    });
  } catch (error) {
    console.error("DESERIALIZE ERROR:", error);
    done(error);
  }
});

// ==========================================
// STEAM AUTHENTICATION
// ==========================================

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

        done(null, {
          steamId: result.rows[0].steam_id,
          createdAt: result.rows[0].created_at
        });
      } catch (error) {
        console.error("STEAM LOGIN DATABASE ERROR:", error);
        done(error);
      }
    }
  )
);

// ==========================================
// HELPERS
// ==========================================

function requireLogin(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      success: false,
      error: "LOGIN_REQUIRED",
      message: "Please sign in with Steam."
    });
  }

  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isValidImageUrl(value) {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

// ==========================================
// SKIN IMAGE LOOKUP
// ==========================================

// Demo skin slug -> Take.Skin mobile API slug.
// These are lookup identifiers, not image URLs.

const SKIN_IMAGE_SLUGS = {
  "demo-ak-redline": "ak-47-redline",
  "demo-awp-asiimov": "awp-asiimov",
  "demo-m4-howl": "m4a4-howl",
  "demo-glock-water": "glock-18-water-elemental",
  "demo-deagle-blaze": "desert-eagle-blaze",
  "demo-m4-emperor": "m4a4-the-emperor",
  "demo-awp-worm": "awp-worm-god",
  "demo-awp-neon": "awp-neo-noir",
  "demo-awp-dragon": "awp-dragon-lore"
};

const TAKE_SKIN_MOBILE =
  "https://take.skin/api/mobile";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SKiNUM-CS2-Platform/1.0"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Image API HTTP ${response.status}`);
  }

  return response.json();
}

function findImageUrl(data, depth = 0) {
  if (!data || depth > 8) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }

    return null;
  }

  if (typeof data !== "object") return null;

  const keys = [
    "imageUrl",
    "image_url",
    "image",
    "renderUrl",
    "render_url",
    "render",
    "previewUrl",
    "preview_url",
    "preview",
    "icon",
    "thumbnail"
  ];

  for (const key of keys) {
    if (isValidImageUrl(data[key])) {
      return data[key];
    }
  }

  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const found = findImageUrl(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

async function lookupSkinImage(skin) {
  const slug = SKIN_IMAGE_SLUGS[skin.slug];

  if (!slug) {
    console.log("UNKNOWN SKIN SLUG:", skin.slug);
    return null;
  }

  try {
    const url =
      `${TAKE_SKIN_MOBILE}/skins/${encodeURIComponent(slug)}`;

    console.log("IMAGE LOOKUP:", skin.display_name, url);

    const data = await fetchJson(url);
    const imageUrl = findImageUrl(data);

    if (!imageUrl) {
      console.log(
        "NO IMAGE IN API RESPONSE:",
        skin.display_name,
        JSON.stringify(data).slice(0, 500)
      );

      return null;
    }

    console.log(
      "IMAGE FOUND:",
      skin.display_name,
      imageUrl
    );

    return imageUrl;
  } catch (error) {
    console.error(
      "IMAGE LOOKUP FAILED:",
      skin.display_name,
      error.message
    );

    return null;
  }
}

let imageSyncRunning = false;

async function syncSkinImages() {
  if (imageSyncRunning) return;

  imageSyncRunning = true;

  try {
    const result = await pool.query(
      `SELECT id, slug, display_name, weapon
       FROM skins
       WHERE image_url IS NULL OR image_url = ''
       ORDER BY id`
    );

    if (!result.rows.length) {
      console.log("SKIN IMAGES: ALL READY");
      return;
    }

    console.log(
      `SKIN IMAGE SYNC: ${result.rows.length} skins`
    );

    for (let i = 0; i < result.rows.length; i += 3) {
      const batch = result.rows.slice(i, i + 3);

      await Promise.all(
        batch.map(async (skin) => {
          const imageUrl = await lookupSkinImage(skin);

          if (!imageUrl) return;

          await pool.query(
            `UPDATE skins
             SET image_url = $1
             WHERE id = $2`,
            [imageUrl, skin.id]
          );

          console.log(
            "SKIN IMAGE SAVED:",
            skin.display_name
          );
        })
      );
    }

    console.log("SKIN IMAGE SYNC FINISHED");
  } catch (error) {
    console.error("IMAGE SYNC ERROR:", error);
  } finally {
    imageSyncRunning = false;
  }
}

// ==========================================
// DATABASE INITIALIZATION
// ==========================================

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      steam_id VARCHAR(30) PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS demo_balance_cents BIGINT
    NOT NULL DEFAULT 10000
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS skins (
      id BIGSERIAL PRIMARY KEY,
      slug VARCHAR(100) UNIQUE NOT NULL,
      display_name VARCHAR(150) NOT NULL,
      weapon VARCHAR(80) NOT NULL,
      rarity VARCHAR(40) NOT NULL,
      image_url TEXT,
      value_cents BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (value_cents >= 0)
    )
  `);

  await pool.query(`
    ALTER TABLE skins
    ADD COLUMN IF NOT EXISTS image_url TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id BIGSERIAL PRIMARY KEY,
      slug VARCHAR(80) UNIQUE NOT NULL,
      name VARCHAR(120) NOT NULL,
      price_cents BIGINT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (price_cents > 0)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_items (
      case_id BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      skin_id BIGINT NOT NULL REFERENCES skins(id),
      weight_bps INTEGER NOT NULL,
      PRIMARY KEY (case_id, skin_id),
      CHECK (weight_bps > 0 AND weight_bps <= 10000)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_inventory (
      id BIGSERIAL PRIMARY KEY,
      steam_id VARCHAR(30) NOT NULL REFERENCES users(steam_id),
      skin_id BIGINT NOT NULL REFERENCES skins(id),
      status VARCHAR(30) NOT NULL DEFAULT 'available',
      source VARCHAR(30) NOT NULL DEFAULT 'case',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        status IN (
          'available',
          'listed',
          'reserved',
          'withdrawal_pending'
        )
      )
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      steam_id VARCHAR(30) NOT NULL REFERENCES users(steam_id),
      type VARCHAR(40) NOT NULL,
      amount_cents BIGINT NOT NULL,
      balance_after_cents BIGINT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_openings (
      id BIGSERIAL PRIMARY KEY,
      steam_id VARCHAR(30) NOT NULL REFERENCES users(steam_id),
      case_id BIGINT NOT NULL REFERENCES cases(id),
      skin_id BIGINT NOT NULL REFERENCES skins(id),
      cost_cents BIGINT NOT NULL,
      idempotency_key VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (steam_id, idempotency_key)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS inventory_user_idx
    ON user_inventory(steam_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS transactions_user_idx
    ON transactions(steam_id, created_at DESC)
  `);

  // ========================================
  // DEMO SKINS
  // ========================================

  const demoSkins = [
    ["demo-ak-redline", "AK-47 | Redline", "AK-47", "Classified", 1200],
    ["demo-awp-asiimov", "AWP | Asiimov", "AWP", "Covert", 3500],
    ["demo-m4-howl", "M4A4 | Howl", "M4A4", "Contraband", 9000],

    ["demo-glock-water", "Glock-18 | Water Elemental", "Glock-18", "Classified", 800],
    ["demo-deagle-blaze", "Desert Eagle | Blaze", "Desert Eagle", "Restricted", 2200],
    ["demo-m4-emperor", "M4A4 | The Emperor", "M4A4", "Covert", 3000],

    ["demo-awp-worm", "AWP | Worm God", "AWP", "Restricted", 700],
    ["demo-awp-neon", "AWP | Neo-Noir", "AWP", "Covert", 2500],
    ["demo-awp-dragon", "AWP | Dragon Lore", "AWP", "Covert", 10000]
  ];

  for (const skin of demoSkins) {
    await pool.query(
      `INSERT INTO skins
        (slug, display_name, weapon, rarity, value_cents)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         weapon = EXCLUDED.weapon,
         rarity = EXCLUDED.rarity,
         value_cents = EXCLUDED.value_cents`,
      skin
    );
  }

  // ========================================
  // DEMO CASES
  // ========================================

  const demoCases = [
    ["knife-case", "Knife Case", 2500],
    ["weapon-case", "Weapon Case", 500],
    ["awp-case", "AWP Case", 1000]
  ];

  for (const item of demoCases) {
    await pool.query(
      `INSERT INTO cases (slug, name, price_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      item
    );
  }

  // ========================================
  // DROP PROBABILITIES
  // ========================================

  const demoDrops = [
    ["knife-case", "demo-ak-redline", 7000],
    ["knife-case", "demo-awp-asiimov", 2500],
    ["knife-case", "demo-m4-howl", 500],

    ["weapon-case", "demo-glock-water", 7000],
    ["weapon-case", "demo-deagle-blaze", 2500],
    ["weapon-case", "demo-m4-emperor", 500],

    ["awp-case", "demo-awp-worm", 7000],
    ["awp-case", "demo-awp-neon", 2500],
    ["awp-case", "demo-awp-dragon", 500]
  ];

  for (const drop of demoDrops) {
    await pool.query(
      `INSERT INTO case_items (case_id, skin_id, weight_bps)
       SELECT c.id, s.id, $3
       FROM cases c, skins s
       WHERE c.slug = $1 AND s.slug = $2
       ON CONFLICT (case_id, skin_id)
       DO UPDATE SET weight_bps = EXCLUDED.weight_bps`,
      drop
    );
  }

  // ========================================
  // VALIDATE DROP PROBABILITIES
  // ========================================

  const invalidCases = await pool.query(`
    SELECT
      c.slug,
      COALESCE(SUM(ci.weight_bps), 0) AS total
    FROM cases c
    LEFT JOIN case_items ci ON ci.case_id = c.id
    WHERE c.active = TRUE
    GROUP BY c.id, c.slug
    HAVING COALESCE(SUM(ci.weight_bps), 0) <> 10000
  `);

  if (invalidCases.rows.length) {
    throw new Error(
      "Invalid case probabilities: " +
      JSON.stringify(invalidCases.rows)
    );
  }

  console.log("DATABASE TABLES READY");
  console.log("DEMO CASES READY");
}

// ==========================================
// STEAM LOGIN ROUTES
// ==========================================

app.get(
  "/auth/steam",
  passport.authenticate("steam")
);

app.get(
  "/auth/steam/return",
  passport.authenticate("steam", {
    failureRedirect: "/?steam_login=failed"
  }),
  (req, res, next) => {
    console.log("STEAM LOGIN SUCCESS:", req.user.steamId);

    req.session.save((error) => {
      if (error) {
        console.error("SESSION SAVE ERROR:", error);
        return next(error);
      }

      console.log("STEAM SESSION SAVED");
      res.redirect("/?steam_login=success");
    });
  }
);

// ==========================================
// CURRENT USER
// ==========================================

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

// ==========================================
// WALLET
// ==========================================

app.get(
  "/api/wallet",
  requireLogin,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT demo_balance_cents
       FROM users
       WHERE steam_id = $1`,
      [req.user.steamId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        error: "USER_NOT_FOUND"
      });
    }

    const balanceCents = Number(
      result.rows[0].demo_balance_cents
    );

    res.json({
      success: true,
      currency: "USD",
      mode: "DEMO",
      balanceCents,
      balance: balanceCents / 100
    });
  })
);

// ==========================================
// LIST CASES
// ==========================================

app.get(
  "/api/cases",
  asyncRoute(async (req, res) => {
    const result = await pool.query(`
      SELECT
        c.id,
        c.slug,
        c.name,
        c.price_cents,
        COALESCE(
          json_agg(
            json_build_object(
              'id', s.id,
              'name', s.display_name,
              'weapon', s.weapon,
              'rarity', s.rarity,
              'image', s.image_url,
              'imageUrl', s.image_url,
              'valueCents', s.value_cents,
              'chance', ci.weight_bps / 100.0
            )
            ORDER BY ci.weight_bps DESC
          ) FILTER (WHERE s.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM cases c
      LEFT JOIN case_items ci ON ci.case_id = c.id
      LEFT JOIN skins s ON s.id = ci.skin_id
      WHERE c.active = TRUE
      GROUP BY c.id
      ORDER BY c.id
    `);

    res.json({
      success: true,
      mode: "DEMO",
      cases: result.rows.map((item) => ({
        id: item.id,
        slug: item.slug,
        name: item.name,
        priceCents: Number(item.price_cents),
        price: Number(item.price_cents) / 100,
        items: item.items
      }))
    });
  })
);

// ==========================================
// OPEN CASE
// ==========================================

app.post(
  "/api/cases/:caseId/open",
  requireLogin,
  asyncRoute(async (req, res) => {
    const caseId = String(req.params.caseId);

    if (!/^(?:\d+|[a-z0-9-]+)$/i.test(caseId)) {
      return res.status(400).json({
        success: false,
        error: "INVALID_CASE_ID"
      });
    }

    const idempotencyKey =
      String(req.body?.idempotencyKey || "").trim();

    if (
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 100
    ) {
      return res.status(400).json({
        success: false,
        error: "INVALID_IDEMPOTENCY_KEY",
        message: "A unique idempotencyKey is required."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query(
        `SELECT demo_balance_cents
         FROM users
         WHERE steam_id = $1
         FOR UPDATE`,
        [req.user.steamId]
      );

      if (!userResult.rows.length) {
        throw new Error("USER_NOT_FOUND");
      }

      const previous = await client.query(
        `SELECT
           o.id,
           o.cost_cents,
           o.created_at,
           s.id AS skin_id,
           s.display_name,
           s.weapon,
           s.rarity,
           s.image_url,
           s.value_cents,
           ui.id AS inventory_id
         FROM case_openings o
         JOIN skins s ON s.id = o.skin_id
         LEFT JOIN user_inventory ui
           ON ui.steam_id = o.steam_id
           AND ui.skin_id = o.skin_id
           AND ui.source = 'case'
           AND ui.created_at >= o.created_at
           AND ui.created_at <= o.created_at + INTERVAL '2 seconds'
         WHERE o.steam_id = $1
           AND o.idempotency_key = $2
         LIMIT 1`,
        [req.user.steamId, idempotencyKey]
      );

      if (previous.rows.length) {
        const old = previous.rows[0];

        const currentBalance = Number(
          userResult.rows[0].demo_balance_cents
        );

        await client.query("COMMIT");

        return res.json({
          success: true,
          repeatedRequest: true,
          mode: "DEMO",
          openingId: old.id,
          inventoryId: old.inventory_id,
          chargedCents: Number(old.cost_cents),
          balanceCents: currentBalance,
          balance: currentBalance / 100,
          skin: {
            id: old.skin_id,
            name: old.display_name,
            weapon: old.weapon,
            rarity: old.rarity,
            image: old.image_url,
            imageUrl: old.image_url,
            valueCents: Number(old.value_cents)
          }
        });
      }

      const isNumericId = /^\d+$/.test(caseId);

      const caseResult = isNumericId
        ? await client.query(
            `SELECT id, name, price_cents
             FROM cases
             WHERE id = $1 AND active = TRUE`,
            [caseId]
          )
        : await client.query(
            `SELECT id, name, price_cents
             FROM cases
             WHERE slug = $1 AND active = TRUE`,
            [caseId]
          );

      if (!caseResult.rows.length) {
        throw new Error("CASE_NOT_FOUND");
      }

      const selectedCase = caseResult.rows[0];
      const price = Number(selectedCase.price_cents);

      const balance = Number(
        userResult.rows[0].demo_balance_cents
      );

      if (balance < price) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const dropResult = await client.query(
        `SELECT
           s.id,
           s.display_name,
           s.weapon,
           s.rarity,
           s.image_url,
           s.value_cents,
           ci.weight_bps
         FROM case_items ci
         JOIN skins s ON s.id = ci.skin_id
         WHERE ci.case_id = $1`,
        [selectedCase.id]
      );

      if (!dropResult.rows.length) {
        throw new Error("CASE_HAS_NO_ITEMS");
      }

      const totalWeight = dropResult.rows.reduce(
        (sum, item) => sum + Number(item.weight_bps),
        0
      );

      if (totalWeight !== 10000) {
        throw new Error("INVALID_CASE_PROBABILITIES");
      }

      const randomNumber = crypto.randomInt(totalWeight);

      let cursor = 0;
      let wonSkin = null;

      for (const item of dropResult.rows) {
        cursor += Number(item.weight_bps);

        if (randomNumber < cursor) {
          wonSkin = item;
          break;
        }
      }

      if (!wonSkin) {
        throw new Error("SKIN_SELECTION_FAILED");
      }

      const newBalance = balance - price;

      await client.query(
        `UPDATE users
         SET demo_balance_cents = $1
         WHERE steam_id = $2`,
        [newBalance, req.user.steamId]
      );

      const inventoryResult = await client.query(
        `INSERT INTO user_inventory
          (steam_id, skin_id, status, source)
         VALUES ($1, $2, 'available', 'case')
         RETURNING id, created_at`,
        [req.user.steamId, wonSkin.id]
      );

      await client.query(
        `INSERT INTO transactions
          (steam_id, type, amount_cents, balance_after_cents, description)
         VALUES ($1, 'case_open', $2, $3, $4)`,
        [
          req.user.steamId,
          -price,
          newBalance,
          `Opened ${selectedCase.name}`
        ]
      );

      const openingResult = await client.query(
        `INSERT INTO case_openings
          (steam_id, case_id, skin_id, cost_cents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [
          req.user.steamId,
          selectedCase.id,
          wonSkin.id,
          price,
          idempotencyKey
        ]
      );

      await client.query("COMMIT");

      console.log(
        "CASE OPENED:",
        req.user.steamId,
        selectedCase.name,
        wonSkin.display_name
      );

      res.json({
        success: true,
        repeatedRequest: false,
        mode: "DEMO",
        openingId: openingResult.rows[0].id,
        inventoryId: inventoryResult.rows[0].id,
        case: selectedCase.name,
        chargedCents: price,
        balanceCents: newBalance,
        balance: newBalance / 100,
        skin: {
          id: wonSkin.id,
          name: wonSkin.display_name,
          weapon: wonSkin.weapon,
          rarity: wonSkin.rarity,
          image: wonSkin.image_url,
          imageUrl: wonSkin.image_url,
          valueCents: Number(wonSkin.value_cents)
        }
      });
    } catch (error) {
      await client.query("ROLLBACK");

      const knownErrors = {
        USER_NOT_FOUND: [404, "User not found."],
        CASE_NOT_FOUND: [404, "Case not found."],
        INSUFFICIENT_BALANCE: [400, "Not enough demo balance."],
        CASE_HAS_NO_ITEMS: [400, "This case has no items."],
        INVALID_CASE_PROBABILITIES: [
          500,
          "Case probability setup is invalid."
        ],
        SKIN_SELECTION_FAILED: [
          500,
          "Could not select a skin."
        ]
      };

      if (knownErrors[error.message]) {
        const [status, message] = knownErrors[error.message];

        return res.status(status).json({
          success: false,
          error: error.message,
          message
        });
      }

      throw error;
    } finally {
      client.release();
    }
  })
);

// ==========================================
// USER INVENTORY
// ==========================================

app.get(
  "/api/inventory",
  requireLogin,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT
         ui.id AS inventory_id,
         ui.status,
         ui.source,
         ui.created_at,
         s.display_name,
         s.weapon,
         s.rarity,
         s.image_url,
         s.value_cents
       FROM user_inventory ui
       JOIN skins s ON s.id = ui.skin_id
       WHERE ui.steam_id = $1
       ORDER BY ui.created_at DESC`,
      [req.user.steamId]
    );

    res.json({
      success: true,
      inventory: result.rows.map((item) => ({
        id: item.inventory_id,
        name: item.display_name,
        weapon: item.weapon,
        rarity: item.rarity,
        image: item.image_url,
        imageUrl: item.image_url,
        status: item.status,
        source: item.source,
        valueCents: Number(item.value_cents),
        createdAt: item.created_at
      }))
    });
  })
);

// ==========================================
// TRANSACTION HISTORY
// ==========================================

app.get(
  "/api/transactions",
  requireLogin,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT
         id,
         type,
         amount_cents,
         balance_after_cents,
         description,
         created_at
       FROM transactions
       WHERE steam_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.steamId]
    );

    res.json({
      success: true,
      transactions: result.rows.map((item) => ({
        id: item.id,
        type: item.type,
        amountCents: Number(item.amount_cents),
        balanceAfterCents: Number(item.balance_after_cents),
        description: item.description,
        createdAt: item.created_at
      }))
    });
  })
);

// ==========================================
// IMAGE SYNC STATUS
// ==========================================

app.get(
  "/api/images/status",
  asyncRoute(async (req, res) => {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE image_url IS NOT NULL AND image_url <> ''
        )::int AS with_images
      FROM skins
    `);

    const total = result.rows[0].total;
    const withImages = result.rows[0].with_images;

    res.json({
      success: true,
      total,
      withImages,
      missingImages: total - withImages,
      syncRunning: imageSyncRunning
    });
  })
);

// ==========================================
// MANUAL IMAGE SYNC
// ==========================================

app.post(
  "/api/images/sync",
  requireLogin,
  (req, res) => {
    if (imageSyncRunning) {
      return res.json({
        success: true,
        message: "Image sync is already running."
      });
    }

    syncSkinImages();

    res.json({
      success: true,
      message: "Image sync started."
    });
  }
);

// ==========================================
// DATABASE STATUS
// ==========================================

app.get(
  "/api/database",
  asyncRoute(async (req, res) => {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      database: "connected",
      sessions: "postgresql"
    });
  })
);

// ==========================================
// SERVER STATUS
// ==========================================

app.get(
  "/api/status",
  asyncRoute(async (req, res) => {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      app: "SKiNUM",
      version: "7.8",
      status: "online",
      steamLogin: true,
      database: "connected",
      sessionStore: "postgresql",
      features: [
        "steam-login",
        "wallet-demo",
        "cases",
        "inventory",
        "transactions",
        "skin-image-sync",
        "postgresql-sessions"
      ]
    });
  })
);

// ==========================================
// LOGOUT
// ==========================================

app.get(
  "/auth/logout",
  (req, res, next) => {
    req.logout((error) => {
      if (error) {
        return next(error);
      }

      req.session.destroy((sessionError) => {
        if (sessionError) {
          return next(sessionError);
        }

        res.clearCookie("skinum-session", {
          path: "/",
          httpOnly: true,
          secure: "auto",
          sameSite: "lax"
        });

        res.redirect("/");
      });
    });
  }
);

// ==========================================
// FRONTEND
// ==========================================

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "Something went wrong on the server."
  });
});

// ==========================================
// START SERVER
// ==========================================

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log("================================");
      console.log("SKiNUM V7.8 SERVER ONLINE");
      console.log("DATABASE: CONNECTED");
      console.log("SESSION STORE: POSTGRESQL");
      console.log("STEAM AUTH: READY");
      console.log("CASES: READY");
      console.log("INVENTORY: READY");
      console.log("SKIN IMAGE SYNC: ENABLED");
      console.log("WALLET: DEMO MODE");
      console.log("SITE:", SITE_URL);
      console.log("================================");

      // Start image sync after server startup.
      syncSkinImages();

      // Retry missing images every 12 hours.
      setInterval(() => {
        syncSkinImages();
      }, 12 * 60 * 60 * 1000);
    });
  } catch (error) {
    console.error("STARTUP ERROR:", error);
    process.exit(1);
  }
}

startServer();
