## World and profile pictures

Product language: **World** is the shared map, **Leaderboard** is the ranked list, **Portfolio** is a player's private trading account.
The route is `/world`; the old `/league` (and `/api/league`) permanently redirect to it. Internal names that still say "league"
(the `LeagueSnapshot` type, trading's `/internal/v1/league`, `toLeagueSnapshot`) are working identifiers and were deliberately not renamed.
"Paper Prediction League" is the product's name and stays.

### Setup

```powershell
cd "C:\Users\<you>\Desktop\Prediction Market Paper"
pnpm install            # adds `sharp` (image processing) to services/api
pnpm db:migrate         # additive: avatar column + Storage bucket + policies. Never resets anything.
pnpm dev
```

Nothing new goes in any `.env` file: the API already has `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and no secret key is used anywhere.
`pnpm db:migrate` creates the `avatars` bucket and its policies on hosted Supabase. To check it in the dashboard: **Storage -> avatars** is
**Public**, limited to 256 KB and `image/webp`; **Storage -> Policies** lists `avatars_insert_own_country`, `avatars_delete_own_country`
and `avatars_select_own_country` on `storage.objects`.

### Two-browser demo

1. Window 1: sign in as player A. Window 2 (a private window): sign in as player B. Both open **World**: equal circles, tied rank 1, your own marked with a dashed ring and a star.
2. A: **Portfolio -> Your country -> Choose a picture**, look at the preview inside the circle, **Save picture**.
3. B (do not reload): within about 5 seconds A's circle shows the picture. B's circle is still its colour. B's pan, zoom and selection did not move.
4. A: **Replace picture**, then **Remove picture**. B sees both changes. A's colour, place on the map, rank and size never change.
5. B: **Find me** centres B's country; type A's name or pick A from the Leaderboard to centre A. Drag to pan, scroll or pinch to zoom, use the + / - / fit / find buttons. **Markets** and **Portfolio** are always in the header.

### How it is built

**Layout is a pure function of the public snapshot** ([`world-layout.ts`](../apps/web/src/lib/world-layout.ts)). A country's anchor comes only from its permanent
slot (a sunflower spiral), so the same country is in the same neighbourhood for everyone and adding countries never moves existing ones. Radius is
`60 * sqrt(areaWeight)`, so circle **area** is proportional to `areaWeight` (twice the Power, twice the area). The scale is absolute (weight 1.00 = the
10,000 starting grant), so one player growing never shrinks anyone else. When a country grows into a neighbour, a bounded deterministic pass pushes
overlapping circles apart (the smaller moves more, nobody drifts far from their anchor). Nothing runs while the map is idle.

**Camera is the viewer's own** ([`camera.ts`](../apps/web/src/lib/camera.ts)): pan, zoom and screen size are never sent anywhere. Until you first move, the camera simply
shows the whole world. A data refresh only replaces the countries.

**Rendering is SVG**, chosen over Canvas or a map library because the expected world is tens to a few hundred players and SVG gives accessible text, native
hit-testing and CSS transitions for free ([`world-map.tsx`](../apps/web/src/components/world-map.tsx)). Each country is drawn once in a unit circle and positioned with a CSS
`translate(...) scale(radius)`, so size and position changes animate smoothly (and simply jump under reduced motion). A picture fills the whole circle, centre-cropped
(`preserveAspectRatio="xMidYMid slice"`), with a thin border in the country's colour; with no picture, or if it fails to load, the colour fills the circle.
Names are drawn at a constant 13 px with a dark outline, so they read over bright and dark pictures; they are hidden inside circles too small to hold them
(your own and the selected country are always labelled), and every country has a tap target of at least 16 px radius.

**One snapshot, one refresh.** The Leaderboard and the map are drawn from the same `GET /v1/world` snapshot, which comes from the same valuation as the Portfolio.
There is no push transport in this app, so the page polls that one endpoint every **5 seconds** while the tab is visible (not one request per country). A refresh
that changed nothing keeps the old state, so React redraws nothing and no picture is reloaded; a picture change updates only that country's `<image>`.

**Public data** per country: `countryId, username, avatarUrl, color, slot, rank, relativeSize, areaWeight`. `areaWeight` is total Power in starting-grant units rounded
to 0.01 (about +-50 Power): coarse by design, never the exact balance. No holdings, orders, fills, ids of accounts or email appear in any public response or in the
refresh payload.

**Pictures** ([`avatar-image.ts`](../services/api/src/avatars/avatar-image.ts), [`avatar-storage.ts`](../services/api/src/avatars/avatar-storage.ts)).
The browser shrinks the picture to a 512 px centre square (fast on a phone). The API does not believe the browser: it decodes the real bytes, accepts only JPEG, PNG
or WebP up to 2 MB (no GIF or SVG), refuses tiny images and decompression bombs, and re-draws a fresh 256x256 WebP. That also strips EXIF (location, camera, timestamps)
and the original file name. It stores the result under `avatars/<country id>/<random uuid>.webp` with **the player's own token**; the database's Storage policies only
allow writes inside the folder of the country the signed-in user owns, and there is no UPDATE policy, so an object is never overwritten. The public address holds a
country id and an unguessable name, never an account id.
Order of a change, which is what keeps the old picture safe: (1) validate and re-encode, (2) store the new object, (3) only then point the profile at it,
(4) only then delete the old object. If step 2 or 3 fails the profile still points at the old picture (and a stored-but-unused new object is deleted). Every picture has a
new name, so browsers and CDNs can never show a stale one. Removing clears the reference first, then deletes the object.

### One complete path: "I save a new picture, and my friend sees it without losing their place"

1. [`AvatarEditor`](../apps/web/src/components/avatar-editor.tsx) `onPick` crops the chosen file to a square with `centerCropSquare`, `save()` uploads it with progress to `/api/profile/avatar`.
2. [`app/api/profile/avatar/route.ts`](../apps/web/app/api/profile/avatar/route.ts) `PUT` reads the session token (server side only) and forwards the bytes to `PUT /v1/me/avatar`.
3. [`services/api create-app.ts`](../services/api/src/create-app.ts): `requireUser` verifies the token; `processAvatar` validates and re-encodes; `fetchAccount` supplies the country id; `uploadAvatarObject` stores `<country>/<uuid>.webp`; `setAvatarKey` switches the reference; `deleteAvatarObject` removes the old file.
4. [`trading-accounts.ts` `setAvatarKey`](../services/trading/src/accounts/trading-accounts.ts) updates only `avatar_key` and returns the previous key; [`create-app.ts`](../services/trading/src/http/create-app.ts) invalidates the cached valuation.
5. The next valuation snapshot ([`toLeagueSnapshot`](../services/trading/src/league/league.ts)) carries the new `avatarKey`; the API turns it into a public `avatarUrl` (`toWorld`); `GET /v1/world` serves it.
6. Your friend's open page polls [`/api/world`](../apps/web/app/api/world/route.ts) within 5 seconds. [`WorldView`](../apps/web/src/components/world-view.tsx) sees one country's data changed, swaps the snapshot, and [`Country`](../apps/web/src/components/world-map.tsx) re-renders that one `<image>`. The camera, selection and every other picture are untouched.

### What is tested how

| What | Where | Data |
|---|---|---|
| Area proportional to weight (areas, not radii), stable anchors, no shuffling, bounded relaxation | `apps/web/src/lib/world-layout.test.ts` | pure fixtures |
| Camera: zoom about a point, centring, resize, limits | `apps/web/src/lib/camera.test.ts` | pure fixtures |
| Image validation, centre crop, EXIF stripped, replace/remove/failure ordering, ownership | `services/api/test/avatar-routes.test.ts` | real images, fake Auth/Storage/trading |
| Area weight rounding (1.06 vs 1.00), public fields | `services/trading/test/money-pricing.test.ts` | pure fixtures |
| Upgrade keeps accounts and grants; avatar reference; the migration's real Storage policies (own folder only, no cross-user write/delete/read, no overwrite) | `services/trading/test/avatars.int.test.ts` | throwaway Postgres with a stand-in `storage`/`auth` schema |
| 10,000 -> 10,600 acceptance numbers | `services/trading/test/paper-trading.int.test.ts` | deterministic fixture quotes |
