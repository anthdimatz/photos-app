# Photos

Your own private photo library that works like Apple Photos: a library grid, a full-screen viewer, slideshows with music, and automatic memory movies you can save to your Camera Roll. Everything runs on Cloudflare's free plan: the website, the server code, and your photo storage. Add it to your iPhone home screen and it opens like an app.

## It stays free

**Storage:** Cloudflare R2 includes 10 GB free each month. Cloudflare asks for a payment card when you turn on R2 and has no spending cap of its own, so the app enforces one: it stops accepting uploads at 9.5 GB, safely under the free 10 GB. When storage is full, the app tells you, and you can delete photos to make room.

**Website and server:** the app's files are served free and without limit. The server part (signing in, loading and uploading photos) runs on Cloudflare Workers, whose free plan allows 100,000 requests a day. Each photo you view or upload counts as one, so a big day of uploading 7,000 photos uses about 15,000. Your phone keeps photos it has already loaded, so you won't re-download them every time you open the app. If you ever reached the daily limit, the app would pause until the next day rather than charge you. Updating the site is free.

**How many photos fit:** the app doesn't store your original files. It saves a 2048-pixel copy of each photo (sharper than an iPhone screen or an HD TV) plus a small thumbnail. Whether an original is 3 MB or 7 MB, it takes up about 0.5 to 0.9 MB in the app, so roughly **10,000 to 15,000 photos** fit in the free space. The Library screen shows how much you've used. Your originals stay untouched on your phone, drive or iCloud.

**Privacy:** photos are only served to someone signed in with your password.

## Setup (about 15 minutes)

### 1. Storage bucket

If you already created the `photos` bucket in Cloudflare R2, skip to step 2.

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) and open **R2 Object Storage**. Follow the prompts to turn on R2.
2. Click **Create bucket**, name it `photos`, and create it. If you choose a different name, open `wrangler.jsonc` and change `"bucket_name": "photos"` to match.

You don't need R2 API tokens or a CORS policy. The app reaches the bucket from inside Cloudflare.

### 2. Put the code on GitHub

1. At [github.com](https://github.com), click **+** → **New repository**, name it `photos-app`, choose **Private**, and create it.
2. Click **uploading an existing file**. Unzip this project and drag everything *inside* the `photos-app` folder onto the page: the `public` folder, `worker.js`, `wrangler.jsonc`, and `README.md`. Click **Commit changes**.

### 3. Create the site on Cloudflare

1. In Cloudflare, open **Workers & Pages** (under **Compute** in the left menu) and click **Create application**.
2. Choose **Import a repository**, connect your GitHub account when asked, and pick `photos-app`.
3. Set the **Project name** to `photos`. It must match the name in `wrangler.jsonc`, or the build fails.
4. Leave the build settings as they are (the deploy command is `npx wrangler deploy`) and click **Deploy**. The first time, Cloudflare may ask you to choose a `workers.dev` subdomain. Any name works.
5. When it finishes, open the Worker, go to **Settings** → **Variables and Secrets**, and click **Add**. Choose type **Secret**, name it `APP_PASSWORD`, enter the password you'll use to sign in, and deploy. Use something long, like four random words.
6. Your site's address appears on the Worker's page, like `https://photos.your-name.workers.dev`. Open it and sign in.

From now on, any change you commit to the GitHub repository updates the site automatically.

### 4. Add it to your iPhone

1. Open your site's address in **Safari** and sign in.
2. Tap **Share** → **Add to Home Screen**.
3. Open Photos from your home screen. It keeps its own sign-in, so enter your password once more there.

## Adding photos

**From iPhone:** tap **+**, choose photos, and tap **Add**. Selecting a few hundred at a time works best. Keep the screen open until the upload finishes. Photos you've already added are skipped, so if an upload stops, select the same photos again and only the missing ones upload.

**From a PC or Mac, including an external drive (best for big batches):** open your site in Chrome, Edge or Safari, click **+**, choose **Choose a folder**, and pick the folder on your drive. You can also drag a whole folder onto the page. The app:

- looks through every subfolder,
- skips videos, hidden system files (like the `._` files Macs leave on drives), and anything else that isn't a photo,
- handles iPhone HEIC files, even in Chrome and Edge on Windows. These take a second or two each, so a large HEIC folder is quicker in Safari on a Mac,
- skips photos already in your library, including ones you uploaded from your iPhone, matched by the exact moment each was taken,
- shows progress, time remaining, and a summary of what it skipped.

Uploading 7,000 photos usually takes one to a few hours, mostly depending on your internet upload speed. Keep the tab open, the drive connected, and the computer awake. If anything interrupts it, choose the same folder again: photos already added are skipped, so it picks up where it stopped.

The app reads each photo's original capture date, so everything sorts correctly no matter when or from where you upload it.

## Using it

- **Library:** pinch the grid to change the size. Tap a photo to open it, swipe sideways to move between photos, and swipe down to close.
- **Slideshow:** the play button in Library plays the whole library shuffled. In Favorites it plays in date order. You can also start one from any photo.
- **Memories:** the app groups photos into days, weekends, trips, "On this day," and years, then picks a spread of up to 20 photos and leaves out burst shots. Favorites get priority. Tap **New memory** for a random one, or select photos and tap **Make movie**.
- **Options** (while playing): choose music (two built-in soundtracks, or a song file from your phone), the shape (wide for TVs, tall for phones), the pace, and **Pick different photos**.
- **Save video:** plays the movie through once while recording, then tap **Save video** and choose **Save Video** to put it in your Camera Roll. Keep the screen on while it records. Videos can be up to 10 minutes long.

## If something goes wrong

- **The build fails with "The name in your Wrangler configuration file must match":** the project name in Cloudflare isn't `photos`. Either rename `"name"` in `wrangler.jsonc` to match your project name, or create the project again named `photos`.
- **"The site needs a password":** add the `APP_PASSWORD` secret (Setup step 3.5).
- **"The site isn't connected to your photo storage":** the bucket name in `wrangler.jsonc` doesn't match your bucket. Fix it in GitHub and Cloudflare redeploys automatically.
- **"Your free storage is full":** the app stopped uploading at 9.5 GB so you're never charged. Delete photos you don't need, then upload again. Photos already in your library are skipped.
- **Some photos "couldn't be added":** the summary names them. They're usually damaged files or a format browsers can't open (camera RAW files like .CR2 or .NEF are skipped). Open one on your computer to check it, or export it as JPEG.
- **Changing the password:** update the `APP_PASSWORD` secret. This signs out every device.

## How it works

`public/` holds the app the browser loads, which Cloudflare serves directly. `worker.js` is a small server that checks the password, serves photos only to signed-in visitors, and saves uploads to your bucket through a direct connection set up in `wrangler.jsonc`, so no storage keys exist to leak. Photo dates and sizes are stored in each file's name, and favorites live in `meta/favorites.json` in the bucket, so no database is needed.
