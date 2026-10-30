import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { google } from 'googleapis';
import cors from 'cors';
import pLimit from 'p-limit';
import { ZipArchive } from 'archiver';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Google Drive Auth (Place service-account.json in root)
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');

function getDriveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    return null;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_PATH,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return google.drive({ version: 'v3', auth });
  } catch (err) {
    console.warn(`Could not initialize Google Drive client: ${err.message}`);
    return null;
  }
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Endpoint 0: Check backend status & service-account.json presence
app.get('/api/status', (req, res) => {
  const hasServiceAccount = fs.existsSync(SERVICE_ACCOUNT_PATH);
  res.json({
    status: 'ok',
    serviceAccountConfigured: hasServiceAccount,
    timestamp: new Date().toISOString(),
  });
});

// Helper: Format bytes into readable KB / MB
function formatBytesToMB(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return { sizeBytes: null, sizeFormatted: 'Unknown size' };
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    const kb = (bytes / 1024).toFixed(0);
    return { sizeBytes: bytes, sizeFormatted: `${kb} KB` };
  }
  return { sizeBytes: bytes, sizeFormatted: `${mb.toFixed(2)} MB` };
}

// Helper: Fetch PDF file size without downloading the file body
async function fetchPdfSize(pdfUrl, customHeaders = {}) {
  const headers = { ...DEFAULT_HEADERS, ...customHeaders };
  try {
    // 1. Try lightweight HEAD request first
    const headRes = await axios.head(pdfUrl, {
      headers,
      timeout: 4500,
      signal: AbortSignal.timeout(4500),
      maxRedirects: 5,
    });
    const contentLength = parseInt(headRes.headers['content-length'], 10);
    if (contentLength) return formatBytesToMB(contentLength);
  } catch (_) {
    // Fallback if server blocks HEAD requests
  }

  try {
    // 2. Fallback: Request only the first byte via Range header
    const rangeRes = await axios.get(pdfUrl, {
      headers: { ...headers, Range: 'bytes=0-0' },
      responseType: 'stream',
      timeout: 4500,
      signal: AbortSignal.timeout(4500),
      maxRedirects: 5,
    });
    // Immediately destroy stream so we don't download the file
    rangeRes.data.destroy();

    const contentRange = rangeRes.headers['content-range'];
    if (contentRange && contentRange.includes('/')) {
      const totalBytes = parseInt(contentRange.split('/')[1], 10);
      if (totalBytes) return formatBytesToMB(totalBytes);
    }

    const fallbackLength = parseInt(rangeRes.headers['content-length'], 10);
    if (fallbackLength > 1) return formatBytesToMB(fallbackLength);
  } catch (_) {}

  return { sizeBytes: null, sizeFormatted: 'Unknown size' };
}

// Helper: Extract PDFs from HTML and filter by keyword
function extractPdfsFromHtml(html, baseUrl, keyword) {
  const $ = cheerio.load(html);
  const pdfMap = new Map();
  const kw = (keyword || '').trim().toLowerCase();
  const genericLabels = new Set([
    'download', 'download pdf', 'get pdf', 'pdf', 'click here',
    'download full book', 'view pdf', 'link', 'full text', 'read pdf',
    'download now', 'file', 'attachment'
  ]);

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const cleanHref = href.split('?')[0].toLowerCase();
    if (!cleanHref.endsWith('.pdf')) return;

    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      const rawFilename = decodeURIComponent(absoluteUrl.split('/').pop().split('?')[0]) || 'book.pdf';
      const linkText = $(el).text().trim();
      const parentContainer = $(el).closest('div, li, tr, article, p, section');
      const parentContext = parentContainer.text().trim();

      // Match keyword against filename, anchor text, or surrounding paragraph/card text
      const searchableText = `${rawFilename} ${linkText} ${parentContext}`.toLowerCase();

      if (!kw || searchableText.includes(kw)) {
        let displayTitle = linkText;
        const heading = parentContainer.find('h1, h2, h3, h4, h5, h6, strong, b').first().text().trim();

        if ((!displayTitle || displayTitle.length <= 3 || genericLabels.has(displayTitle.toLowerCase())) && heading) {
          displayTitle = heading;
        } else if (!displayTitle || displayTitle.length <= 3) {
          displayTitle = rawFilename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
        }

        const safeFilename = rawFilename.endsWith('.pdf') ? rawFilename : `${rawFilename}.pdf`;

        pdfMap.set(absoluteUrl, {
          url: absoluteUrl,
          title: displayTitle,
          filename: safeFilename,
        });
      }
    } catch (_) {}
  });

  return Array.from(pdfMap.values());
}

// Helper 1: Fetch a Map of all existing PDFs in the target Google Drive folder
async function getExistingDriveFilesMap(folderId, driveInstance) {
  const driveClient = driveInstance || getDriveClient();
  const existingMap = new Map(); // filename (lowercase) -> { id, webViewLink, size }
  if (!folderId || !driveClient) return existingMap;

  try {
    let pageToken = null;
    do {
      const res = await driveClient.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
        fields: 'nextPageToken, files(id, name, webViewLink, size)',
        pageSize: 500,
        pageToken,
      });

      for (const file of res.data.files || []) {
        existingMap.set((file.name || '').toLowerCase(), {
          id: file.id,
          link: file.webViewLink,
          sizeBytes: file.size ? parseInt(file.size, 10) : null,
        });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.warn(`Could not pre-scan Drive folder: ${err.message}`);
  }

  return existingMap;
}

// Helper 2: Single-file duplicate check right before streaming to Drive
async function findExistingFileInDrive(filename, folderId, driveInstance) {
  const driveClient = driveInstance || getDriveClient();
  if (!folderId || !driveClient || !filename) return null;
  const escapedName = filename.replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and '${folderId}' in parents and trashed = false`;

  try {
    const res = await driveClient.files.list({
      q,
      fields: 'files(id, name, webViewLink, size)',
      pageSize: 1,
    });

    return res.data.files && res.data.files.length > 0 ? res.data.files[0] : null;
  } catch (_) {
    return null;
  }
}

// Helper: Resolve the exact downloadable PDF file and size from Internet Archive item metadata
async function resolveArchivePdf(doc) {
  try {
    const metaRes = await axios.get(`https://archive.org/metadata/${doc.identifier}/files`, {
      timeout: 5000,
      headers: DEFAULT_HEADERS,
    });
    const files = metaRes.data?.result || [];
    // Prioritize original or standard PDF, skip OCR-only _text.pdf if a better PDF exists
    const pdfFiles = files.filter(f => f.name && f.name.toLowerCase().endsWith('.pdf') && !f.name.toLowerCase().endsWith('_text.pdf'));
    const chosenFile = pdfFiles[0] || files.find(f => f.name && f.name.toLowerCase().endsWith('.pdf'));
    if (!chosenFile) return null;

    const sizeBytes = chosenFile.size ? parseInt(chosenFile.size, 10) : null;
    const downloadUrl = `https://archive.org/download/${doc.identifier}/${encodeURIComponent(chosenFile.name)}`;
    const cleanFilename = chosenFile.name.replace(/[^a-zA-Z0-9._\-]/g, '_');

    let author = 'Unknown Author';
    if (Array.isArray(doc.creator)) author = doc.creator.join(', ');
    else if (doc.creator) author = String(doc.creator);

    return {
      url: downloadUrl,
      title: doc.title || doc.identifier,
      author,
      year: doc.year || null,
      coverUrl: `https://archive.org/services/img/${doc.identifier}`,
      filename: cleanFilename.endsWith('.pdf') ? cleanFilename : `${cleanFilename}.pdf`,
      sizeBytes,
      sizeFormatted: sizeBytes ? formatBytesToMB(sizeBytes).sizeFormatted : 'Unknown size',
      source: 'Internet Archive',
    };
  } catch (_) {
    return null;
  }
}

// Universal Book Search: Internet Archive open database
async function searchInternetArchive(keyword, folderId, drive) {
  const kw = (keyword || '').trim().replace(/[^\w\s-]/g, ' ').trim();
  let searchQ = 'mediatype:texts AND (format:pdf OR format:"Text PDF")';
  if (kw) {
    searchQ = `(title:("${kw}") OR creator:("${kw}") OR title:(${kw}) OR creator:(${kw})) AND mediatype:texts`;
  }

  const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQ)}&fl[]=identifier,title,creator,downloads,year&sort[]=downloads+desc&rows=35&page=1&output=json`;

  const { data } = await axios.get(searchUrl, {
    headers: DEFAULT_HEADERS,
    timeout: 10000,
  });

  const docs = data.response?.docs || [];
  const limit = pLimit(8);

  const [existingDriveMap, resolvedList] = await Promise.all([
    getExistingDriveFilesMap(folderId, drive),
    Promise.all(
      docs.map(doc => limit(async () => resolveArchivePdf(doc)))
    ),
  ]);

  const validBooks = resolvedList.filter(Boolean);

  const finalBooks = validBooks.map(book => {
    const existing = existingDriveMap.get(book.filename.toLowerCase());
    return {
      ...book,
      existsInDrive: Boolean(existing),
      driveLink: existing ? existing.link : null,
      driveFileId: existing ? existing.id : null,
    };
  });

  return { count: finalBooks.length, pdfs: finalBooks, mode: 'library' };
}

// Website URL Scanner
async function searchWebsitePdfs(siteUrl, keyword, folderId, cookie, userAgent, drive) {
  let targetUrl = siteUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  const parsedBase = new URL(targetUrl);
  const requestHeaders = {
    ...DEFAULT_HEADERS,
    ...(userAgent ? { 'User-Agent': userAgent } : {}),
    ...(cookie ? { 'Cookie': cookie } : {}),
  };

  const urlsToScan = [targetUrl];
  if (keyword && keyword.trim()) {
    const encodedKw = encodeURIComponent(keyword.trim());
    urlsToScan.push(`${parsedBase.origin}/?s=${encodedKw}`);
    urlsToScan.push(`${parsedBase.origin}/search?q=${encodedKw}`);
  }

  const allResults = new Map();
  const subPagesToCrawl = new Set();
  const kw = (keyword || '').trim().toLowerCase();
  let primaryError = null;

  for (const url of urlsToScan) {
    try {
      const { data: html } = await axios.get(url, {
        headers: requestHeaders,
        timeout: 10000,
        maxRedirects: 5,
      });

      const foundPdfs = extractPdfsFromHtml(html, url, keyword);
      foundPdfs.forEach(item => allResults.set(item.url, item));

      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().toLowerCase();
        if (href && (!kw || text.includes(kw) || href.toLowerCase().includes(kw))) {
          try {
            const abs = new URL(href, url);
            if (abs.origin === parsedBase.origin && !abs.pathname.toLowerCase().endsWith('.pdf')) {
              subPagesToCrawl.add(abs.href);
            }
          } catch (_) {}
        }
      });
    } catch (err) {
      if (!primaryError) primaryError = err;
      console.warn(`Failed to scan ${url}: ${err.message}`);
    }
  }

  // Check if site blocked request via Cloudflare / 403 / Timeout
  if (allResults.size === 0 && subPagesToCrawl.size === 0 && primaryError) {
    const status = primaryError.response?.status;
    const headers = primaryError.response?.headers || {};
    const isCloudflare = headers['cf-mitigated'] || headers['cf-ray'] || headers['server'] === 'cloudflare';

    if (status === 403 && isCloudflare) {
      const errObj = new Error(
        `Access Blocked: ${parsedBase.hostname} is protected by Cloudflare bot defense (HTTP 403). Automated requests without a clearance cookie are rejected.`
      );
      errObj.isCloudflareProtected = true;
      errObj.suggestLibrarySearch = true;
      errObj.hostname = parsedBase.hostname;
      errObj.keyword = keyword || '';
      throw errObj;
    }

    if (status === 403) {
      const errObj = new Error(`Access Denied (HTTP 403): ${parsedBase.hostname} blocked the request.`);
      errObj.hostname = parsedBase.hostname;
      errObj.suggestLibrarySearch = true;
      throw errObj;
    }

    if (primaryError.code === 'ECONNABORTED' || primaryError.message?.includes('timeout')) {
      const errObj = new Error(`Connection to ${parsedBase.hostname} timed out.`);
      errObj.hostname = parsedBase.hostname;
      errObj.suggestLibrarySearch = true;
      throw errObj;
    }
  }

  // Crawl up to 8 matching subpages
  const limit = pLimit(4);
  const subPageArray = Array.from(subPagesToCrawl).slice(0, 8);
  await Promise.all(
    subPageArray.map(subUrl =>
      limit(async () => {
        try {
          const { data: subHtml } = await axios.get(subUrl, {
            headers: requestHeaders,
            timeout: 10000,
            maxRedirects: 5,
          });
          const subPdfs = extractPdfsFromHtml(subHtml, subUrl, '');
          subPdfs.forEach(item => allResults.set(item.url, item));
        } catch (_) {}
      })
    )
  );

  const rawPdfs = Array.from(allResults.values());
  const sizeLimit = pLimit(6);

  const [existingDriveMap, pdfsWithSize] = await Promise.all([
    getExistingDriveFilesMap(folderId, drive),
    Promise.all(
      rawPdfs.map(pdf =>
        sizeLimit(async () => {
          const sizeInfo = await fetchPdfSize(pdf.url, requestHeaders);
          return {
            ...pdf,
            sizeBytes: sizeInfo.sizeBytes,
            sizeFormatted: sizeInfo.sizeFormatted,
            source: parsedBase.hostname,
          };
        })
      )
    ),
  ]);

  const finalPdfs = pdfsWithSize.map(pdf => {
    const existing = existingDriveMap.get((pdf.filename || '').toLowerCase());
    return {
      ...pdf,
      existsInDrive: Boolean(existing),
      driveLink: existing ? existing.link : null,
      driveFileId: existing ? existing.id : null,
    };
  });

  return { count: finalPdfs.length, pdfs: finalPdfs, mode: 'site' };
}

// 1. SCAN & SEARCH ENDPOINT (Universal Book Library OR Custom Site URL)
app.post('/api/search-pdfs', async (req, res) => {
  const { siteUrl, keyword, folderId, mode = 'library', cookie, userAgent } = req.body;
  const drive = getDriveClient();

  try {
    // If mode is 'library' or no URL provided or URL is 'library'/'archive.org':
    if (mode === 'library' || !siteUrl || siteUrl.trim() === 'library' || siteUrl.toLowerCase().includes('archive.org')) {
      const results = await searchInternetArchive(keyword, folderId, drive);
      return res.json(results);
    }

    // Otherwise, scan the provided website URL
    const results = await searchWebsitePdfs(siteUrl, keyword, folderId, cookie, userAgent, drive);
    return res.json(results);
  } catch (err) {
    console.error('Search error:', err.message);
    return res.status(err.isCloudflareProtected ? 403 : 500).json({
      error: err.message,
      isCloudflareProtected: Boolean(err.isCloudflareProtected),
      suggestLibrarySearch: Boolean(err.suggestLibrarySearch),
      hostname: err.hostname || null,
      keyword: err.keyword || keyword || '',
    });
  }
});

// Check size of a single PDF on-demand
app.get('/api/pdf-size', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url query param' });
  const sizeInfo = await fetchPdfSize(String(url));
  res.json(sizeInfo);
});

// 2. SINGLE LOCAL DOWNLOAD (Streams directly to user's computer with Content-Length)
app.get('/api/download-local', async (req, res) => {
  const { url, filename, cookie } = req.query;
  if (!url) return res.status(400).send('Missing URL');

  try {
    const response = await axios({
      method: 'GET',
      url: String(url),
      responseType: 'stream',
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookie ? { 'Cookie': String(cookie) } : {}),
      },
      maxRedirects: 5,
    });

    const cleanName = String(filename || 'book.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanName.endsWith('.pdf') ? cleanName : `${cleanName}.pdf`}"`);
    res.setHeader('Content-Type', 'application/pdf');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send(`Failed to download file: ${err.message}`);
  }
});

// 3. BULK LOCAL DOWNLOAD (Streams all selected PDFs as a single .ZIP file)
app.post('/api/download-zip', async (req, res) => {
  const { pdfs, cookie } = req.body; // [{ url, filename }]
  if (!pdfs || !pdfs.length) return res.status(400).json({ error: 'No PDFs selected' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="books-bundle.zip"');

  const archive = new ZipArchive({ zlib: { level: 5 } });

  archive.on('error', (err) => {
    console.error('Archiver error:', err);
    if (!res.headersSent) {
      res.status(500).send({ error: err.message });
    }
  });

  archive.pipe(res);

  const seenFilenames = new Map();

  for (const pdf of pdfs) {
    try {
      const response = await axios({
        method: 'GET',
        url: pdf.url,
        responseType: 'stream',
        headers: {
          ...DEFAULT_HEADERS,
          ...(cookie ? { 'Cookie': String(cookie) } : {}),
        },
        timeout: 30000,
        maxRedirects: 5,
      });

      let baseName = (pdf.filename || 'book.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
      if (!baseName.toLowerCase().endsWith('.pdf')) baseName += '.pdf';

      let finalName = baseName;
      if (seenFilenames.has(baseName)) {
        const count = seenFilenames.get(baseName) + 1;
        seenFilenames.set(baseName, count);
        const namePart = baseName.replace(/\.pdf$/i, '');
        finalName = `${namePart} (${count}).pdf`;
      } else {
        seenFilenames.set(baseName, 0);
      }

      archive.append(response.data, { name: finalName });
    } catch (err) {
      console.error(`Skipping ${pdf.url}: ${err.message}`);
    }
  }

  await archive.finalize();
});

// Store connected SSE clients by sessionId
const sseClients = new Map();

// SSE Endpoint: Frontend connects here to listen for live progress events
app.get('/api/progress-stream', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.set(String(sessionId), res);

  req.on('close', () => {
    sseClients.delete(String(sessionId));
  });
});

// Helper: Push progress payload to a specific frontend session
function emitProgress(sessionId, payload) {
  if (!sessionId) return;
  const client = sseClients.get(String(sessionId));
  if (client) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// Endpoint to pre-check existing files in a Google Drive folder
app.post('/api/check-drive-duplicates', async (req, res) => {
  const { folderId } = req.body;
  if (!folderId) return res.json({ existingFiles: [] });

  const drive = getDriveClient();
  if (!drive) return res.status(400).json({ error: 'Google Drive service account not configured' });

  const existingMap = await getExistingDriveFilesMap(folderId.trim(), drive);
  const files = Array.from(existingMap.entries()).map(([name, data]) => ({
    name,
    ...data,
  }));
  res.json({ count: files.length, existingFiles: files });
});

// 4. Google Drive Upload with Real-Time Byte Tracking & Duplicate Detection
app.post('/api/upload-drive', async (req, res) => {
  const { pdfs, folderId, sessionId, forceOverwrite = false, cookie } = req.body;
  if (!pdfs || !Array.isArray(pdfs) || pdfs.length === 0) {
    return res.status(400).json({ error: 'No PDFs provided for upload.' });
  }

  const drive = getDriveClient();
  if (!drive) {
    const errorMsg = 'Google Drive is not configured. Please place your service-account.json in the project root directory.';
    pdfs.forEach(pdf => {
      emitProgress(sessionId, {
        url: pdf.url,
        status: 'failed',
        progress: 0,
        error: errorMsg,
      });
    });
    return res.status(400).json({
      error: errorMsg,
      results: pdfs.map(pdf => ({
        url: pdf.url,
        filename: pdf.filename,
        status: 'failed',
        error: 'service-account.json missing on server'
      }))
    });
  }

  const targetFolder = folderId && folderId.trim() ? folderId.trim() : null;
  const existingFilesMap = (!forceOverwrite && targetFolder)
    ? await getExistingDriveFilesMap(targetFolder, drive)
    : new Map();

  const limit = pLimit(3);

  const tasks = pdfs.map(pdf =>
    limit(async () => {
      try {
        const safeName = (pdf.filename || 'book.pdf').trim();

        // 1. Check if the PDF already exists in the target Drive folder
        if (!forceOverwrite && targetFolder) {
          const existingFile = existingFilesMap.get(safeName.toLowerCase()) ||
            await findExistingFileInDrive(safeName, targetFolder, drive);

          if (existingFile) {
            const fileLink = existingFile.link || existingFile.webViewLink;
            emitProgress(sessionId, {
              url: pdf.url,
              status: 'skipped-duplicate',
              progress: 100,
              link: fileLink,
            });

            return {
              url: pdf.url,
              filename: safeName,
              status: 'skipped-duplicate',
              link: fileLink,
            };
          }
        }

        // 2. Otherwise proceed with normal stream download + Drive upload
        emitProgress(sessionId, { url: pdf.url, status: 'uploading', progress: 0 });

        const response = await axios({
          method: 'GET',
          url: pdf.url,
          responseType: 'stream',
          headers: {
            ...DEFAULT_HEADERS,
            ...(cookie ? { 'Cookie': String(cookie) } : {}),
          },
          timeout: 60000,
          maxRedirects: 5,
        });

        const totalBytes =
          parseInt(response.headers['content-length'], 10) || pdf.sizeBytes || 0;
        let transferredBytes = 0;
        let lastEmittedPercent = 0;

        const monitorStream = new PassThrough();
        response.data.on('data', chunk => {
          transferredBytes += chunk.length;
          if (totalBytes > 0) {
            const percent = Math.min(99, Math.round((transferredBytes / totalBytes) * 100));
            if (percent - lastEmittedPercent >= 2) {
              lastEmittedPercent = percent;
              emitProgress(sessionId, {
                url: pdf.url,
                status: 'uploading',
                progress: percent,
                transferredMB: (transferredBytes / (1024 * 1024)).toFixed(2),
              });
            }
          } else {
            emitProgress(sessionId, {
              url: pdf.url,
              status: 'uploading',
              progress: null,
              transferredMB: (transferredBytes / (1024 * 1024)).toFixed(2),
            });
          }
        });

        response.data.pipe(monitorStream);

        const driveRes = await drive.files.create({
          requestBody: {
            name: safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`,
            mimeType: 'application/pdf',
            parents: targetFolder ? [targetFolder] : [],
          },
          media: {
            mimeType: 'application/pdf',
            body: monitorStream,
          },
          fields: 'id, name, webViewLink',
        });

        emitProgress(sessionId, {
          url: pdf.url,
          status: 'success',
          progress: 100,
          link: driveRes.data.webViewLink,
        });

        return {
          url: pdf.url,
          filename: safeName,
          status: 'success',
          link: driveRes.data.webViewLink,
        };
      } catch (err) {
        emitProgress(sessionId, {
          url: pdf.url,
          status: 'failed',
          progress: 0,
          error: err.message,
        });
        return { url: pdf.url, filename: pdf.filename, status: 'failed', error: err.message };
      }
    })
  );

  const results = await Promise.all(tasks);
  res.json({ results });
});

// Fallback to index.html for non-API GET routes
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }
  next();
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Scraper backend and UI running at http://localhost:${PORT}`);
});
