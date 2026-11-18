# Encore

A camera for live music. Every photo remembers:

- **the song** that was playing (identified from a short live recording)
- **the sound** itself, a 6–15 second clip you can replay
- **where you were**, the venue name from your location
- **the night**, with photos grouped automatically into events and a setlist
- **something interesting**: facts about the artist, the place, and music history on that date (especially useful when no song was playing)

Everything is stored on your phone only.

## Put it on your iPhone

1. **Host it on GitHub Pages (once):** on GitHub open this repo → **Settings → Pages** → Source: *Deploy from a branch* → pick this branch and `/ (root)` → Save. After a minute your app will be at
   `https://<your-github-username>.github.io/OMcashbacktool/encore/`
2. Open that link in **Safari** on your iPhone.
3. Tap **Share → Add to Home Screen**. Open Encore from the home screen icon.
4. Tap **Open camera** and allow camera, microphone and location.

## Turn on song recognition

1. Go to **audd.io**, sign up and open your dashboard. Copy your **API token**.
2. In Encore tap the **⚙︎** (top right) → paste it into **Song recognition key** → Save.

The key stays on your phone and is only sent to AudD.

### If recognition says "blocked"
Some browsers refuse direct calls to AudD. The fix is a free relay:
1. Sign up at **dash.cloudflare.com** → *Workers & Pages* → *Create* → *Hello World* worker.
2. Replace its code with `relay/worker.js` from this folder → **Deploy**.
3. Copy the worker address (`https://….workers.dev`) into Encore → Settings → **Relay address**.

## How it works

| Piece | Service | Cost |
|---|---|---|
| Song recognition + streaming links | AudD (returns Apple Music, Spotify, Deezer and a song.link "all platforms" page) | Free trial, then pay per use |
| Venue name | OpenStreetMap (Overpass + Nominatim) | Free |
| Facts | Wikipedia (nearby places, artist bio, "on this day") | Free |
| Nights | Built in: photos within 4 hours and 600 m of each other belong to the same night. Named after the artist if they appear twice or more, otherwise after the venue. Tap the name to rename it. | — |

Offline? Photos and sound still save, and the rest fills in automatically once you're back online.

## Known limits (first version)

- Photos come from the live camera feed, so they're lower resolution than the built-in Camera app. A native iPhone app would fix this.
- Live music with heavy crowd noise is harder to recognise than recordings. Use 15-second clips at loud gigs.
- iOS may ask for camera and mic permission again after a while. That's Safari's rule for home-screen apps.

## Next ideas

- Automatic event lookup (match the artists you heard to their tour dates near you)
- "Playlist of the night" export
- Map of every gig you've been to
- Year-in-review
