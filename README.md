# SpeakEasy AI

AI-powered local interview assistant built for Windows desktop use.

## Development

```bash
npm install
npm run build
npm run dev
```

## Run

```bash
npm start
```

## Build

```bash
npm run build
```

## Windows Installer

```bash
npm run dist:win
```

This generates a Windows installer in the output folder, typically:

```text
release\SpeakEasy-AI-Setup-1.0.0.exe
```

## Data Location

This application stores persistent user data in:

```text
C:\SpeakEasy AI\
```

Required folders are created automatically:

```text
C:\SpeakEasy AI\KBD
C:\SpeakEasy AI\JD
C:\SpeakEasy AI\Resume
C:\SpeakEasy AI\Sessions
```

Additional runtime logs are stored at:

```text
C:\SpeakEasy AI\Logs
```

## Notes

- The application binaries can be installed under Program Files or AppData.
- User data remains under `C:\SpeakEasy AI\` and is preserved during updates and uninstall unless the user explicitly removes it.
- Sensitive credentials should be provided as environment variables or through secure local configuration, never embedded directly in the frontend.
