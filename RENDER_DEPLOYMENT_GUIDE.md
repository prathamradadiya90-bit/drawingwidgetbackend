# Drawing Widget iOS Backend — Render & Git Deployment Guide

This guide provides step-by-step instructions for pushing the backend project to your own GitHub/GitLab account and deploying it to Render using either the 1-click `render.yaml` Blueprint or manual configuration.

---

## Overview of What Was Added

A [`render.yaml`](file:///Users/pc/Documents/Drawingwidgetiosdeploy/render.yaml) blueprint file has been created in your repository root. This file automates the creation and connection of:
1. **PostgreSQL Database** (`drawing-widget-db`)
2. **Node.js Web Service** (`drawing-widget-backend`) with automated environment variables and database migration hooks.

---

## Part 1: Push the Project to Your Git Account

Follow these steps to push your local repository to your personal Git account (GitHub or GitLab).

### Step 1: Create an Empty Repository on GitHub / GitLab

1. Log in to [GitHub](https://github.com/) (or [GitLab](https://gitlab.com/)).
2. Click **New Repository** (or **New Project**).
3. Name it: `drawing-widget-ios-backend`.
4. Choose **Public** or **Private**.

> [!IMPORTANT]
> **Do NOT check** "Add a README file", ".gitignore", or "license" checkboxes. The repository must be completely empty because you already have these files locally.

5. Click **Create repository** and copy the repository URL (e.g., `https://github.com/<your-username>/drawing-widget-ios-backend.git`).

---

### Step 2: Push Your Local Code to the New Repository

Open your terminal in `/Users/pc/Documents/drawing-widget-ios-backend` (or run in your IDE terminal):

```bash
# 1. Stage and commit the latest files (render.yaml, documentation)
git add .
git commit -m "Initial commit with Render deployment blueprint and guides"

# 2. Point git remote 'origin' to your new repository URL:
git remote set-url origin https://github.com/prathamradadiya90-bit/drawingwidgetbackend.git

# 3. Ensure branch is named 'main'
git branch -M main

# 4. Push code and tags to your repository
git push -u origin main
```

*(If you use SSH instead of HTTPS, use `git remote set-url origin git@github.com:prathamradadiya90-bit/drawingwidgetbackend.git`)*

---

## Part 2: Deploy to Render

Render offers two ways to deploy this backend:
- **Option A (Fastest & Recommended):** 1-Click Blueprint Deployment via `render.yaml`.
- **Option B:** Manual setup via the Render Dashboard.

---

### Option A: 1-Click Blueprint Deployment (Recommended)

1. Log in to your [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** in the top navigation bar and select **Blueprint**.
3. Connect your GitHub or GitLab account if you haven't already, and select your `drawing-widget-ios-backend` repository.
4. Render will detect [`render.yaml`](file:///Users/pc/Documents/Drawingwidgetiosdeploy/render.yaml) and automatically configure:
   - **PostgreSQL Database** named `drawing-widget-db`.
   - **Web Service** named `drawing-widget-backend`.
   - Auto-wiring for `DATABASE_URL`, `DATABASE_SSL=true`, and all environment variables.
5. Click **Apply**. Render will provision the database, install packages, run the SQL schema migrations, and start your server!

---

### Option B: Manual Setup via Render Dashboard

If you prefer configuring the services manually:

#### 1. Create the PostgreSQL Database
1. In Render, click **New +** → **PostgreSQL**.
2. Configure settings:
   - **Name:** `drawing-widget-db`
   - **Database:** `lockscreen_drawing`
   - **User:** `postgres` (or default)
   - **Region:** Select the region closest to you (e.g., Oregon, Frankfurt, or Singapore).
   - **Plan:** Select **Free** (or Starter).
3. Click **Create Database**.
4. Once created, scroll down to the **Connections** section and copy the **Internal Database URL** (e.g., `postgres://user:pass@dpg-...:5432/lockscreen_drawing`).

#### 2. Create the Web Service
1. In Render, click **New +** → **Web Service**.
2. Connect your `drawing-widget-ios-backend` repository.
3. Configure the service settings:
   - **Name:** `drawing-widget-backend`
   - **Region:** Select the *same region* as your database (for low latency).
   - **Branch:** `main`
   - **Root Directory:** *(Leave blank)*
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:**
     ```bash
     npm run db:migrate && npm start
     ```
     > [!TIP]
     > Running `npm run db:migrate && npm start` ensures the SQL tables (`rooms`, `room_members`, `room_strokes`, etc.) are created or updated automatically on every deploy.
   - **Plan:** Select **Free** (or Starter).

#### 3. Add Environment Variables
Under the **Environment** section, add the following variables:

| Key | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production mode |
| `DATABASE_URL` | *(Paste Internal Database URL from Step 1)* | Database connection string |
| `DATABASE_SSL` | `true` | Required for Render PostgreSQL SSL |
| `ROOM_TTL_HOURS` | `24` | Room expiration duration (hours) |
| `ROOM_REAP_INTERVAL_MINUTES` | `60` | Background cleanup interval (minutes) |

> [!NOTE]
> Render automatically injects `PORT` into the environment, which [`src/config/index.js`](file:///Users/pc/Documents/Drawingwidgetiosdeploy/src/config/index.js) reads automatically.

4. Click **Create Web Service**.

---

## Part 3: Verify the Deployment

Watch the build and deploy logs in Render. You should see:

```text
Applying database schema migrations...
Database schema applied successfully.
Server running on http://localhost:10000
Health check available at http://localhost:10000/health
Socket.IO initialized on "/" and "/v1" namespaces
```

Open the health check in your browser:
```text
https://<your-render-service-name>.onrender.com/health
```

You should receive a `200 OK` response:
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-10-26T03:42:00.000Z"
}
```

---

## Part 4: Update Your iOS App / Frontend

In your iOS application or test client, replace the local URLs with your live Render URLs:

- **REST Base URL:**
  - *From:* `http://localhost:3000`
  - *To:* `https://<your-render-service-name>.onrender.com`
- **Socket.IO Endpoint:**
  - *From:* `http://localhost:3000/v1`
  - *To:* `https://<your-render-service-name>.onrender.com/v1` *(Render provides free automated HTTPS / WSS certificates on all `.onrender.com` domains)*

---

## Render Free Tier Notes

- **Web Service Sleep:** On Render's Free tier, Web Services spin down after 15 minutes of inactivity. When a new request arrives, it may take ~50 seconds to wake up (cold start). For production real-time drawing sync, upgrading the Web Service to the Starter plan ($7/mo) keeps it awake 24/7.
- **Free Database Expiry:** Free databases on Render expire 30 days after creation. For a permanent database, use Render's Starter database ($7/mo) or an external managed Postgres provider like Supabase or Neon.
