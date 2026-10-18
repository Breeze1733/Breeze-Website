# Diptych backend

Run `npm ci --ignore-scripts`, prepare the private authentication configuration, then run `npm start`. Startup refuses missing or invalid authentication configuration. Existing diary data is not used to generate credentials.

## Private authentication configuration

`auth.js` exports `async createAuthConfig({ A: keyA, B: keyB })`. Deployment tooling should obtain the current user keys from private input, call this function, and write the returned JSON with file mode `0600`. Do not put raw keys in command arguments, source control, logs, or this directory's public web root.

The generated shape is:

```json
{
  "version": 1,
  "signing_key": "32 random bytes encoded as 64 hex characters",
  "users": {
    "A": { "salt": "16 random bytes as hex", "hash": "64 scrypt output bytes as hex" },
    "B": { "salt": "16 random bytes as hex", "hash": "64 scrypt output bytes as hex" }
  }
}
```

Keep the generated file outside source control and deny direct web access to the backend source and data directories. The default location is `data/auth.json`; `AUTH_CONFIG_FILE` can point elsewhere. Linux requires mode `0600`. Replacing a user's salt/hash immediately revokes that user's existing sessions. Replacing `signing_key` revokes all sessions. The server rereads this small configuration on requests; no restart is needed for credential rotation.

## Configuration and isolated startup

| Environment variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `DATA_DIR` | `backend/data` |
| `AUTH_CONFIG_FILE` | `${DATA_DIR}/auth.json` |
| `UPLOADS_DIR` | `backend/uploads` |
| `CHUNKS_DIR` | `backend/chunks_temp` |
| `CLIPS_DIR` | `backend/clips` |
| `AUDIO_DIR` | `../audio` relative to backend |
| `APK_DIR` | `backend/apk` |
| `VERSION_FILE` | `backend/version.json` |

For local verification, point all directories at a temporary directory and use fake keys. `require('./server')` exports the Express application without listening; callers can use `app.listen(0)` and close the returned server afterward. The chunk cleanup timer does not keep an imported process alive.

## Deployment and client upgrade

Deploy `server.js`, `auth.js`, `package.json`, `package-lock.json`, and both `analytics/dashboard-route.js` and `analytics/moments-analytics.js`. Preserve the existing server's data, uploads, clips, APKs, version configuration, and generated authentication configuration. Run `npm ci --ignore-scripts` if installing into a new directory, then restart the existing `moments-backend` PM2 process. Source changes and authentication configuration must be installed before restart.

The Flutter client must be upgraded with the backend: `POST /api/auth/login` accepts `{ "key": "..." }` and returns `user_id`, a signed `token`, and ISO `expires_at`. Send `Authorization: Bearer <token>` on users, moments, topics, notifications, uploads, and private media requests. Sessions last 30 days. Old clients relying solely on local key comparison cannot access these routes after deployment. `/version`, `/dashboard/stats`, `/clips`, and `/audio-list` retain their existing public behavior.

Authenticated reads can view both partners' diary content. Mutations enforce the signed user's identity. Add and delete comments through their dedicated endpoints; whole-list comment replacement through `PUT /moments/:id` is rejected. `/topics` includes `latest_updated_at` aggregated from its existing posts in one pass. Notification retrieval retains its existing consume-on-read protocol.
