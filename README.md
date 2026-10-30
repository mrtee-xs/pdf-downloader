# PDF Archivist 📚⚡

A full-stack, high-performance **Universal PDF Book Finder & Dual Streamer** built with Node.js, Express, React 18, and Tailwind CSS.

---

## Features

- **Universal Book Search (250,000+ Titles):** Instantly search and retrieve books by title, author, or keyword directly from open digital libraries without Cloudflare blocks.
- **Custom Website Scanner:** Crawl any target website (OpenStax, university repositories, documentation directories, public portals) to uncover direct `.pdf` anchors and detail subpages.
- **Dual Streaming Architecture:**
  - **Local Device Download:** Direct chunk-by-chunk download with real-time percentage and byte tracking (`fetch` stream reader).
  - **Local Bulk ZIP Streaming:** Bundles selected books into a single `.zip` file on the fly with no local server disk bloat.
  - **Google Drive Stream:** Streams binary PDF data straight from the remote source into your target Google Drive folder via memory PassThrough streams (zero local disk persistence).
- **Drive Duplicate Detection:** Automatically checks your target Google Drive folder prior to upload, displaying a `✓ Already in Drive` badge and skipping redundant uploads (with optional force re-upload overwrite).
- **Real-Time Progress Tracking:** Server-Sent Events (SSE) connection broadcasts live transfer progress (0–100% and transferred MB) for Google Drive uploads.
- **Minimalist Dark Mode UI:** Glassmorphic modern interface styled with Tailwind CSS and Lucide icons.

---

## Quick Start

### 1. Installation

```bash
git clone https://github.com/mrtee-xs/pdf-downloader.git
cd pdf-downloader
npm install
```

### 2. Start the Server

```bash
npm start
```

Open [http://localhost:4000](http://localhost:4000) in your web browser.

---

## Google Drive Setup

To enable saving books straight to your Google Drive:

1. **Google Cloud Console:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/).
   - Create a project (or select an existing one).
   - Enable the **Google Drive API**.
2. **Create a Service Account:**
   - Navigate to **APIs & Services > Credentials > Create Credentials > Service Account**.
   - Create the service account and go to the **Keys** tab.
   - Click **Add Key > Create new key > JSON**.
3. **Add Key to Project:**
   - Save the downloaded file into the root directory of this project as:
     ```
     service-account.json
     ```
4. **Share Your Target Folder:**
   - In Google Drive, create or open the folder where you want books saved.
   - Right-click the folder > **Share**.
   - Paste the `client_email` address from your `service-account.json` (e.g. `your-service-account@your-project.iam.gserviceaccount.com`) and grant it **Editor** permissions.
5. **Set the Folder ID in the App:**
   - Copy the folder ID from your Google Drive URL:
     `drive.google.com/drive/folders/<FOLDER_ID>`
   - Paste it into the **Drive Folder ID** input in the app header (it persists automatically in `localStorage`).

---

## Tech Stack

- **Backend:** Node.js, Express 5, Axios, Cheerio, Google APIs (`googleapis`), Archiver, p-limit
- **Frontend:** React 18, Tailwind CSS, Lucide SVG Icons, Server-Sent Events (SSE)
- **Runtime:** Native ES Modules (`type: module`)

---

## License

MIT
