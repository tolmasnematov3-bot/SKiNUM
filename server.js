'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const session = require('express-session');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');

// ==========================================
// CONFIGURATION
// ==========================================

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_URL = (
  process.env.SITE_URL || `http://localhost:${PORT}`
).replace(/\/$/, '');

const STEAM_API_KEY = process.env.STEAM_API_KEY;

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'change-this-session-secret-before-production';

const DATABASE_URL = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not configured.');
}

if (!STEAM_API_KEY) {
  console.warn('WARNING: STEAM_API_KEY is not configured.');
}

if (
  isProduction &&
  SESSION_SECRET === 'change-this-session-secret-before-production'
) {
  console.error('Set a strong SESSION_SECRET in production.');
}

// ==========================================
// DATABASE
// ==========================================

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    process.env.PGSSL === 'false'
      ? false
      : isProduction
        ? { rejectUnauthorized: false }
        : undefined,

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// ==========================================
// EXPRESS
// ==========================================

app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ==========================================
// SESSION
// ==========================================

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),

    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    name: 'skinum.sid',

    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
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
      `SELECT steam_id, display_name, avatar_url, profile_url
       FROM users
       WHERE steam_id = $1`,
      [steamId]
    );

    if (!result.rows.length) {
      return done(null, false);
    }

    const row = result.rows[0];

    done(null, {
      steamId: row.steam_id,
      displayName: row.display_name,
      avatar: row.avatar_url,
      profileUrl: row.profile_url
    });

  } catch (err) {
    done(err);
  }
});

// ==========================================
// STEAM STRATEGY
// ==========================================

if (STEAM_API_KEY) {
  passport.use(
    new SteamStrategy(
      {
        returnURL: `${SITE_URL}/auth/steam/return`,
        realm: `${SITE_URL}/`,
        apiKey: STEAM_API_KEY
      },

      async (_identifier, profile, done) => {
        try {
          const steamId = profile.id;

          const displayName =
            profile.displayName || 'Steam User';

          const avatar =
            profile.photos?.[2]?.value ||
            profile.photos?.[1]?.value ||
            profile.photos?.[0]?.value ||
            '';

          const profileUrl =
            profile._json?.profileurl ||
            `https://steamcommunity.com/profiles/${steamId}`;

          await pool.query(
            `INSERT INTO users
              (steam_id, display_name, avatar_url, profile_url)
             VALUES ($1, $2, $3, $4)

             ON CONFLICT (steam_id)
             DO UPDATE SET
               display_name = EXCLUDED.display_name,
               avatar_url = EXCLUDED.avatar_url,
               profile_url = EXCLUDED.profile_url,
               updated_at = NOW()`,

            [
              steamId,
              displayName,
              avatar,
              profileUrl
            ]
          );

          done(null, {
            steamId,
            displayName,
            avatar,
            profileUrl
          });

        } catch (err) {
          done(err);
        }
      }
    )
  );
}

// ==========================================
// HELPERS
// ==========================================

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requireLogin(req, res, next) {
  if (req.isAuthenticated?.() && req.user) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'LOGIN_REQUIRED',
    message: 'Please sign in with Steam first.'
  });
}

function centsToMoney(cents) {
  return Number(cents || 0) / 100;
}

// ==========================================
// DATABASE INITIALIZATION
// ==========================================

async function initializeDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      steam_id TEXT PRIMARY KEY,

      display_name TEXT NOT NULL DEFAULT 'Steam User',

      avatar_url TEXT NOT NULL DEFAULT '',

      profile_url TEXT NOT NULL DEFAULT '',

      demo_balance_cents BIGINT NOT NULL DEFAULT 10000,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS
    demo_balance_cents BIGINT NOT NULL DEFAULT 10000;


    CREATE TABLE IF NOT EXISTS skins (
      id TEXT PRIMARY KEY,

      name TEXT NOT NULL,

      weapon TEXT NOT NULL,

      rarity TEXT NOT NULL,

      image_url TEXT NOT NULL DEFAULT '',

      market_price_cents INTEGER NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,

      name TEXT NOT NULL,

      description TEXT NOT NULL DEFAULT '',

      price_cents INTEGER NOT NULL,

      image_url TEXT NOT NULL DEFAULT '',

      active BOOLEAN NOT NULL DEFAULT TRUE
    );


    CREATE TABLE IF NOT EXISTS case_items (
      id BIGSERIAL PRIMARY KEY,

      case_id TEXT NOT NULL
        REFERENCES cases(id) ON DELETE CASCADE,

      skin_id TEXT NOT NULL
        REFERENCES skins(id) ON DELETE CASCADE,

      drop_weight INTEGER NOT NULL
        CHECK (drop_weight > 0),

      UNIQUE(case_id, skin_id)
    );


    CREATE TABLE IF NOT EXISTS user_inventory (
      id BIGSERIAL PRIMARY KEY,

      steam_id TEXT NOT NULL
        REFERENCES users(steam_id) ON DELETE CASCADE,

      skin_id TEXT NOT NULL
        REFERENCES skins(id),

      source TEXT NOT NULL DEFAULT 'case',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,

      steam_id TEXT NOT NULL
        REFERENCES users(steam_id) ON DELETE CASCADE,

      type TEXT NOT NULL,

      amount_cents BIGINT NOT NULL,

      balance_after_cents BIGINT NOT NULL,

      description TEXT NOT NULL DEFAULT '',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS case_openings (
      id BIGSERIAL PRIMARY KEY,

      steam_id TEXT NOT NULL
        REFERENCES users(steam_id) ON DELETE CASCADE,

      case_id TEXT NOT NULL
        REFERENCES cases(id),

      skin_id TEXT NOT NULL
        REFERENCES skins(id),

      idempotency_key TEXT NOT NULL,

      price_cents INTEGER NOT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE(steam_id, idempotency_key)
    );


    CREATE INDEX IF NOT EXISTS idx_inventory_steam
    ON user_inventory(steam_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_transactions_steam
    ON transactions(steam_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_case_items_case
    ON case_items(case_id);
  `);

  // ========================================
  // SKINS
  // ========================================

  const skins = [

    [
      'ak-redline',
      'AK-47 | Redline',
      'AK-47',
      'Classified',
      '',
      1450
    ],

    [
      'awp-asiimov',
      'AWP | Asiimov',
      'AWP',
      'Covert',
      '',
      5200
    ],

    [
      'm4a4-neo-noir',
      'M4A4 | Neo-Noir',
      'M4A4',
      'Covert',
      '',
      3100
    ],

    [
      'usp-kill-confirmed',
      'USP-S | Kill Confirmed',
      'USP-S',
      'Covert',
      '',
      4600
    ],

    [
      'glock-fade',
      'Glock-18 | Fade',
      'Glock-18',
      'Covert',
      '',
      12500
    ],

    [
      'deagle-printstream',
      'Desert Eagle | Printstream',
      'Desert Eagle',
      'Covert',
      '',
      6900
    ],

    [
      'karambit-blue-steel',
      '★ Karambit | Blue Steel',
      'Knife',
      'Covert',
      '',
      28000
    ],

    [
      'butterfly-night',
      '★ Butterfly Knife | Night',
      'Knife',
      'Covert',
      '',
      34000
    ],

    [
      'awp-dragon-lore',
      'AWP | Dragon Lore',
      'AWP',
      'Covert',
      '',
      125000
    ]

  ];

  for (const skin of skins) {

    await pool.query(
      `INSERT INTO skins
        (id, name, weapon, rarity, image_url, market_price_cents)

       VALUES ($1, $2, $3, $4, $5, $6)

       ON CONFLICT (id)
       DO UPDATE SET
         name = EXCLUDED.name,
         weapon = EXCLUDED.weapon,
         rarity = EXCLUDED.rarity,
         image_url = EXCLUDED.image_url,
         market_price_cents = EXCLUDED.market_price_cents`,

      skin
    );

  }

  // ========================================
  // CASES
  // ========================================

  const cases = [

    [
      'knife-case',
      'KNIFE CASE',
      'Hunt for rare knife finishes.',
      2500,
      '',
      true
    ],

    [
      'weapon-case',
      'WEAPON CASE',
      'A selection of iconic weapon skins.',
      1000,
      '',
      true
    ],

    [
      'awp-case',
      'AWP CASE',
      'Only AWP drops. Take your shot.',
      1800,
      '',
      true
    ]

  ];

  for (const c of cases) {

    await pool.query(
      `INSERT INTO cases
        (id, name, description, price_cents, image_url, active)

       VALUES ($1, $2, $3, $4, $5, $6)

       ON CONFLICT (id)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price_cents = EXCLUDED.price_cents,
         image_url = EXCLUDED.image_url,
         active = EXCLUDED.active`,

      c
    );

  }

  // ========================================
  // CASE DROP CHANCES
  // ========================================

  const mappings = {

    'knife-case': [
      ['karambit-blue-steel', 18],
      ['butterfly-night', 12],
      ['glock-fade', 70]
    ],

    'weapon-case': [
      ['ak-redline', 260],
      ['m4a4-neo-noir', 180],
      ['usp-kill-confirmed', 150],
      ['glock-fade', 100],
      ['deagle-printstream', 90],
      ['awp-asiimov', 40]
    ],

    'awp-case': [
      ['awp-asiimov', 250],
      ['awp-dragon-lore', 5]
    ]

  };

  for (const [caseId, items] of Object.entries(mappings)) {

    for (const [skinId, weight] of items) {

      await pool.query(
        `INSERT INTO case_items
          (case_id, skin_id, drop_weight)

         VALUES ($1, $2, $3)

         ON CONFLICT (case_id, skin_id)
         DO UPDATE SET
           drop_weight = EXCLUDED.drop_weight`,

        [caseId, skinId, weight]
      );

    }

  }

}

// ==========================================
// STEAM LOGIN
// ==========================================

app.get('/auth/steam', (req, res, next) => {

  if (!STEAM_API_KEY) {
    return res.status(503).send(
      'Steam login is not configured. Add STEAM_API_KEY.'
    );
  }

  passport.authenticate('steam')(req, res, next);

});


app.get(
  '/auth/steam/return',

  (req, res, next) => {

    if (!STEAM_API_KEY) {
      return res.redirect('/?login=not-configured');
    }

    passport.authenticate(
      'steam',
      { failureRedirect: '/?login=failed' }
    )(req, res, next);

  },

  (req, res) => {

    req.session.save((err) => {

      if (err) {
        console.error('Session save error:', err);
      }

      res.redirect('/?login=success');

    });

  }
);


// ==========================================
// LOGOUT
// ==========================================

app.post('/auth/logout', (req, res, next) => {

  req.logout((err) => {

    if (err) return next(err);

    req.session.destroy(() => {

      res.json({
        success: true
      });

    });

  });

});


app.get('/auth/logout', (req, res, next) => {

  req.logout((err) => {

    if (err) return next(err);

    req.session.destroy(() => {
      res.redirect('/');
    });

  });

});


// ==========================================
// CURRENT USER
// ==========================================

app.get('/api/me', (req, res) => {

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

      displayName: req.user.displayName,

      avatar: req.user.avatar,

      profileUrl: req.user.profileUrl

    }

  });

});


// ==========================================
// WALLET
// ==========================================

app.get(
  '/api/wallet',

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
        message: 'User not found.'
      });

    }

    const balanceCents = Number(
      result.rows[0].demo_balance_cents
    );

    res.json({

      success: true,

      mode: 'DEMO',

      balanceCents,

      balance: centsToMoney(balanceCents)

    });

  })

);


// ==========================================
// DEMO BALANCE TOP UP
// ==========================================

app.post(
  '/api/demo/topup',

  requireLogin,

  asyncRoute(async (req, res) => {

    const amountCents = Number(
      req.body?.amountCents
    );

    const allowedAmounts = [
      1000,
      2500,
      5000,
      10000
    ];

    if (!allowedAmounts.includes(amountCents)) {

      return res.status(400).json({

        success: false,

        error: 'INVALID_AMOUNT',

        message: 'Choose a valid demo top-up amount.'

      });

    }

    const client = await pool.connect();

    try {

      await client.query('BEGIN');

      const locked = await client.query(
        `SELECT demo_balance_cents
         FROM users
         WHERE steam_id = $1
         FOR UPDATE`,
        [req.user.steamId]
      );

      if (!locked.rows.length) {
        throw new Error('USER_NOT_FOUND');
      }

      const newBalance =
        Number(locked.rows[0].demo_balance_cents) +
        amountCents;

      await client.query(
        `UPDATE users
         SET demo_balance_cents = $1,
             updated_at = NOW()
         WHERE steam_id = $2`,

        [newBalance, req.user.steamId]
      );

      await client.query(
        `INSERT INTO transactions
          (steam_id, type, amount_cents,
           balance_after_cents, description)

         VALUES ($1, 'demo_topup', $2, $3, $4)`,

        [
          req.user.steamId,
          amountCents,
          newBalance,
          'Demo balance top-up'
        ]
      );

      await client.query('COMMIT');

      res.json({

        success: true,

        mode: 'DEMO',

        addedCents: amountCents,

        balanceCents: newBalance,

        balance: centsToMoney(newBalance)

      });

    } catch (err) {

      await client.query('ROLLBACK');

      throw err;

    } finally {

      client.release();

    }

  })

);


// ==========================================
// CASE LIST
// ==========================================

app.get(
  '/api/cases',

  asyncRoute(async (_req, res) => {

    const result = await pool.query(

      `SELECT
        c.id,
        c.name,
        c.description,
        c.price_cents,
        c.image_url,

        COALESCE(
          json_agg(
            json_build_object(
              'id', s.id,
              'name', s.name,
              'weapon', s.weapon,
              'rarity', s.rarity,
              'imageUrl', s.image_url,
              'priceCents', s.market_price_cents
            )
          )
          FILTER (WHERE s.id IS NOT NULL),

          '[]'
        ) AS skins

       FROM cases c

       LEFT JOIN case_items ci
         ON ci.case_id = c.id

       LEFT JOIN skins s
         ON s.id = ci.skin_id

       WHERE c.active = TRUE

       GROUP BY c.id

       ORDER BY c.price_cents ASC`

    );

    res.json({

      success: true,

      cases: result.rows.map((c) => ({

        id: c.id,

        name: c.name,

        description: c.description,

        priceCents: Number(c.price_cents),

        price: centsToMoney(c.price_cents),

        imageUrl: c.image_url,

        skins: c.skins

      }))

    });

  })

);


// ==========================================
// OPEN CASE
// ==========================================

app.post(
  '/api/cases/:caseId/open',

  requireLogin,

  asyncRoute(async (req, res) => {

    const caseId = String(
      req.params.caseId || ''
    );

    const idempotencyKey = String(
      req.body?.idempotencyKey || crypto.randomUUID()
    ).slice(0, 100);

    const client = await pool.connect();

    try {

      await client.query('BEGIN');

      // Check duplicate request

      const previous = await client.query(

        `SELECT
          co.id,
          co.price_cents,
          co.created_at,

          s.id AS skin_id,
          s.name,
          s.weapon,
          s.rarity,
          s.image_url,
          s.market_price_cents,

          u.demo_balance_cents

         FROM case_openings co

         JOIN skins s
           ON s.id = co.skin_id

         JOIN users u
           ON u.steam_id = co.steam_id

         WHERE co.steam_id = $1
           AND co.idempotency_key = $2`,

        [
          req.user.steamId,
          idempotencyKey
        ]

      );

      if (previous.rows.length) {

        await client.query('COMMIT');

        const p = previous.rows[0];

        return res.json({

          success: true,

          replayed: true,

          mode: 'DEMO',

          balanceCents: Number(
            p.demo_balance_cents
          ),

          skin: {

            id: p.skin_id,

            name: p.name,

            weapon: p.weapon,

            rarity: p.rarity,

            imageUrl: p.image_url,

            priceCents: Number(
              p.market_price_cents
            )

          }

        });

      }

      // Find case

      const caseResult = await client.query(

        `SELECT id, name, price_cents
         FROM cases
         WHERE id = $1
           AND active = TRUE`,

        [caseId]

      );

      if (!caseResult.rows.length) {

        await client.query('ROLLBACK');

        return res.status(404).json({

          success: false,

          error: 'CASE_NOT_FOUND',

          message: 'Case not found.'

        });

      }

      const caseRow = caseResult.rows[0];

      // Lock user balance

      const userResult = await client.query(

        `SELECT demo_balance_cents
         FROM users
         WHERE steam_id = $1
         FOR UPDATE`,

        [req.user.steamId]

      );

      if (!userResult.rows.length) {
        throw new Error('USER_NOT_FOUND');
      }

      const balance = Number(
        userResult.rows[0].demo_balance_cents
      );

      const price = Number(
        caseRow.price_cents
      );

      if (balance < price) {

        await client.query('ROLLBACK');

        return res.status(400).json({

          success: false,

          error: 'INSUFFICIENT_BALANCE',

          message: 'Not enough demo balance.'

        });

      }

      // Get possible skins

      const itemsResult = await client.query(

        `SELECT
          s.id,
          s.name,
          s.weapon,
          s.rarity,
          s.image_url,
          s.market_price_cents,
          ci.drop_weight

         FROM case_items ci

         JOIN skins s
           ON s.id = ci.skin_id

         WHERE ci.case_id = $1`,

        [caseId]

      );

      if (!itemsResult.rows.length) {
        throw new Error('CASE_HAS_NO_ITEMS');
      }

      // Weighted random selection

      const totalWeight = itemsResult.rows.reduce(
        (sum, item) => sum + Number(item.drop_weight),
        0
      );

      let roll = crypto.randomInt(
        1,
        totalWeight + 1
      );

      let selected = itemsResult.rows[0];

      for (const item of itemsResult.rows) {

        roll -= Number(item.drop_weight);

        if (roll <= 0) {

          selected = item;

          break;

        }

      }

      // Deduct balance

      const newBalance = balance - price;

      await client.query(

        `UPDATE users
         SET demo_balance_cents = $1,
             updated_at = NOW()
         WHERE steam_id = $2`,

        [
          newBalance,
          req.user.steamId
        ]

      );

      // Add skin to inventory

      await client.query(

        `INSERT INTO user_inventory
          (steam_id, skin_id, source)

         VALUES ($1, $2, $3)`,

        [
          req.user.steamId,
          selected.id,
          `case:${caseId}`
        ]

      );

      // Transaction record

      await client.query(

        `INSERT INTO transactions
          (steam_id, type, amount_cents,
           balance_after_cents, description)

         VALUES ($1, 'case_open', $2, $3, $4)`,

        [
          req.user.steamId,
          -price,
          newBalance,
          `Opened ${caseRow.name}`
        ]

      );

      // Opening history

      await client.query(

        `INSERT INTO case_openings
          (steam_id, case_id, skin_id,
           idempotency_key, price_cents)

         VALUES ($1, $2, $3, $4, $5)`,

        [
          req.user.steamId,
          caseId,
          selected.id,
          idempotencyKey,
          price
        ]

      );

      await client.query('COMMIT');

      res.json({

        success: true,

        mode: 'DEMO',

        balanceCents: newBalance,

        case: {

          id: caseId,

          name: caseRow.name

        },

        skin: {

          id: selected.id,

          name: selected.name,

          weapon: selected.weapon,

          rarity: selected.rarity,

          imageUrl: selected.image_url,

          priceCents: Number(
            selected.market_price_cents
          )

        }

      });

    } catch (err) {

      await client.query('ROLLBACK');

      if (err.code === '23505') {

        return res.status(409).json({

          success: false,

          error: 'DUPLICATE_REQUEST',

          message:
            'This opening request was already processed. Refresh your balance and inventory.'

        });

      }

      throw err;

    } finally {

      client.release();

    }

  })

);


// ==========================================
// USER INVENTORY
// ==========================================

app.get(
  '/api/inventory',

  requireLogin,

  asyncRoute(async (req, res) => {

    const result = await pool.query(

      `SELECT
        ui.id,
        ui.source,
        ui.created_at,

        s.id AS skin_id,
        s.name,
        s.weapon,
        s.rarity,
        s.image_url,
        s.market_price_cents

       FROM user_inventory ui

       JOIN skins s
         ON s.id = ui.skin_id

       WHERE ui.steam_id = $1

       ORDER BY ui.created_at DESC

       LIMIT 200`,

      [req.user.steamId]

    );

    res.json({

      success: true,

      inventory: result.rows.map((r) => ({

        id: r.id,

        source: r.source,

        createdAt: r.created_at,

        skin: {

          id: r.skin_id,

          name: r.name,

          weapon: r.weapon,

          rarity: r.rarity,

          imageUrl: r.image_url,

          priceCents: Number(
            r.market_price_cents
          )

        }

      }))

    });

  })

);


// ==========================================
// TRANSACTIONS
// ==========================================

app.get(
  '/api/transactions',

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

      transactions: result.rows.map((r) => ({

        id: r.id,

        type: r.type,

        amountCents: Number(
          r.amount_cents
        ),

        balanceAfterCents: Number(
          r.balance_after_cents
        ),

        description: r.description,

        createdAt: r.created_at

      }))

    });

  })

);


// ==========================================
// SERVER STATUS
// ==========================================

app.get(
  '/api/status',

  asyncRoute(async (_req, res) => {

    await pool.query('SELECT 1');

    res.json({

      success: true,

      status: 'online',

      database: 'connected',

      mode: 'DEMO',

      version: '7.9.0'

    });

  })

);


// ==========================================
// DATABASE STATUS
// ==========================================

app.get(
  '/api/database',

  asyncRoute(async (_req, res) => {

    await pool.query('SELECT 1');

    res.json({

      success: true,

      database: 'connected'

    });

  })

);


// ==========================================
// STATIC FRONTEND
// ==========================================

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

app.get('*', (req, res, next) => {

  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/auth/')
  ) {
    return next();
  }

  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );

});


// ==========================================
// ERROR HANDLER
// ==========================================

app.use((err, req, res, _next) => {

  console.error('Request error:', err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({

    success: false,

    error: 'INTERNAL_SERVER_ERROR',

    message: isProduction
      ? 'Something went wrong. Please try again.'
      : err.message

  });

});


// ==========================================
// START SERVER
// ==========================================

initializeDatabase()

  .then(() => {

    app.listen(PORT, () => {

      console.log(
        `SKiNUM v7.9.0 listening on port ${PORT}`
      );

    });

  })

  .catch((err) => {

    console.error(
      'Database initialization failed:',
      err
    );

    process.exit(1);

  });


// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

process.on('SIGTERM', async () => {

  console.log(
    'SIGTERM received. Closing PostgreSQL pool...'
  );

  await pool.end();

  process.exit(0);

});
