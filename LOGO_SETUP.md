# Logo Setup Instructions

To use your logo in the application:

## Step 1: Add the Logo Image

1. **For the header logo**: 
   - Save your logo as `logo.png` in the `renderer/` directory
   - Recommended size: 32x32px to 64x64px
   - Format: PNG with transparency support

2. **For the app icon**:
   - Save your icon as `icon.png` in the `assets/` directory  
   - Recommended size: 512x512px (minimum 256x256px)
   - Format: PNG
   - Electron-builder will automatically convert this to platform-specific formats (.icns for macOS, .ico for Windows)

## Step 2: File Locations

```
CleverPrintingAgent/
├── assets/
│   └── icon.png          ← App icon (512x512px)
└── renderer/
    └── logo.png          ← Header logo (32-64px)
```

## Step 3: Verify

After adding the files:
- The logo will appear in the header next to "Clever Printing Agent"
- The app icon will be used in the dock/taskbar and window title bar
- When building, the icon will be included in the installer

## Notes

- If the logo doesn't appear, check the browser console (DevTools) for any loading errors
- Make sure the file names match exactly: `logo.png` and `icon.png`
- The logo should have a transparent background for best appearance

