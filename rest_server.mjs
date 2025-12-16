import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';

import { existsSync } from 'node:fs';

import { default as express } from 'express';
import { default as sqlite3 } from 'sqlite3';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const db_filename = path.join(__dirname, 'db', 'stpaul_crime.sqlite3');

const port = 8000;

let app = express();
app.use(express.json());

/*****************************
 * Static site hosting (Project 4)
 * - After you run `npm run build`, rename `dist` -> `docs`.
 * - This server will automatically serve `docs/` (or `dist/` if present).
 *****************************/
function pickClientDir() {
  const candidates = [
    path.join(__dirname, 'docs'),
    path.join(__dirname, 'dist'),
    path.join(__dirname, 'public'),
    __dirname
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

const clientDir = pickClientDir();
if (clientDir) {
  app.use(express.static(clientDir));
  app.get('/', (req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  app.get('/about.html', (req, res) => res.sendFile(path.join(clientDir, 'about.html')));
}


/********************************************************************
 ***   CORS (helps during Vite dev on :5173)                      *** 
 ********************************************************************/
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/********************************************************************
 ***   STATIC SITE (serve built Vue app from docs/)               *** 
 ********************************************************************/
const docsDir = path.join(__dirname, 'docs');
if (existsSync(docsDir)) {
  app.use(express.static(docsDir));
}

/********************************************************************
 ***   DATABASE FUNCTIONS                                         *** 
 ********************************************************************/
let db = new sqlite3.Database(db_filename, sqlite3.OPEN_READWRITE, (err) => {
  if (err) console.log('Error opening ' + path.basename(db_filename));
  else console.log('Now connected to ' + path.basename(db_filename));
});

function dbSelect(query, params) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbRun(query, params) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/********************************************************************
 ***   HELPER FUNCTIONS                                           *** 
 ********************************************************************/
function parseIntList(paramValue) {
  if (!paramValue) return [];
  return paramValue
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

function buildInClause(column, values, params) {
  if (!values || values.length === 0) return '';
  const placeholders = values.map(() => '?').join(', ');
  params.push(...values);
  return `${column} IN (${placeholders})`;
}

/********************************************************************
 ***   REST REQUEST HANDLERS                                      *** 
 ********************************************************************/

// GET /codes
// Optional query: ?code=110,700
app.get('/codes', async (req, res) => {
  try {
    const codes = parseIntList(req.query.code);
    const params = [];
    let where = '';

    if (codes.length > 0) {
      where = 'WHERE ' + buildInClause('code', codes, params);
    }

    const query = `
      SELECT code, incident_type
      FROM Codes
      ${where}
      ORDER BY code ASC
    `;

    const rows = await dbSelect(query, params);
    const result = rows.map((row) => ({ code: row.code, type: row.incident_type }));

    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).type('txt').send('Internal server error');
  }
});

// GET /neighborhoods
// Optional query: ?id=11,14
app.get('/neighborhoods', async (req, res) => {
  try {
    const ids = parseIntList(req.query.id);
    const params = [];
    let where = '';

    if (ids.length > 0) {
      where = 'WHERE ' + buildInClause('neighborhood_number', ids, params);
    }

    const query = `
      SELECT neighborhood_number AS id, neighborhood_name AS name
      FROM Neighborhoods
      ${where}
      ORDER BY id ASC
    `;

    const rows = await dbSelect(query, params);
    res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).type('txt').send('Internal server error');
  }
});

// GET /incidents
// Query options:
//  - start_date=YYYY-MM-DD
//  - end_date=YYYY-MM-DD
//  - code=110,700
//  - grid=38,65
//  - neighborhood=11,14
//  - limit=50
app.get('/incidents', async (req, res) => {
  try {
    const params = [];
    const conditions = [];

    const { start_date, end_date } = req.query;

    if (start_date) {
      conditions.push('date(date_time) >= ?');
      params.push(start_date);
    }
    if (end_date) {
      conditions.push('date(date_time) <= ?');
      params.push(end_date);
    }

    const codes = parseIntList(req.query.code);
    if (codes.length > 0) conditions.push(buildInClause('code', codes, params));

    const grids = parseIntList(req.query.grid);
    if (grids.length > 0) conditions.push(buildInClause('police_grid', grids, params));

    const neighborhoods = parseIntList(req.query.neighborhood);
    if (neighborhoods.length > 0) conditions.push(buildInClause('neighborhood_number', neighborhoods, params));

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    let limit = 1000;
    if (req.query.limit) {
      const n = parseInt(req.query.limit, 10);
      if (!Number.isNaN(n) && n > 0) limit = n;
    }

    const query = `
      SELECT
        case_number,
        date(date_time) AS date,
        time(date_time) AS time,
        code,
        incident,
        police_grid,
        neighborhood_number,
        block
      FROM Incidents
      ${where}
      ORDER BY date_time DESC
      LIMIT ?
    `;

    params.push(limit);

    const rows = await dbSelect(query, params);
    res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).type('txt').send('Internal server error');
  }
});

// PUT /new-incident
app.put('/new-incident', async (req, res) => {
  try {
    const {
      case_number,
      date,
      time,
      code,
      incident,
      police_grid,
      neighborhood_number,
      block
    } = req.body;

    if (!case_number || !date || !time || !code || !incident || !police_grid || !neighborhood_number || !block) {
      return res.status(400).type('txt').send('Missing required fields');
    }

    const existing = await dbSelect('SELECT case_number FROM Incidents WHERE case_number = ?', [case_number]);
    if (existing.length > 0) {
      return res.status(500).type('txt').send('Error: case_number already exists');
    }

    const dateTime = `${date} ${time}`;

    const insertQuery = `
      INSERT INTO Incidents
        (case_number, date_time, code, incident, police_grid, neighborhood_number, block)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    await dbRun(insertQuery, [
      case_number,
      dateTime,
      code,
      incident,
      police_grid,
      neighborhood_number,
      block
    ]);

    res.status(200).type('txt').send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).type('txt').send('Internal server error');
  }
});

// DELETE /remove-incident
app.delete('/remove-incident', async (req, res) => {
  try {
    const { case_number } = req.body;
    if (!case_number) return res.status(400).type('txt').send('Missing case_number');

    const existing = await dbSelect('SELECT case_number FROM Incidents WHERE case_number = ?', [case_number]);
    if (existing.length === 0) {
      return res.status(500).type('txt').send('Error: case_number does not exist');
    }

    await dbRun('DELETE FROM Incidents WHERE case_number = ?', [case_number]);
    res.status(200).type('txt').send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).type('txt').send('Internal server error');
  }
});

/********************************************************************
 ***   FALLBACK (optional): if docs exists, serve index.html on /   ***
 ********************************************************************/
if (existsSync(docsDir)) {
  app.get('/', (req, res) => res.sendFile(path.join(docsDir, 'index.html')));
}

/********************************************************************
 ***   START SERVER                                               *** 
 ********************************************************************/
app.listen(port, () => {
  console.log('Now listening on port ' + port);
});
