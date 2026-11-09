# Frappe Forward Auth React PWA

A modern, offline-first Progressive Web App built with React, Vite, Workbox, and IndexedDB that integrates with Frappe Framework using modern Forward Auth (`oauth2-proxy` + OIDC / Dex) and reverse proxying (Nginx).

---

## Architecture Overview

```
                      Browser (Desktop / Mobile PWA)
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │         Reverse Proxy (Nginx)        │
               └──────────────────┬───────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
 (PWA Static Shell)        (Auth Subrequest)          (Frappe Backend)
        │                         │                         │
        ▼                         ▼                         ▼
 ┌──────────────┐         ┌──────────────┐          ┌──────────────┐
 │  React PWA   │         │ oauth2-proxy │          │ Frappe Bench │
 │ (Vite / PWA) │         │    (OIDC)    │          │  (Port 8000) │
 └──────────────┘         └───────┬──────┘          └──────────────┘
                                  │
                                  ▼
                            ┌───────────┐
                            │  Dex IdP  │
                            │  (:5556)  │
                            └───────────┘
```

---

## 1. Local Development (DevContainer)

### Prerequisites & Components
All services are pre-configured in `.devcontainer/docker-compose.yml`:
- **Nginx Reverse Proxy**: Port `8080`
- **Dex OIDC Provider**: Port `5556` (Issuer: `http://dex.localhost:5556/dex`)
- **OAuth2 Proxy**: Port `4180`
- **Frappe Bench**: Port `8000`
- **React PWA Vite Dev Server**: Port `5173`

### Running the Services

1. **Start Bench & PWA Dev Server**:
   Inside the Frappe container or via bench:
   ```bash
   cd /workspace/development/frappe-bench
   bench start
   ```
   *(The `Procfile` already includes `pwa: pnpm --dir ../pwa run dev` to serve Vite on `0.0.0.0:5173`)*.

2. **Accessing the PWA**:
   Navigate to **`http://localhost:8080`** in your browser.
   - Nginx handles routing transparently:
     - `/` loads the React PWA from Vite (`frappe:5173`).
     - `/api/` and `/app/` route to Frappe with forward-auth subrequests.
     - `/oauth2/` connects to `oauth2-proxy`.

3. **Logging in via Dex**:
   Click **"Sign In via Dex"** on the PWA interface. Dex includes mock development credentials:
   - **Email**: `sso-admin@example.org` (or `caseworker@example.org`)
   - **Password**: `password`

4. **Offline Testing**:
   - Open Chrome DevTools ➔ **Network** tab ➔ Toggle **Offline**.
   - Note creation continues working seamlessly via IndexedDB (`frappeDB`).
   - Switch back to **Online**: notes are automatically pushed to Frappe's `Note` DocType via the mutation queue.

---

## 2. Reverse Proxy & Forward Auth Details

### How Nginx & Forward Auth Work
Nginx uses the `auth_request` module:

```nginx
# 1. Forward-Auth OAuth2 endpoint
location /oauth2/ {
    proxy_pass       http://oauth2-proxy:4180;
    proxy_set_header Host                    $http_host;
    proxy_set_header X-Real-IP               $remote_addr;
    proxy_set_header X-Scheme                $scheme;
    proxy_set_header X-Auth-Request-Redirect $request_uri;
}

# 2. Auth subrequest check
location = /oauth2/auth {
    internal;
    proxy_pass       http://oauth2-proxy:4180;
    proxy_set_header Host             $http_host;
    proxy_set_header X-Real-IP        $remote_addr;
    proxy_set_header X-Scheme         $scheme;
    proxy_set_header Content-Length   "";
    proxy_pass_request_body           off;
}

# 3. Protected Frappe API
location ~ ^/(api|app)/ {
    auth_request /oauth2/auth;
    error_page 401 = @handle_401;

    auth_request_set $user   $upstream_http_x_auth_request_user;
    auth_request_set $email  $upstream_http_x_auth_request_email;
    auth_request_set $token  $upstream_http_authorization;

    proxy_pass http://frappe:8000;

    proxy_set_header X-Forwarded-User           $user;
    proxy_set_header X-Forwarded-Email          $email;
    proxy_set_header X-Auth-Request-Email       $email;
    proxy_set_header X-Auth-Request-User        $user;
    proxy_set_header X-Upstream-Authorization   $token;
}
```

> **Note on Authorization Header**: Upstream bearer tokens are forwarded as `X-Upstream-Authorization` rather than `Authorization`. When Frappe receives an `Authorization: Bearer <token>` header, its internal authentication layer (`apps/frappe/frappe/auth.py`) attempts to validate the bearer token against Frappe's own OAuth Bearer / API token table and throws `AuthenticationError`. Passing it as `X-Upstream-Authorization` avoids collisions while making the upstream token available to custom backend apps.

### Frappe Site Configuration (`site_config.json`)

Configure your site in `development/frappe-bench/sites/<site_name>/site_config.json`:

```json
{
  "installed_apps": [
    "frappe",
    "vouch_frappe_auth"
  ],
  "vouch_jwt_enabled": 1,
  "forward_auth_mode": "auto",
  "forward_auth_trusted_proxies": [
    "127.0.0.1",
    "::1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ],
  "allowed_referrers": [
    "http://localhost:8080",
    "http://127.0.0.1:8080"
  ],
  "vouch_create_user": 1,
  "forward_auth_jwks_url": "http://dex:5556/dex/keys"
}
```

---

## 3. Production Deployment Guide

### Step 1: Build the React PWA Static Assets
Run the build inside the PWA directory using `pnpm`:
```bash
cd pwa
pnpm install --frozen-lockfile
pnpm run build
```
This outputs static production assets to `pwa/dist` (including `sw.js`, `manifest.webmanifest`, pre-cached JS/CSS chunks).

### Step 2: Deploy Production Nginx Configuration
In production, serve the built static PWA files directly from disk (`/var/www/pwa/dist`) while proxying Frappe and OAuth2 Proxy:

```nginx
server {
    listen 443 ssl http2;
    server_name pwa.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/pwa.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pwa.yourdomain.com/privkey.pem;

    client_max_body_size 50m;

    # Root pointing to PWA build output
    root /var/www/pwa/dist;
    index index.html;

    # 1. OAuth2 Proxy forward-auth endpoints
    location /oauth2/ {
        proxy_pass       http://127.0.0.1:4180;
        proxy_set_header Host                    $host;
        proxy_set_header X-Real-IP               $remote_addr;
        proxy_set_header X-Scheme                $scheme;
        proxy_set_header X-Auth-Request-Redirect $request_uri;
    }

    location = /oauth2/auth {
        internal;
        proxy_pass       http://127.0.0.1:4180;
        proxy_set_header Host             $host;
        proxy_set_header X-Real-IP        $remote_addr;
        proxy_set_header X-Scheme         $scheme;
        proxy_set_header Content-Length   "";
        proxy_pass_request_body           off;
    }

    # 2. Frappe assets & static files
    location /assets/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
    }

    # 3. Protected Frappe API endpoints
    location ~ ^/(api|app)/ {
        auth_request /oauth2/auth;
        error_page 401 = /oauth2/start?rd=$scheme://$http_host$request_uri;

        auth_request_set $user  $upstream_http_x_auth_request_user;
        auth_request_set $email $upstream_http_x_auth_request_email;

        proxy_pass http://127.0.0.1:8000;

        proxy_set_header X-Forwarded-User  $user;
        proxy_set_header X-Forwarded-Email $email;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 4. React PWA SPA routing & offline fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Service worker & webmanifest caching policy
    location ~* (sw\.js|manifest\.webmanifest)$ {
        add_header Cache-Control "no-cache";
        expires 0;
    }
}
```

### Step 3: Production OAuth2-Proxy Configuration
Create `/etc/oauth2-proxy.cfg` or configure container environment variables:

```ini
http_address = "127.0.0.1:4180"
upstreams = ["http://127.0.0.1:8000/"]
reverse_proxy = true

## Provider settings (Dex, Keycloak, Okta, Google, etc.)
provider = "oidc"
oidc_issuer_url = "https://dex.yourdomain.com/dex"
client_id = "frappe-pwa-client"
client_secret = "your_strong_client_secret"

## Cookie settings
cookie_secret = "32_byte_random_cookie_secret_key!!"
cookie_secure = true
cookie_domains = [".yourdomain.com"]
whitelist_domains = ["pwa.yourdomain.com"]
email_domains = ["*"]

## Header forwarding
set_xauthrequest = true
pass_access_token = true
set_authorization_header = true
pass_authorization_header = true
```

---

## 4. Client-side Generic Database (`frappeDB`)

The PWA comes equipped with `src/db.js` providing a generic offline document cache and outbox sync engine:

```javascript
import { frappeDB } from './db.js';

// 1. Insert any DocType locally (works offline)
await frappeDB.insert('Note', {
  title: 'My offline note',
  content: 'Captured in the field without internet',
});

// 2. Query locally cached documents
const notes = await frappeDB.getList('Note', {
  filters: { public: 0 },
  orderBy: 'modified',
  orderDir: 'desc'
});

// 3. Sync pending mutations with Frappe
const { synced, errors } = await frappeDB.sync();

// 4. Preload & cache list from server
await frappeDB.fetchAndCacheList('Note', ['name', 'title', 'content']);
```
