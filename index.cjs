/**
 * Codex — Serveur local
 * Lance avec : node server/index.js
 *
 * Routes :
 *   GET /api/isbn/:isbn        → infos du livre (titre, auteur, synopsis...)
 *   GET /api/cover/:isbn       → couverture en base64
 *   GET /api/health            → vérification que le serveur tourne
 */

const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Clé Google Books ─────────────────────────────────────────────────────────
// Mets ta clé ici (même que dans App.jsx)
const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";

// ─── Cache local des couvertures ──────────────────────────────────────────────
const COVERS_DIR = path.join(__dirname, "covers");
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

// ─── CORS : autorise React en dev (localhost:5173) ───────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// Sert les couvertures stockées localement
app.use("/covers", express.static(COVERS_DIR));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractYear(str) {
  if (!str) return "";
  const match = String(str).match(/\d{4}/);
  return match ? match[0] : "";
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      // Suit les redirections
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

async function fetchJson(url) {
  const { body, status } = await fetchUrl(url);
  if (status !== 200) return null;
  return JSON.parse(body.toString("utf8"));
}

// ─── Source 1 : Google Books ──────────────────────────────────────────────────
async function fromGoogleBooks(isbn) {
  try {
    const key = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : "";
    const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${key}`);
    if (!data?.totalItems || !data.items?.length) return null;

    const info = data.items[0].volumeInfo;
    const volumeId = data.items[0].id;

    // Couverture : imageLinks ou URL construite depuis l'ID volume
    let coverUrl = null;
    if (info.imageLinks) {
      coverUrl =
        info.imageLinks.extraLarge ||
        info.imageLinks.large ||
        info.imageLinks.medium ||
        info.imageLinks.thumbnail ||
        null;
      if (coverUrl) coverUrl = coverUrl.replace(/^http:/, "https:").replace("&zoom=1", "");
    }
    // Fallback : URL directe Google Books (fonctionne même sans imageLinks)
    if (!coverUrl && volumeId) {
      coverUrl = `https://books.google.com/books/content?id=${volumeId}&printsec=frontcover&img=1&zoom=5&source=gbs_api`;
    }

    return {
      title: info.title || "",
      author: info.authors?.join(", ") || "",
      publisher: info.publisher || "",
      year: extractYear(info.publishedDate),
      coverUrl,
      synopsis: info.description || "",
      isbn,
      _source: "Google Books",
    };
  } catch (err) {
    console.error("[Google Books]", err.message);
    return null;
  }
}

// ─── Source 2 : BnF ───────────────────────────────────────────────────────────
async function fromBnF(isbn) {
  try {
    const query = encodeURIComponent(`bib.isbn adj "${isbn}"`);
    const { body, status } = await fetchUrl(
      `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${query}&maximumRecords=1&recordSchema=dublincore`
    );
    if (status !== 200) return null;
    const xml = body.toString("utf8");

    if (!xml.includes("<srw:record>")) return null;

    // Parse Dublin Core depuis le XML brut (pas de lib XML pour rester léger)
    const getDC = (tag) => {
      const re = new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, "i");
      const m = xml.match(re);
      return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
    };
    const getAllDC = (tag) => {
      const re = new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, "gi");
      const results = [];
      let m;
      while ((m = re.exec(xml)) !== null) {
        results.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      return results;
    };

    const title = getDC("title");
    if (!title) return null;

    const authors = getAllDC("creator");
    const author = authors.join(", ");

    const publishers = getAllDC("publisher");
    let publisher = "";
    let year = "";
    for (const p of publishers) {
      const yearMatch = p.match(/\b(\d{4})\b/);
      if (yearMatch && !year) year = yearMatch[1];
      const clean = p.replace(/,?\s*\d{4}.*$/, "").trim();
      if (clean && !publisher) publisher = clean;
    }
    if (!year) year = extractYear(getDC("date"));

    const synopsis = getDC("description");

    return {
      title,
      author,
      publisher,
      year,
      coverUrl: null, // BnF n'expose pas les images
      synopsis,
      isbn,
      _source: "BnF",
    };
  } catch (err) {
    console.error("[BnF]", err.message);
    return null;
  }
}

// ─── Source 3 : Open Library ──────────────────────────────────────────────────
async function fromOpenLibrary(isbn) {
  try {
    const data = await fetchJson(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
    );
    const book = data?.[`ISBN:${isbn}`];
    if (!book) return null;

    let coverUrl =
      book.cover?.large ||
      book.cover?.medium ||
      `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;

    let synopsis = "";
    if (book.description) {
      synopsis = typeof book.description === "string"
        ? book.description
        : book.description.value || "";
    }
    if (!synopsis && book.works?.[0]?.key) {
      try {
        const work = await fetchJson(`https://openlibrary.org${book.works[0].key}.json`);
        if (work?.description) {
          synopsis = typeof work.description === "string"
            ? work.description
            : work.description.value || "";
        }
      } catch (_) {}
    }

    return {
      title: book.title || "",
      author: book.authors?.map((a) => a.name).join(", ") || "",
      publisher: book.publishers?.map((p) => p.name).join(", ") || "",
      year: extractYear(book.publish_date),
      coverUrl,
      synopsis,
      isbn,
      _source: "Open Library",
    };
  } catch (err) {
    console.error("[Open Library]", err.message);
    return null;
  }
}


// ─── Conversion ISBN13 → ISBN10 ───────────────────────────────────────────────
function isbn13to10(isbn13) {
  if (isbn13.length !== 13 || !isbn13.startsWith("978")) return null;
  const digits = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * parseInt(digits[i]);
  const check = (11 - (sum % 11)) % 11;
  return digits + (check === 10 ? "X" : String(check));
}

// ─── Source 4 : Amazon (couverture uniquement) ────────────────────────────────
async function coverFromAmazon(isbn) {
  try {
    // Convertir en ISBN10 si nécessaire (Amazon utilise ISBN10)
    const isbn10 = isbn.length === 13 ? isbn13to10(isbn) : isbn;
    if (!isbn10) return null;

    // Amazon stocke les couvertures à cette URL prévisible
    const url = `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.jpg`;
    console.log(`[Amazon] Tentative couverture: ${url}`);

    const { body, status } = await fetchUrl(url);
    // Amazon renvoie une image 1x1 pixel (43 bytes) si pas de couverture
    if (status !== 200 || body.length < 5000) {
      console.log(`[Amazon] Pas de couverture (${body.length} bytes)`);
      return null;
    }
    console.log(`[Amazon] Couverture trouvée (${body.length} bytes)`);
    return url;
  } catch (err) {
    console.error("[Amazon]", err.message);
    return null;
  }
}

// ─── Fusion des sources ───────────────────────────────────────────────────────
function merge(...sources) {
  const result = { title: "", author: "", publisher: "", year: "", coverUrl: null, synopsis: "", isbn: "", _sources: [] };
  for (const src of sources) {
    if (!src) continue;
    let used = false;
    for (const key of ["title", "author", "publisher", "year", "coverUrl", "synopsis", "isbn"]) {
      if (!result[key] && src[key]) { result[key] = src[key]; used = true; }
    }
    if (used) result._sources.push(src._source);
  }
  return result;
}

// ─── Téléchargement et cache de la couverture ─────────────────────────────────
async function downloadCover(isbn, coverUrl) {
  // Déjà en cache ?
  const cached = [".jpg", ".png", ".webp"]
    .map((ext) => path.join(COVERS_DIR, `${isbn}${ext}`))
    .find((f) => fs.existsSync(f));
  if (cached) {
    console.log(`[Cover] Cache hit: ${isbn}`);
    return `/covers/${path.basename(cached)}`;
  }

  // Liste des URLs à essayer dans l'ordre
  const candidates = [];
  if (coverUrl) candidates.push(coverUrl);

  // Toujours essayer Amazon en complément
  const amazonUrl = await coverFromAmazon(isbn);
  if (amazonUrl && amazonUrl !== coverUrl) candidates.push(amazonUrl);

  // Fallback Open Library large
  candidates.push(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`);

  for (const url of candidates) {
    try {
      console.log(`[Cover] Essai: ${url}`);
      const { body, status, headers } = await fetchUrl(url);
      // Rejette les placeholders (trop petits)
      if (status !== 200 || body.length < 5000) {
        console.log(`[Cover] Rejeté (${body.length} bytes)`);
        continue;
      }
      const ct = headers["content-type"] || "";
      const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ".jpg";
      const filePath = path.join(COVERS_DIR, `${isbn}${ext}`);
      fs.writeFileSync(filePath, body);
      console.log(`[Cover] ✅ Sauvegardé depuis ${url}`);
      return `/covers/${isbn}${ext}`;
    } catch (err) {
      console.error(`[Cover] Erreur sur ${url}:`, err.message);
    }
  }

  console.log(`[Cover] ❌ Aucune couverture trouvée pour ${isbn}`);
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Sanity check
app.get("/api/health", (_, res) => res.json({ ok: true, version: "1.0.0", key: GOOGLE_BOOKS_API_KEY ? "ok" : "manquante" }));

// Infos complètes par ISBN (métadonnées + couverture téléchargée)
app.get("/api/isbn/:isbn", async (req, res) => {
  const isbn = req.params.isbn.replace(/[^0-9X]/gi, "");
  if (isbn.length !== 10 && isbn.length !== 13) {
    return res.status(400).json({ error: "ISBN invalide" });
  }

  console.log(`\n[ISBN] Recherche: ${isbn}`);

  // Cascade parallèle — Cultura en premier pour les données FR
  const [c, g, b, o] = await Promise.allSettled([
    fromCultura(isbn),
    fromGoogleBooks(isbn),
    fromBnF(isbn),
    fromOpenLibrary(isbn),
  ]);

  const result = merge(
    c.status === "fulfilled" ? c.value : null,
    g.status === "fulfilled" ? g.value : null,
    b.status === "fulfilled" ? b.value : null,
    o.status === "fulfilled" ? o.value : null,
  );

  if (!result.title) {
    return res.status(404).json({ error: "Introuvable" });
  }

  console.log(`[ISBN] Trouvé via: ${result._sources.join(" + ")}`);

  // Télécharge et stocke la couverture
  const localCover = await downloadCover(isbn, result.coverUrl);

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  result.cover = localCover
    ? `${baseUrl}${localCover}`
    : result.coverUrl || "";

  delete result.coverUrl;
  res.json(result);
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Codex serveur démarré sur http://localhost:${PORT}`);
  console.log(`   → Couvertures stockées dans : ${COVERS_DIR}`);
  console.log(`   → Test : http://localhost:${PORT}/api/health\n`);
});