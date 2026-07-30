# Packaging & signing the Sovereign Browser

This directory builds distributable installers for macOS, Windows and Linux with
[electron-builder](https://www.electron.build). The config lives in `package.json`
under `"build"`; the release pipeline is `.github/workflows/release.yml`.

## The honest wall

**Trusted code-signing requires certificates that are yours to hold and pay for.**
Nobody can sign on your behalf without them, and this repo will never fabricate a
signature. Concretely you need:

| Platform | What you need | Roughly |
|----------|---------------|---------|
| **macOS** | An Apple **Developer ID Application** certificate (Apple Developer Program) + notarization | £79/yr Apple Developer |
| **Windows** | An **Authenticode** OV/EV code-signing certificate from a CA (DigiCert, Sectigo, …) or **Azure Trusted Signing** | ~£150–400/yr |
| **Linux** | Nothing required (AppImage/deb ship unsigned; optionally GPG-sign) | free |

Until those exist, the pipeline still builds **unsigned** installers — perfectly
fine for testing that packaging works, and for Linux — they just show an OS warning
on macOS/Windows. That is the honest state: the *machinery* is done; the *trust*
is a certificate you plug in.

## Build locally

```bash
cd desktop
npm install
npm run pack          # unpacked app in dist/ (fastest smoke of the build)
npm run dist          # installers for the current OS, in dist/
```

`npm run dist:mac` / `dist:win` / `dist:linux` target one platform. macOS installers
must be built on macOS; Windows on Windows (or via the CI matrix below).

## Sign via CI (recommended)

Push a tag and the release workflow builds all three platforms on their native
runners, signs with your secrets, notarizes macOS, and uploads to a GitHub Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Set these **repository secrets** (Settings → Secrets and variables → Actions).
All are optional — a missing one just yields an unsigned build for that platform:

| Secret | For | How to get it |
|--------|-----|----------------|
| `MAC_CSC_LINK` | macOS | base64 of your Developer-ID `.p12` (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | macOS | the `.p12` export password |
| `APPLE_ID` | macOS notarize | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarize | an app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | macOS notarize | your 10-char Apple Team ID |
| `WIN_CSC_LINK` | Windows | base64 of your Authenticode `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | Windows | the `.pfx` password |

> Set these yourself in the GitHub UI. Never paste a certificate or password into
> a file, a commit, or a chat — signing material is a credential.

## Windows self-signed DEV certificate (prove the pipeline today)

You can produce a *signed-but-dev-trust* Windows build with no CA, to verify signing
end-to-end. This is **for testing only** — Windows SmartScreen still warns because
the cert isn't from a trusted CA. Do not distribute it as if it were.

```powershell
# create a throwaway self-signed code-signing cert and export it
$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Sovereign Dev" -CertStoreLocation Cert:\CurrentUser\My
$pw = ConvertTo-SecureString -String "devpass" -Force -AsPlainText
Export-PfxCertificate -Cert $c -FilePath dev-cert.pfx -Password $pw
# then build with it (dev only!)
$env:WIN_CSC_LINK = "dev-cert.pfx"; $env:WIN_CSC_KEY_PASSWORD = "devpass"
npm run dist:win
```

## The app icon

`build/icon.png` (1024²) is generated reproducibly by `npm run icon` (a pure-JS
renderer + PNG encoder, no image libraries). electron-builder derives the platform
`.ico`/`.icns` from it.
