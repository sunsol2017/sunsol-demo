# Copilot instructions — sunsol-demo

Purpose: give an AI coding agent the minimal, actionable context to be productive in this repo.

- **Big picture**: This is a small Next.js 16 app-router demo app (client-heavy) implementing an OCR-based solar-consumption estimator. The main UI/logic lives in `app/page.tsx` which performs image cropping, bar detection and OCR (via `tesseract.js`) entirely in the browser — there is no backend/API in the repo.

- **Entry points & important files**
  - `app/page.tsx` — primary app UI and OCR pipeline (image handling, ROI generation, `createTesseractWorker`, parsing logic). See the dynamic import + worker handling near the top of the file.
  - `app/layout.tsx` — root layout for the app.
  - `components/ui/*` — reusable UI primitives built with Radix, CVA, and Tailwind. Example: `components/ui/button.tsx` exports both `Button` and `buttonVariants` (use `buttonVariants` when adding new styles).
  - `lib/utils.ts` — small helpers; `cn()` wraps `clsx` + `tailwind-merge` (use this for composing class strings).
  - `package.json` — scripts: `npm run dev`, `npm run build`, `npm run start`, `npm run lint`.

- **Architecture & data flow (concise)**
  1. User provides an image in the page UI (`app/page.tsx`).
  2. The code crops the image to the chart area and computes label ROIs.
  3. ROIs are fed to a dynamically imported `tesseract.js` worker (`createTesseractWorker`) and parsed (`parseDigitsOnly`).
  4. Parsed numeric values are reduced into `parsed` state and presented in the UI; manual overrides are supported.

- **Project-specific patterns & conventions**
  - UI components follow a variant-driven pattern via `class-variance-authority` (`cva`). When adding a new variant, follow the pattern used in `components/ui/button.tsx` and export both the React component and the variant object.
  - Use `cn(...)` from `lib/utils.ts` to combine Tailwind classes; this repo relies on `tailwind-merge` to dedupe conflicting classes.
  - Client components explicitly opt into client-side behavior with the `"use client"` directive (see `app/page.tsx`). Assume heavy image/DOM usage will be client components.
  - Dynamic import defensive handling: `tesseract.js` is imported with `const mod = await import('tesseract.js')` and the code supports either `mod.createWorker` or `mod.default.createWorker`. Preserve that compatibility when editing OCR code.

- **Build / run / debug**
  - Start dev server: `npm run dev` (Next dev server on http://localhost:3000).
  - Build for production: `npm run build` then `npm run start`.
  - Lint: `npm run lint` (ESLint with `eslint-config-next`).
  - To reproduce OCR behavior locally: use the dev server and open the page; test with representative LUMA bill images. The OCR flow logs progress to console via the `logger` passed to `createWorker`.

- **Third-party integrations and versions**
  - Next.js 16, React 19 (do not bump without checking compatibility).
  - `tesseract.js` is used client-side for OCR; the code sets `tessedit_char_whitelist` and page segmentation parameters — keep those settings unless testing indicates improvement.
  - UI libs: Radix UI primitives, `class-variance-authority`, `clsx`, `tailwind-merge`.

- **When modifying code**
  - For UI changes: add styles via `cva` variants and use `cn()` for composition; update exported variant objects where present.
  - For OCR changes: respect existing defensive handling of `tesseract.js` module shapes and parameter setting sequence (`load` → `loadLanguage` → `initialize` / `reinitialize`). Example helper: `createTesseractWorker` in `app/page.tsx`.
  - Keep changes minimal and focused; this is a small demo — avoid introducing server-side routes unless the feature explicitly requires it.

- **Files to inspect for context/examples**
  - [app/page.tsx](app/page.tsx)
  - [app/layout.tsx](app/layout.tsx)
  - [components/ui/button.tsx](components/ui/button.tsx)
  - [lib/utils.ts](lib/utils.ts)
  - [package.json](package.json)

If anything here is unclear or you want more detail about a particular area (OCR pipeline, CVA variants, or deployment), tell me which part to expand and I will iterate. 

- **Troubleshooting & Windows notes**
  - PowerShell `npm` scripts may be blocked by execution policy on Windows. If `npm run lint` fails with a PowerShell script error, run the command in CMD/Git Bash or relax the policy for the current user:

    ```powershell
    Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
    npm run lint
    ```

  - Alternative dev start (used when PowerShell npm wrapper is blocked):

    ```bash
    node ./node_modules/next/dist/bin/next dev
    ```

  - Next dev can warn about multiple lockfiles (turbopack root detection). This is a harmless warning; set `turbopack.root` in `next.config.ts` or remove the extra lockfile to silence it.

  - OCR/runtime logs: `tesseract.js` progress messages are emitted via the `logger` passed to the worker and appear in the browser DevTools console during image processing. To reproduce OCR behavior and see logs:
    - Start dev server: `npm run dev` (or the `node` fallback above).
    - Open http://localhost:3000, upload a sample LUMA bill (page 4) in the UI.
    - Open browser DevTools Console to observe `tesseract.js` progress and any recognition errors.

