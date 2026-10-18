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
| `AUDIO_DIR` | `../audio` relative to backend |
| `APK_DIR` | `backend/apk` |
| `VERSION_FILE` | `backend/version.json` |

For local verification, point all directories at a temporary directory and use fake keys. `require('./server')` exports the Express application without listening; callers can use `app.listen(0)` and close the returned server afterward. The chunk cleanup timer does not keep an imported process alive.

## Deployment and client upgrade

Deploy `server.js`, `auth.js`, `json-store.js`, `upload-routes.js`, `package.json`, `package-lock.json`, and both `analytics/dashboard-route.js` and `analytics/moments-analytics.js`. Preserve the existing server's data, uploads, APKs, version configuration, and generated authentication configuration. Run `npm ci --ignore-scripts` if installing into a new directory, then restart the existing `moments-backend` PM2 process. Source changes and authentication configuration must be installed before restart.

The Flutter client must be upgraded with the backend: `POST /api/auth/login` accepts `{ "key": "..." }` and returns `user_id`, a signed `token`, and ISO `expires_at`. Send `Authorization: Bearer <token>` on users, moments, topics, notifications, uploads, and private media requests. Sessions last 30 days. Old clients relying solely on local key comparison cannot access these routes after deployment. `/version`, `/dashboard/stats`, and `/audio-list` retain their existing public behavior.

Public clipboard routes now belong to `../transfer-backend`. Move the existing
`clips` directory there and install the Nginx routing in `../deploy/nginx` to keep
the existing `/api/clips` address. This backend no longer registers clipboard
routes or opens clipboard data.

Authenticated reads can view both partners' diary content. Mutations enforce the signed user's identity. Add and delete comments through their dedicated endpoints; whole-list comment replacement through `PUT /moments/:id` is rejected. `/topics` includes `latest_updated_at` aggregated from its existing posts in one pass. Notification retrieval retains its existing consume-on-read protocol.

## Data files and upload retries

Array data files accept an optional UTF-8 BOM. Missing, unreadable, malformed, or non-array files fail closed with HTTP 503; they are never treated as an empty database. A malformed startup users/moments file prevents startup. Writes use a flushed temporary file in the same directory and an atomic rename, preserving the previous file if saving fails. Deploy `json-store.js` and `upload-routes.js` alongside `server.js`.

Notifications are written after the main record commits. If their separate file cannot be read or saved, the main operation still returns success and the server logs a content-free error; the notification file is preserved for repair. Reading notifications still reports an unavailable file normally and retains the existing consume-on-read protocol.

Upload IDs must contain 1–160 ASCII letters, digits, underscores, or hyphens. Tasks are isolated by the authenticated user; chunk upload, merge, and abort for a task run in sequence. The client must use a new ID after aborting. Completed task metadata retains the image filename for 12 hours so repeated or concurrent merges return the same URL, including after a backend restart. The cleanup job checks every six hours and removes expired task directories; uploaded images themselves are not removed by abort or task expiration. An aborted task retains a small cancellation marker for the same period so a late chunk cannot recreate it. Existing tasks from the old, unscoped layout expire normally; any in-progress upload spanning deployment must restart with a new upload ID.

Images referenced by any persisted diary, avatar, or wallpaper cannot be deleted through `/upload/delete`, including references owned by the caller. Remove a reference from its saved record before deleting that image. This also protects a successfully published image when the client loses the save response and later discards its draft.
