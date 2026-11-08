# 🍔 QuickBite Express — Full-Stack Online Food Ordering System

A complete full-stack web application with connected Frontend, Backend, and persistent Database. Features interactive menu browsing, item customizations, promo coupons, live multi-stage order tracking, kitchen admin order status controls, and **external links accessible on any other phone, tablet, or computer globally**.

---

## 🛡️ Why "Failed to Fetch" Happened in the Past & How It Is Solved

In previous deployments, you likely saw `Failed to fetch` due to three common issues:
1. **Mixed Content Block**: A public site running over `https://` trying to call hardcoded `http://localhost:5000` or `http://192.168.x.x`. The browser instantly blocks this as insecure content.
2. **Hardcoded Hostnames**: Fixed IP or port numbers that do not match the public deployment domain.
3. **CORS & Proxy Header Stripping**: Reverse proxies (Cloudflare, Render, Localtunnel) drop or misroute requests if the server does not handle `x-forwarded-proto` and preflight `OPTIONS` requests.

### 🔒 Our Complete Fix:
- **Zero Hardcoded URLs**: All API calls use relative paths (`/api/...`), so they automatically adapt to whatever protocol (`http://` or `https://`) and domain is serving the page.
- **Dynamic Origin Detection**: [`server.js`](server/server.js) reads `x-forwarded-proto` and `x-forwarded-host` to automatically generate correct shareable tracking URLs whether running locally or on a public domain.
- **Resilient API Fetch**: [`app.js`](server/public/app.js) includes an `apiFetch()` wrapper with automatic retry and error handling.
- **Universal CORS Support**: Accepts requests with all methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) and preflights with HTTP 204.

---

## 🌐 How to Deploy to the Outside (2 Easy Options)

### Option 1: Instant Public HTTPS URL (From Your PC)
To share a live public link right now without creating cloud accounts:
1. Make sure your server is running (`start.bat`).
2. Double-click [`start-public-tunnel.bat`](start-public-tunnel.bat) (or run `npx --yes localtunnel --port 5000` in terminal).
3. It will give you a public URL like:
   ```
   https://quickbite-order.loca.lt
   ```
4. Anyone in the world on their phone (even on mobile 4G/5G data) can open that URL to browse dishes, place orders, and track them in real time!

---

### Option 2: 1-Click Cloud Deployment (24/7 Free Hosting on Render / Railway)

To deploy to a cloud server that stays online 24/7 even when your PC is turned off:

#### Deploy to Render.com (Recommended - Free):
1. Create a free account at [render.com](https://render.com).
2. Push this folder to a GitHub repository:
   ```bash
   cd C:\Users\emani\Downloads\food-order-system
   git init
   git add .
   git commit -m "Prepare QuickBite for deployment"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
3. On Render, click **"New +" ➔ "Blueprint"** and connect your GitHub repo.
4. Render will read [`render.yaml`](render.yaml). Set `ADMIN_PASSWORD` to a unique password of at least 16 characters when prompted; this protects the restaurant portal and order-management APIs.
   - **Environment**: Node
   - **Build Command**: *(leave blank)*
   - **Start Command**: `node server/server.js`
5. Click **"Deploy Web Service"**!
6. Render gives you an official live public URL (e.g. `https://quickbite-food.onrender.com`).

**Important:** The current JSON database is stored on the server's local filesystem. Render's free service does not provide persistent disks, so orders/menu edits can be lost when the service restarts or redeploys. Use a persistent database or paid persistent storage before relying on this for real orders. Payments in this demo are simulated.

The public tracking page only returns order progress and item summaries. Full order details, order administration, and menu changes require signing into **Kitchen / Admin** with `ADMIN_PASSWORD`.

---

## 💻 Local Testing & Running

- **Start Local Server**: Double-click [`start.bat`](start.bat) or run `node server/server.js`.
- **Local Browser**: [http://localhost:5000](http://localhost:5000)
- **Local Wi-Fi Network**: `http://10.159.150.22:5000`
- **Sample Live Tracker**: `http://localhost:5000/?track=ORD-5401`
