# QuizArena

A real-time classroom quiz app with a student landing page, admin dashboard, PIN rooms, timed multiple-choice questions, scoring, answer review, and leaderboard.

## Project structure

Keep this folder structure exactly as shown. In particular, the web pages and assets belong inside `public/`.

- `server.js` — server and API
- `package.json` — dependencies and start command
- `public/index.html` — student page
- `public/app.js` — student-side logic
- `public/admin.html` — admin page
- `public/admin.js` — admin-side logic
- `public/styles.css` — styles
- `render.yaml` — Render deployment settings
- `.env.example` — example local environment variables only

## Run locally on Windows

1. Extract the ZIP.
2. Open the `QuizArena` folder in VS Code. It must be the folder containing `package.json` and `server.js`.
3. Open **Terminal → New Terminal**. If PowerShell blocks `npm.ps1`, choose Command Prompt (CMD) as the terminal profile.
4. Run:

   ```bat
   npm install
   npm start
   ```

5. Open `http://localhost:3000` for students or `http://localhost:3000/admin` for the admin dashboard.

You can also double-click `start.bat`. Keep the terminal window open while using the app.

## Deploy to Render without installing Git

1. Create a GitHub repository in your browser.
2. Extract this ZIP and upload the **contents of the `QuizArena` folder** to the repository root. Keep the `public` folder intact. Do not upload the outer `QuizArena_Final` folder as an extra nesting level.
3. Do not upload `node_modules`, `.env`, `quizarena.db`, or secrets.
4. In Render, choose **New + → Web Service**, connect the GitHub repository, and use:
   - Build command: `npm install`
   - Start command: `npm start`
5. In the Render environment settings, set:
   - `ADMIN_EMAIL` — your chosen admin email
   - `ADMIN_PASSWORD` — a strong, unique password
   - `SESSION_SECRET` — a long, random secret (Render's `render.yaml` can generate one if you create the service from the Blueprint)
6. Deploy. Your student URL will be your Render service URL; the admin page is the same URL followed by `/admin`.

## Important deployment notes

- Use a currently supported Node.js release that supports the built-in `node:sqlite` module. Node.js 22.13.0 is specified in `render.yaml`.
- The app stores data in `quizarena.db` in the project directory. A standard Render free web service has an ephemeral filesystem, so data can be lost when the service restarts or redeploys. Do not use it for a high-stakes competition until you have configured persistent storage or moved the database to a persistent database service.
- Set strong admin credentials and a unique session secret before sharing the site publicly.
- This is a classroom/demo starter. Some optional features from the original brief, such as a full question bank and advanced analytics, are not implemented.

## Demo credentials for local testing only

- Email: `admin@quizarena.local`
- Password: `ChangeMe123!`

These are defaults for local testing. Set your own credentials before public deployment.
