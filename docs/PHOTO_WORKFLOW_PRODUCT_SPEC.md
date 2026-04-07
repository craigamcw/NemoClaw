# PitLane - Motorsport Photo Workflow Application
# Product Specification v1.0

**Date:** 7 April 2026
**Purpose:** Complete buildable specification for Claude Code

---

## Overview

PitLane is a motorsport photography workflow application for importing, browsing, culling, editing, exporting, and FTP-delivering images to agencies. It replaces the multi-app chain of Photo Mechanic + Lightroom + FileZilla with a single purpose-built tool.

**Hardware Target:** Mac Mini M4 (16GB RAM, 256GB SSD) or MacBook Pro M4 Pro (48GB RAM)
**Camera:** Canon EOS R3 shooting JPEG 100% quality
**Volume:** 2,000-5,000 images per event
**Delivery:** FTP to photo agencies

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | React + Vite | 18.x / 6.x |
| Styling | Tailwind CSS | 4.x |
| Grid Virtualization | @tanstack/react-virtual | 3.x |
| State | Zustand | 5.x |
| Backend | Express.js | 4.x |
| WebSocket | ws | 8.x |
| Image Processing | sharp | 0.33.x |
| EXIF/IPTC | exiftool-vendored | 28.x |
| Database | better-sqlite3 | 11.x |
| FTP | basic-ftp | 5.x |
| File Watching | chokidar | 4.x |

---

## Architecture

```
BROWSER (React + Vite)
  VirtualizedGrid | LoupeView | CompareView
  Zustand store | WebSocket client | Keyboard shortcuts
       |
       | HTTP REST + WebSocket
       v
EXPRESS SERVER (Node.js)
  REST API (/api/*) | WebSocket (progress) | Static (/thumbs, /previews)
       |
       | Worker Threads (non-blocking)
       v
  WORKER POOL
    ThumbnailWorker x4 | PreviewWorker x2 | AnalysisWorker x1
       |
       v
  SQLite DB (better-sqlite3)     FILE SYSTEM
    images, sessions,             /Volumes/[Drive]/
    ratings, exports               originals/ thumbs/ previews/ exports/
```

---

## Database Schema

```sql
-- File: server/db/schema.sql

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  event TEXT,
  date TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  image_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  filename TEXT NOT NULL,
  original_path TEXT NOT NULL,
  thumb_path TEXT,
  preview_path TEXT,
  width INTEGER,
  height INTEGER,
  file_size INTEGER,
  camera TEXT,
  lens TEXT,
  focal_length TEXT,
  shutter_speed TEXT,
  aperture TEXT,
  iso INTEGER,
  date_taken TEXT,
  caption TEXT,
  keywords TEXT,
  rating INTEGER DEFAULT 0,
  color_label TEXT DEFAULT '',
  flagged INTEGER DEFAULT 0,
  selected INTEGER DEFAULT 0,
  sharpness_score REAL,
  exposure_score REAL,
  adjustments TEXT DEFAULT '{}',
  exported INTEGER DEFAULT 0,
  exported_at TEXT,
  imported_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ftp_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER DEFAULT 21,
  user TEXT NOT NULL,
  password TEXT NOT NULL,
  remote_path TEXT DEFAULT '/',
  is_default INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ftp_profile_id TEXT REFERENCES ftp_profiles(id),
  image_count INTEGER,
  status TEXT DEFAULT 'pending',
  progress REAL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id);
CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating);
CREATE INDEX IF NOT EXISTS idx_images_flagged ON images(flagged);
CREATE INDEX IF NOT EXISTS idx_images_color ON images(color_label);
```

---

## API Endpoints

```
POST   /api/sessions                     Create session {name, event, date, folder_path}
GET    /api/sessions                     List sessions
GET    /api/sessions/:id                 Get session with image counts by rating/flag
DELETE /api/sessions/:id                 Delete session and its cached files

POST   /api/sessions/:id/import          Start import from session folder_path
GET    /api/sessions/:id/import/status   Get import progress

GET    /api/sessions/:id/images          List images with filters:
                                          ?rating_gte=3&flagged=1&color=green
                                          &sort=date_taken&order=asc
                                          &offset=0&limit=100
GET    /api/images/:id                   Get single image details
PATCH  /api/images/:id                   Update {rating, flagged, color_label, caption, keywords, adjustments}
POST   /api/images/batch                 Batch update {ids[], updates{}}

GET    /thumbs/:id.jpg                   300px thumbnail (static)
GET    /previews/:id.jpg                 2560px preview (static)
GET    /originals/:id.jpg                Full resolution (proxied from original_path)

POST   /api/ftp-profiles                 Create FTP profile
GET    /api/ftp-profiles                 List FTP profiles
PUT    /api/ftp-profiles/:id             Update FTP profile
DELETE /api/ftp-profiles/:id             Delete FTP profile
POST   /api/ftp-profiles/:id/test        Test FTP connection

POST   /api/sessions/:id/export          Export selected images
                                          {image_ids[], ftp_profile_id, settings{}}
GET    /api/exports/:id/status           Get export/upload progress
```

---

## Import Pipeline

```
POST /api/sessions/:id/import triggers:

1. SCAN (instant)
   - glob folder_path for *.jpg, *.jpeg (case insensitive)
   - Count total files
   - Send WebSocket: {type: "import_started", total: N}

2. REGISTER (fast, ~2ms/image via exiftool batch)
   - Read EXIF: camera, lens, focal_length, shutter, aperture, iso, date_taken
   - Read dimensions, file_size
   - Generate UUID for each image
   - INSERT into SQLite
   - Send WebSocket: {type: "image_registered", id, filename}

3. THUMBNAILS (fast, ~15ms/image, 4 worker threads)
   - Sharp: read JPEG -> resize to 300px width -> quality 80 -> write to thumbs/
   - Send WebSocket: {type: "thumb_ready", id}
   - Frontend adds to grid immediately

4. PREVIEWS (background, ~50ms/image, 2 worker threads)
   - Sharp: read JPEG -> resize to 2560px width -> quality 85 -> write to previews/
   - Send WebSocket: {type: "preview_ready", id}
   - Enables loupe view for this image

5. ANALYSIS (background, optional, ~10ms/image)
   - Sharpness: Laplacian variance on preview
   - Exposure: histogram clipping detection
   - UPDATE scores in SQLite
   - Send WebSocket: {type: "analysis_complete", id, sharpness, exposure}

Timeline for 3000 images:
  Scan:       instant
  Register:   ~6 seconds
  Thumbnails: ~12 seconds (4 workers)
  Previews:   ~40 seconds (2 workers)
  Analysis:   ~30 seconds (1 worker)
  BROWSABLE:  ~18 seconds
  COMPLETE:   ~90 seconds
```

---

## Export Pipeline

```
POST /api/sessions/:id/export triggers:

1. PREPARE
   - Query selected image IDs from request body
   - Create export record in DB
   - Create export directory: exports/[session_name]_[timestamp]/

2. PROCESS (per image, worker threads)
   - Read original JPEG
   - Apply adjustments if any (Sharp):
     exposure, contrast, saturation, sharpness
   - Resize to target (default: 3000px long edge)
   - Set quality (default: 92)
   - Ensure sRGB color space
   - Write IPTC via exiftool: caption, keywords, copyright, contact
   - Save to export directory
   - Send WebSocket: {type: "export_progress", current, total}

3. FTP UPLOAD (if ftp_profile_id provided)
   - Connect to FTP server via basic-ftp
   - Upload each file with progress
   - Send WebSocket: {type: "upload_progress", current, total, filename}
   - Verify upload
   - Mark images as exported in DB

4. COMPLETE
   - Update export record: status=complete, completed_at
   - Send WebSocket: {type: "export_complete", export_id, count}
```

---

## React Components

```
<App>
  <Header>
    <Logo />                         "PitLane" branding
    <SessionSelector />              Dropdown of sessions
    <ImportButton />                 Opens folder picker dialog
    <ViewToggle />                   Grid | Loupe | Compare icons
    <FilterBar>
      <StarFilter />                 Show >= N stars
      <FlagFilter />                 Picks | Rejects | All
      <ColorFilter />                Color label buttons
    </FilterBar>
    <ExportButton />                 Export selected / filtered
  </Header>

  <MainContent>
    {view === 'grid' && (
      <VirtualizedGrid>              @tanstack/react-virtual
        <ImageCell>                   Per visible cell:
          <Thumbnail />               300px cached JPEG
          <RatingOverlay />            Star dots
          <FlagBadge />                Pick/reject icon
          <ColorStripe />              Bottom color bar
          <SelectCheckbox />           Multi-select
        </ImageCell>
      </VirtualizedGrid>
    )}

    {view === 'loupe' && (
      <LoupeView>
        <PreviewImage />              2560px JPEG, CSS object-fit
        <MetadataPanel>               Right sidebar
          <ExifInfo />                 Camera, lens, settings
          <RatingControls />           Clickable stars
          <FlagButtons />              Pick / Reject / Unflag
          <ColorButtons />             6 color options
          <CaptionEditor />            Text input for IPTC caption
          <KeywordEditor />            Tag input for keywords
        </MetadataPanel>
        <Filmstrip />                  Bottom horizontal strip, virtualized
      </LoupeView>
    )}

    {view === 'compare' && (
      <CompareView>
        <PreviewImage />              Left image
        <PreviewImage />              Right image
        <CompareControls />           Swap, zoom sync
      </CompareView>
    )}
  </MainContent>

  <BottomBar>
    <ImageCounter />                 "142 of 3,247 (stars 3+)"
    <ImportProgress />               Progress bar during import
    <QuickRating />                  Star/flag/color buttons
  </BottomBar>

  <ImportDialog />                   Modal: folder path, session name
  <ExportDialog />                   Modal: settings, FTP profile, image selection
  <FTPProfileDialog />               Modal: manage FTP connections
  <SettingsDialog />                 Modal: app preferences
</App>
```

---

## Keyboard Shortcuts

```
NAVIGATION
  Right / Left         Next / Previous image
  Up / Down            Next / Previous row (grid)
  Space                Toggle loupe / grid
  Home / End           First / Last image
  G                    Grid view
  E                    Loupe (edit) view
  C                    Compare view

RATING
  1-5                  Set star rating
  0                    Clear rating
  P                    Flag as Pick
  X                    Flag as Reject
  U                    Unflag
  6                    Color: Red
  7                    Color: Yellow
  8                    Color: Green
  9                    Color: Blue

WORKFLOW
  Cmd+I                Import folder
  Cmd+E                Export selected
  Cmd+A                Select all visible
  Cmd+Shift+A          Deselect all
  Tab                  Show/hide metadata panel
  I                    Toggle info overlay on image
  Delete               Flag as reject

FILTERING
  Cmd+1 through Cmd+5  Filter by minimum stars
  Cmd+0                Show all images
  Cmd+P                Show picks only
  Cmd+X                Show rejects only
```

---

## Project Structure

```
pitlane/
├── package.json
├── vite.config.js
├── tailwind.config.js
├── .env.example
├── server/
│   ├── index.js                 Express + WebSocket entry point
│   ├── routes/
│   │   ├── sessions.js          Session CRUD endpoints
│   │   ├── images.js            Image list, filter, update, batch
│   │   ├── import.js            Import pipeline trigger
│   │   ├── export.js            Export + FTP upload
│   │   └── ftp.js               FTP profile management
│   ├── workers/
│   │   ├── thumbnailWorker.js   Sharp thumbnail generation
│   │   ├── previewWorker.js     Sharp preview generation
│   │   └── analysisWorker.js    Sharpness/exposure scoring
│   ├── services/
│   │   ├── imageProcessor.js    Sharp resize/adjust functions
│   │   ├── exifService.js       EXIF read + IPTC write
│   │   ├── ftpService.js        FTP connect/upload/verify
│   │   ├── importService.js     Orchestrates import pipeline
│   │   └── exportService.js     Orchestrates export pipeline
│   ├── db/
│   │   ├── schema.sql           SQLite schema (above)
│   │   └── database.js          Connection, query helpers
│   └── utils/
│       ├── websocket.js         WS broadcast helpers
│       ├── config.js            Read .env, defaults
│       └── id.js                UUID generation
├── src/
│   ├── main.jsx                 React entry
│   ├── App.jsx                  Root component, routing
│   ├── components/
│   │   ├── Header.jsx
│   │   ├── VirtualizedGrid.jsx
│   │   ├── ImageCell.jsx
│   │   ├── LoupeView.jsx
│   │   ├── CompareView.jsx
│   │   ├── Filmstrip.jsx
│   │   ├── MetadataPanel.jsx
│   │   ├── FilterBar.jsx
│   │   ├── RatingControls.jsx
│   │   ├── ImportDialog.jsx
│   │   ├── ExportDialog.jsx
│   │   ├── FTPProfileDialog.jsx
│   │   ├── ProgressBar.jsx
│   │   └── BottomBar.jsx
│   ├── hooks/
│   │   ├── useImages.js         Fetch + cache image list
│   │   ├── useKeyboard.js       Keyboard shortcut handler
│   │   ├── useWebSocket.js      WS connection + event handling
│   │   └── usePreload.js        Adjacent image prefetching
│   ├── stores/
│   │   └── appStore.js          Zustand: view, filters, selection
│   └── styles/
│       └── index.css            Tailwind base imports
└── scripts/
    └── setup.js                 Initialize DB, create directories
```

---

## Environment Configuration

```bash
# .env.example

# Server
PORT=3000
HOST=0.0.0.0

# Storage paths (use external SSD for photos)
ORIGINALS_BASE=/Volumes/PhotoSSD
CACHE_DIR=.pitlane
EXPORTS_DIR=exports

# Processing limits (tune for hardware)
MAX_THUMBNAIL_WORKERS=4
MAX_PREVIEW_WORKERS=2
THUMBNAIL_WIDTH=300
PREVIEW_WIDTH=2560
JPEG_QUALITY_THUMB=80
JPEG_QUALITY_PREVIEW=85
JPEG_QUALITY_EXPORT=92
EXPORT_LONG_EDGE=3000

# Node.js memory (important for 16GB Mac Mini)
# Start server with: node --max-old-space-size=2048 server/index.js
NODE_OPTIONS=--max-old-space-size=2048

# IPTC defaults
IPTC_COPYRIGHT=© 2026 Craig McWilliams
IPTC_CONTACT_EMAIL=
IPTC_CONTACT_WEBSITE=
```

---

## Memory Budget (16GB Mac Mini)

```
macOS system overhead:           ~4.0 GB
Node.js server (Express + WS):  ~0.5 GB
Node.js heap (max-old-space):   ~2.0 GB (cap)
Thumbnail workers (4 x 150MB):  ~0.6 GB
Preview workers (2 x 200MB):    ~0.4 GB
Analysis worker (1 x 100MB):    ~0.1 GB
SQLite (10k records):           ~0.05 GB
Browser (virtualized grid):     ~2.0 GB
                                 ---------
TOTAL:                           ~9.65 GB
HEADROOM:                        ~6.35 GB
```

---

## Startup Commands

```bash
# First time setup
cd pitlane
npm install
node scripts/setup.js

# Start the application
node --max-old-space-size=2048 server/index.js &
npm run dev

# Or for production
npm run build
node --max-old-space-size=2048 server/index.js
# Frontend served as static files by Express in production
```

---

## Testing Checklist

1. Import 100 JPEGs -> thumbnails appear in grid within 5 seconds
2. Import 3000 JPEGs -> browsable in under 20 seconds
3. Grid scroll 3000+ images -> smooth 60fps, no jank or white flashes
4. Loupe view arrow keys -> image transitions under 100ms
5. Rate image 1-5 -> instant visual feedback, persisted on reload
6. Flag pick/reject -> instant, reflected in filter counts
7. Filter by 3+ stars -> grid updates instantly with correct subset
8. Export 50 images with IPTC -> correct metadata, correct resize, sRGB
9. FTP upload -> files arrive at test FTP server, progress shown
10. App restart -> all ratings, flags, selections preserved
11. Memory stays under 12GB during full 3000-image import
12. No server crashes during rapid browsing while import is running

---

## Build Instructions for Claude Code

```
Build a motorsport photography workflow app called "PitLane" following this spec exactly.

CRITICAL REQUIREMENTS:
1. Thumbnail/preview pipeline on import - NEVER serve full-res to the browser
2. @tanstack/react-virtual for the grid - MUST virtualize, only render visible cells
3. Worker threads for ALL image processing - never block the Express main thread
4. better-sqlite3 for persistence - all state survives server restart
5. WebSocket for real-time import/export progress
6. Keyboard shortcuts exactly as specified - this is a power-user tool
7. Memory-conscious: runs on 16GB Mac Mini, cap Node.js at 2GB heap

BUILD ORDER:
Phase 1: Server + DB + Import pipeline (thumbnails working, images in grid)
Phase 2: Loupe view + keyboard navigation + rating/flagging
Phase 3: Filtering + batch operations + export pipeline
Phase 4: FTP upload + IPTC metadata writing
Phase 5: Compare view + image adjustments + polish

Start with: npm create vite@latest pitlane -- --template react
Then add Express server as a separate process.
```
